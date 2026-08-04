export const SDK_SUBAGENT_TOOLS = ["Task", "Agent"] as const;

export const SDK_UI_HANDLED_TOOLS = ["AskUserQuestion"] as const;

export const SDK_TASK_CREATE_TOOLS = ["TaskCreate", "TaskCreated", "TaskStarted"] as const;

export const SDK_TASK_UPDATE_TOOLS = ["TaskUpdate", "TaskProgress", "TaskStatus"] as const;

export const SDK_TASK_END_TOOLS = ["TaskComplete", "TaskCompleted", "TaskStop"] as const;

export const SDK_TASK_INSPECTION_TOOLS = [
  "TaskGet",
  "TaskRead",
  "TaskOutput",
  "TaskList",
] as const;

export const SDK_PLAN_TOOLS = ["EnterPlanMode", "ExitPlanMode"] as const;

/**
 * Agent-teams coordination tools (CLI's experimental agent teams, enabled via
 * CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS in `agentSubprocessEnv`): `Agent` with a
 * `name:` spawns an addressable teammate; `SendMessage` messages it. Auto-allowed
 * like the orchestration set but deliberately NOT in SDK_HIDDEN_ACTIVITY_TOOLS —
 * teammate coordination should show as activity rows, not look like dead air.
 */
export const SDK_TEAM_TOOLS = ["SendMessage"] as const;

export const SDK_INTERNAL_HIDDEN_TOOLS = [
  "ToolSearch",
  "TodoWrite",
  "SlashCommand",
  "ShowOnboardingRolePicker",
] as const;

export const SDK_ORCHESTRATION_TOOLS = [
  ...SDK_SUBAGENT_TOOLS,
  ...SDK_TASK_CREATE_TOOLS,
  ...SDK_TASK_UPDATE_TOOLS,
  ...SDK_TASK_END_TOOLS,
  ...SDK_TASK_INSPECTION_TOOLS,
  ...SDK_PLAN_TOOLS,
] as const;

export const SDK_HIDDEN_ACTIVITY_TOOLS = [
  ...SDK_INTERNAL_HIDDEN_TOOLS,
  ...SDK_ORCHESTRATION_TOOLS,
] as const;

/**
 * Full-CLI harness tools the SDK/CLI advertises by default but that Noah Almighty
 * does NOT use: they're absent from `allowedTools`, duplicate an app feature
 * (Cron* vs. `mcp__system__*_routine`, PushNotification vs. `mcp__system__notify_user`,
 * Enter/ExitWorktree vs. `mcp__git_repo__open_repo`), or are interactive-CLI-only
 * (Workflow / Monitor / DesignSync / ClaudeDesign / ScheduleWakeup /
 * RemoteTrigger / ReportFindings / SendFeedback / ProposeSkills).
 * `SendMessage` is NOT here: it powers agent teams (SDK_TEAM_TOOLS) and an admin
 * can turn it off via the togglable-tool policy instead.
 * Fed to the SDK `disallowedTools` option so they're dropped from the advertised
 * `tools` array on every request — ~10k tokens of tool descriptions (Workflow's
 * description alone is ~4.7k tokens). Unknown names are harmless no-ops, so the
 * list can name tools a given CLI version may not ship.
 */
export const UNUSED_SDK_BUILTIN_TOOLS = [
  "Workflow",
  "Monitor",
  "DesignSync",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterWorktree",
  "ExitWorktree",
  "ScheduleWakeup",
  "PushNotification",
  "RemoteTrigger",
  "ReportFindings",
  "SendFeedback",
  "ClaudeDesign",
  "ProposeSkills",
] as const;

export const SDK_TOOL_LABELS: Record<string, string> = {
  Agent: "에이전트 실행",
  Artifact: "아티팩트 게시",
  AskUserQuestion: "사용자 질문",
  Bash: "명령 실행",
  ClaudeDesign: "디자인 작업",
  CronCreate: "예약 생성",
  CronDelete: "예약 삭제",
  CronList: "예약 목록",
  Edit: "파일 편집",
  EnterPlanMode: "계획 모드 시작",
  EnterWorktree: "작업트리 진입",
  ExitPlanMode: "계획 제출",
  ExitWorktree: "작업트리 종료",
  FileEdit: "파일 편집",
  FileRead: "파일 읽기",
  FileWrite: "파일 쓰기",
  Glob: "파일 찾기",
  Grep: "내용 검색",
  ListMcpResources: "MCP 리소스 목록",
  Mcp: "MCP 도구",
  Monitor: "모니터링 시작",
  NotebookEdit: "노트북 편집",
  Projects: "프로젝트 지식",
  ProposeSkills: "스킬 제안",
  PushNotification: "푸시 알림",
  Read: "파일 읽기",
  ReadMcpResource: "MCP 리소스 읽기",
  ReadMcpResourceDir: "MCP 리소스 폴더 읽기",
  RefreshMcpTools: "MCP 도구 새로고침",
  RemoteTrigger: "원격 트리거",
  REPL: "REPL 실행",
  ReportFindings: "리뷰 결과 보고",
  ScheduleWakeup: "후속 실행 예약",
  SendFeedback: "피드백 전송",
  SendMessage: "팀원 메시지 전송",
  Skill: "스킬 실행",
  Task: "하위 작업",
  TaskComplete: "태스크 완료",
  TaskCompleted: "태스크 완료",
  TaskCreate: "태스크 생성",
  TaskCreated: "태스크 생성",
  TaskGet: "태스크 조회",
  TaskList: "태스크 목록",
  TaskOutput: "태스크 출력 확인",
  TaskProgress: "태스크 진행",
  TaskRead: "태스크 조회",
  TaskStarted: "태스크 시작",
  TaskStatus: "태스크 상태",
  TaskStop: "태스크 중지",
  TaskUpdate: "태스크 업데이트",
  TodoWrite: "할 일 갱신",
  WebFetch: "웹 페이지 읽기",
  WebSearch: "웹 검색",
  Workflow: "워크플로 실행",
  Write: "파일 쓰기",
};

/**
 * Human-readable label for a tool name, for status lines and activity rows. Raw
 * ids like `mcp__repo__write_file` are an implementation detail, so an unmapped
 * name degrades to its bare tool segment — the same fallback the client's
 * `humanTool` applies, so a status line and its activity row agree.
 */
export function sdkToolLabel(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const mapped = SDK_TOOL_LABELS[name];
  if (mapped) return mapped;
  // Server segments may themselves contain underscores (git_repo, group_agent),
  // so match the server non-greedily and take the tool segment.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return (mcp ? mcp[2] : name).replace(/_/g, " ");
}
