import { spawn } from "node:child_process";
import path from "node:path";
import type {
  AgentRequest,
  AgentResponse,
  AvatarCommand,
  ChatMode,
  DiscoveredPlugin,
  SkillTable,
} from "../types.js";
import type { MarketplaceRegistry } from "../marketplace.js";

const MUTATING_PATTERNS = [
  /재시작/i,
  /재배포/i,
  /삭제/i,
  /변경/i,
  /생성/i,
  /전송/i,
  /권한/i,
  /restart/i,
  /reboot/i,
  /redeploy/i,
  /deploy/i,
  /delete/i,
  /remove/i,
  /write/i,
  /create/i,
  /update/i,
  /send/i,
  /permission/i,
];

export function isMutatingRequest(message: string): boolean {
  return MUTATING_PATTERNS.some((pattern) => pattern.test(message));
}

function commandAllowed(command: AvatarCommand, mode: ChatMode): boolean {
  if (mode === "colleague") {
    return command.readOnly && (command.mode === "colleague" || command.mode === "both");
  }
  return command.mode === "owner" || command.mode === "both" || command.mode === "colleague";
}

function scoreCommand(command: AvatarCommand, message: string): number {
  const normalized = message.toLowerCase();
  const terms = command.match ?? [];
  return terms.reduce((score, term) => {
    return normalized.includes(term.toLowerCase()) ? score + 1 : score;
  }, 0);
}

function selectCommand(
  registry: MarketplaceRegistry,
  request: AgentRequest,
): { plugin: DiscoveredPlugin; command: AvatarCommand } | null {
  const candidates = registry.plugins.flatMap((plugin) =>
    plugin.commands
      .filter((command) => commandAllowed(command, request.mode))
      .map((command) => ({ plugin, command, score: scoreCommand(command, request.message) })),
  );
  const matched = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0];
  if (matched) {
    return { plugin: matched.plugin, command: matched.command };
  }
  const fallback = candidates[0];
  return fallback ? { plugin: fallback.plugin, command: fallback.command } : null;
}

function isSkillTable(value: unknown): value is SkillTable {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as SkillTable;
  return Array.isArray(candidate.columns) && Array.isArray(candidate.rows);
}

async function executeCommand(
  plugin: DiscoveredPlugin,
  command: AvatarCommand,
  request: AgentRequest,
): Promise<{ stdout: string; stderr: string }> {
  const cwd = plugin.rootPath;
  const executable = command.command;
  const args = command.args ?? [];
  const timeoutMs = command.timeoutMs ?? 20_000;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        AVATAR_CHAT_QUERY: request.message,
        AVATAR_CHAT_MODE: request.mode,
        AVATAR_CHAT_PROJECT_SCOPE: request.user.projectScope,
        AVATAR_CHAT_USER: request.user.name,
      },
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command.name} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command.name} exited with code ${code}: ${stderr}`));
    });
  });
}

function formatAvailableSkills(registry: MarketplaceRegistry, mode: ChatMode): string {
  const lines = registry.plugins.flatMap((plugin) =>
    plugin.commands
      .filter((command) => commandAllowed(command, mode))
      .map((command) => `- ${plugin.name}:${command.name} - ${command.description}`),
  );
  return lines.length
    ? `요청에 맞는 skill을 고르지 못했습니다. 사용 가능한 skill:\n${lines.join("\n")}`
    : "현재 모드에서 사용할 수 있는 skill이 없습니다.";
}

export async function runLocalAgent(
  request: AgentRequest,
  registry: MarketplaceRegistry,
): Promise<AgentResponse> {
  if (request.mode === "colleague" && isMutatingRequest(request.message)) {
    return {
      kind: "text",
      runtime: "blocked",
      summary: "동료 모드는 읽기 전용입니다.",
      text: "이 요청은 재시작, 재배포, 삭제, 생성, 권한 변경 등 변경 작업으로 해석될 수 있어 차단했습니다. 소유자 모드에서 직접 지시해 주세요.",
    };
  }

  const selected = selectCommand(registry, request);
  if (!selected) {
    return {
      kind: "text",
      runtime: "local",
      summary: "실행 가능한 skill이 없습니다.",
      text: formatAvailableSkills(registry, request.mode),
    };
  }

  const { plugin, command } = selected;
  if (request.mode === "colleague" && command.projectScoped !== true) {
    return {
      kind: "text",
      runtime: "blocked",
      pluginName: plugin.name,
      skillName: command.name,
      summary: "프로젝트 범위가 선언되지 않은 skill은 동료 모드에서 사용할 수 없습니다.",
      text: `${plugin.name}:${command.name} skill은 projectScoped=true 메타데이터가 없어 동료 모드에서 차단했습니다.`,
    };
  }

  const { stdout, stderr } = await executeCommand(plugin, command, request);
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const table = isSkillTable(parsed.table) ? parsed.table : undefined;
    return {
      kind: table ? "table" : "text",
      runtime: "local",
      pluginName: plugin.name,
      skillName: command.name,
      title: typeof parsed.title === "string" ? parsed.title : `${plugin.name}:${command.name}`,
      summary: typeof parsed.summary === "string" ? parsed.summary : "Skill 실행이 완료되었습니다.",
      text: typeof parsed.text === "string" ? parsed.text : undefined,
      table,
      raw: parsed,
    };
  } catch {
    return {
      kind: "text",
      runtime: "local",
      pluginName: plugin.name,
      skillName: command.name,
      title: `${plugin.name}:${command.name}`,
      summary: "Skill 실행이 완료되었습니다.",
      text: [trimmed, stderr.trim()].filter(Boolean).join("\n\n"),
      raw: { stdout: trimmed, stderr, cwd: path.basename(plugin.rootPath) },
    };
  }
}
