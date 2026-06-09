const project = process.env.AVATAR_CHAT_PROJECT_SCOPE || "default-project";
const checkedAt = new Date().toISOString();

const rows = [
  {
    service: "api-gateway",
    status: "normal",
    signal: "HTTP 200 /health",
    checkedAt,
    project,
    note: "최근 샘플 체크 정상"
  },
  {
    service: "worker",
    status: "normal",
    signal: "queue lag 0",
    checkedAt,
    project,
    note: "처리 대기열 없음"
  },
  {
    service: "dashboard",
    status: "watch",
    signal: "p95 420ms",
    checkedAt,
    project,
    note: "응답 시간 관찰 필요"
  }
];

console.log(JSON.stringify({
  title: "서비스 상태표",
  summary: `${project} 범위에서 ${rows.length}개 서비스 상태를 조회했습니다.`,
  table: {
    columns: ["service", "status", "signal", "checkedAt", "project", "note"],
    rows
  }
}, null, 2));
