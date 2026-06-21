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

export const SDK_TOOL_LABELS: Record<string, string> = {
  Agent: "에이전트 실행",
  Artifact: "아티팩트 게시",
  AskUserQuestion: "사용자 질문",
  Bash: "명령 실행",
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
  PushNotification: "푸시 알림",
  Read: "파일 읽기",
  ReadMcpResource: "MCP 리소스 읽기",
  RemoteTrigger: "원격 트리거",
  REPL: "REPL 실행",
  ScheduleWakeup: "후속 실행 예약",
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
