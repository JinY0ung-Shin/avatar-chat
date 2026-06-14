import type { ChatPane } from "./types";
import { readState } from "./state";

export interface SlashCommand {
  name: string;
  title: string;
  description: string;
  argsLabel?: string;
  ownerOnly?: boolean;
  requiresArgs?: boolean;
  serverExpand?: boolean;
  prompt?: (args: string) => string;
  action?: "new";
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "new",
    title: "새 대화",
    description: "현재 아바타와 새 대화를 바로 시작합니다.",
    action: "new",
  },
  {
    name: "summarize",
    title: "요약",
    description: "지금까지의 대화를 요약합니다.",
    prompt: () => "지금까지의 대화를 핵심 결정사항, 해야 할 일, 열린 질문으로 나눠 요약해줘.",
  },
  {
    name: "learn",
    title: "세션 학습",
    description: "이번 대화에서 재사용할 지식을 추려 저장하게 합니다.",
    ownerOnly: true,
    serverExpand: true,
  },
  {
    name: "remember",
    title: "지식 저장",
    argsLabel: "내용",
    description: "뒤에 쓴 내용을 내 지식 저장소에 기록하게 합니다.",
    ownerOnly: true,
    requiresArgs: true,
    prompt: (args) => `다음 내용을 내 지식 저장소에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘.\n\n${args}`,
  },
  {
    name: "routine",
    title: "루틴 만들기",
    argsLabel: "작업",
    description: "작업 내용을 받아 매일 실행할 루틴 생성을 요청합니다.",
    ownerOnly: true,
    requiresArgs: true,
    prompt: (args) =>
      `다음 작업을 정기적으로 실행하는 루틴을 만들어줘. 실행 시각(KST 기준)이 아래에 적혀 있으면 그대로 쓰고, 없으면 먼저 물어봐줘.\n\n${args}`,
  },
  {
    name: "find",
    title: "아바타 찾기",
    argsLabel: "요청",
    description: "요청에 맞는 팀원 아바타를 찾아 추천하게 합니다.",
    requiresArgs: true,
    prompt: (args) => `이 요청에 더 적합한 팀원 아바타가 있는지 찾아보고 추천해줘.\n\n${args}`,
  },
];

export function commandsForPane(pane: ChatPane | null): SlashCommand[] {
  const ownsAvatar = Boolean(pane?.avatar?.isOwn || (pane?.avatar?.id && pane.avatar.id === readState().user?.id));
  return SLASH_COMMANDS.filter((cmd) => !cmd.ownerOnly || ownsAvatar);
}

export function resolveTypedSlashCommand(pane: ChatPane | null, message: string): { command: SlashCommand; args: string } | null {
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(message);
  if (!match || message.startsWith("//")) return null;
  const name = match[1].toLowerCase();
  const command = commandsForPane(pane).find((cmd) => cmd.name === name);
  if (!command) return null;
  return { command, args: (match[2] || "").trim() };
}

export function slashPrompt(command: SlashCommand, args = ""): string {
  return command.prompt ? command.prompt(args) : "";
}
