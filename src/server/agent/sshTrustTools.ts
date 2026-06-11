import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppConfig } from "../types.js";
import { addTrustedHost, listTrustedHosts, removeTrustedHost } from "../sshTrust.js";

/**
 * Per-conversation context for the SSH host-trust tools. They let the avatar
 * register/list/forget the host keys hex-ssh checks before connecting (fail-
 * closed). Host fingerprints are PUBLIC data, not secrets, so — unlike the
 * knowledge-repo tools — these are NOT owner-only: any viewer who can drive the
 * avatar's hex-ssh tools can also manage which hosts it trusts. The trust file
 * is keyed to the avatar OWNER (avatar.id), matching the injected SSH key, so it
 * persists per-user in the data volume.
 */
export interface SshTrustToolsContext {
  /** The avatar (== owner) whose trust store these tools manage. */
  avatarUserId: string;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__ssh_trust__<tool>`. */
export const SSH_TRUST_SERVER_NAME = "ssh_trust";

/** Tool names the model may call, in `allowedTools` form. */
export const SSH_TRUST_TOOL_NAMES = [
  "mcp__ssh_trust__add_host",
  "mcp__ssh_trust__list_hosts",
  "mcp__ssh_trust__remove_host",
] as const;

function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

/**
 * Build the SSH host-trust tool definitions bound to a single conversation's
 * context. Exposed separately from the server so handlers can be unit-tested.
 */
export function buildSshTrustTools(ctx: SshTrustToolsContext) {
  return [
    tool(
      "add_host",
      "원격 호스트의 SSH 호스트 키를 가져와 신뢰 목록(known_hosts)에 등록한다. hex-ssh는 신뢰되지 않은 호스트 접속을 'Host denied (verification failed)'로 거부하므로, 처음 보는 호스트에 접속하기 전에 호출한다. 등록은 즉시 반영되고 컨테이너 재시작 후에도 유지된다. 호스트 키는 비밀이 아니다.",
      {
        host: z.string().describe("호스트명 또는 IP (예: 202.20.185.100)"),
        port: z.number().int().optional().describe("SSH 포트 (기본 22)"),
      },
      async (args) => {
        const port = args.port ?? 22;
        try {
          const { entry, changed } = await addTrustedHost(ctx.avatarUserId, ctx.config, args.host, port);
          const note = changed ? "등록했습니다" : "이미 등록되어 있습니다";
          return text(
            `호스트 키를 ${note}: ${entry.host} (${entry.keyType})\n` +
              `지문: ${entry.fingerprint}\n이제 이 호스트에 접속할 수 있습니다.`,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          // The handshake failure is usually network/firewall, not auth.
          return text(
            `호스트 키를 가져오지 못했습니다 (${args.host}:${port}): ${msg}. ` +
              `호스트/포트가 맞는지, 네트워크에서 접근 가능한지 확인하세요.`,
            true,
          );
        }
      },
    ),
    tool(
      "list_hosts",
      "현재 신뢰하는 SSH 호스트 키 목록을 보여준다. (호스트, 키 종류, 지문)",
      {},
      async () => {
        const entries = await listTrustedHosts(ctx.avatarUserId, ctx.config);
        if (entries.length === 0) {
          return text("신뢰하는 호스트가 없습니다. add_host로 등록하세요.");
        }
        const body = entries
          .map((e) => `- ${e.host} (${e.keyType}) ${e.fingerprint}`)
          .join("\n");
        return text(`신뢰하는 호스트:\n${body}`);
      },
    ),
    tool(
      "remove_host",
      "신뢰 목록에서 한 호스트의 키를 제거한다. 호스트 키가 바뀌었거나 더 이상 쓰지 않을 때 사용한다.",
      {
        host: z.string().describe("제거할 호스트명 또는 IP"),
        port: z.number().int().optional().describe("SSH 포트 (기본 22)"),
      },
      async (args) => {
        const removed = await removeTrustedHost(ctx.avatarUserId, ctx.config, args.host, args.port ?? 22);
        if (removed === 0) {
          return text(`${args.host} 은(는) 신뢰 목록에 없습니다.`);
        }
        return text(`${args.host} 의 호스트 키 ${removed}개를 제거했습니다.`);
      },
    ),
  ];
}

/**
 * Build the in-process MCP server exposing the SSH host-trust tools, bound to a
 * single conversation's context.
 */
export function buildSshTrustServer(ctx: SshTrustToolsContext) {
  return createSdkMcpServer({
    name: SSH_TRUST_SERVER_NAME,
    version: "0.1.0",
    tools: buildSshTrustTools(ctx),
  });
}
