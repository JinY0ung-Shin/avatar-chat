const user = process.env.AVATAR_CHAT_USER || "owner";
const query = process.env.AVATAR_CHAT_QUERY || "";

console.log(JSON.stringify({
  title: "업무 지시 요약",
  summary: `${user}님의 지시를 owner-mode skill이 처리했습니다.`,
  text: [
    "요청:",
    query,
    "",
    "샘플 marketplace에서는 실제 외부 변경 대신 처리 계획과 보고 형태만 반환합니다.",
    "실제 쓰기 작업은 운영 marketplace skill의 자체 정책, hook, MCP 설정으로 구현하세요."
  ].join("\n")
}, null, 2));
