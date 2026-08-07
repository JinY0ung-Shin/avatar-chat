/**
 * Registry of user-facing release notes, newest first (#whats-new). When a user
 * first loads the app after a deploy whose latest entry they haven't seen
 * (`users.last_seen_release`), the client shows a one-time "새로운 기능" dialog
 * listing what changed, then marks the latest entry seen via
 * `PUT /api/me/seen-release`.
 *
 * Maintenance: when deploying user-visible changes, PREPEND a new entry with a
 * fresh `id`. Ids are date-based (`YYYY-MM-DD`; suffix `.2` for a same-day
 * second release) and must stay unique — ordering comes from array position,
 * never from parsing the id. Entries may be pruned from the tail; a user whose
 * stored id is unknown (pruned, or a rollback) is treated like a first-timer
 * and sees the latest entries once more, which self-heals on dismiss — the
 * alternative (showing nothing) would silence every future note for them.
 *
 * `items` are shown verbatim to users, so they are KOREAN (language split:
 * user-facing strings are Korean). This module is intentionally dependency-free
 * so it can be imported by BOTH the server and the Svelte client (it is listed
 * in `tsconfig.client.json` includes), mirroring `experimentalFeatures.ts`.
 */
/**
 * In-app deep link a note item can offer (rendered as a button under the
 * item). Resolved by the CLIENT (WhatsNewModal maps the id to a label and a
 * navigation); an id a build doesn't know renders nothing, so an older client
 * showing a newer note degrades gracefully. This module stays dependency-free,
 * hence ids instead of callbacks.
 */
export type ReleaseNoteAction = "browser-guide";

export interface ReleaseNoteItem {
  /** User-facing feature name (Korean). */
  title: string;
  /** User-facing one-line description (Korean). */
  body: string;
  /** Optional usage example (Korean) — rendered as a highlighted hint line. */
  example?: string;
  /** Optional in-app deep link (see ReleaseNoteAction). */
  action?: ReleaseNoteAction;
}

export interface ReleaseNote {
  /** Stable release id, e.g. "2026-07-29". Unique; newest entry sits first. */
  id: string;
  /** What changed in this release (Korean, shown as a list). */
  items: ReleaseNoteItem[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    id: "2026-08-07",
    items: [
      {
        title: "아바타가 내 브라우저를 직접 조작해요",
        body: "이번 업데이트의 핵심 기능이에요. 브라우저 브릿지 확장을 설치하면 아바타가 내가 로그인해 둔 세션 그대로 탭을 열고 읽고 클릭하고 입력해요. 한글 입력, 스크롤, 대화상자 처리, 탭 관리까지 되고, 허용한 사이트의 Noah 탭 그룹 안에서만 · 내 아바타와의 대화에서만 움직여요.",
        example: "예: 입력창의 도구 선택에서 '브라우저 조작'을 켜고 “사내 위키 열어서 오늘 공지 요약해 줘”라고 해보세요.",
        action: "browser-guide",
      },
      {
        title: "브라우저 확장은 버튼 한 번으로 업데이트돼요",
        body: "압축을 푼 확장 폴더를 한 번 연결해 두면, 새 버전이 나왔을 때 파일 교체부터 확장 리로드까지 버튼 한 번에 끝나요. 입력창의 버전 배지가 업데이트할 시점을 알려줘요.",
        example: "예: 설정 → 권한·연결 → 확장 폴더 연결 (원클릭 업데이트)",
      },
      {
        title: "모델 선택에 Fable 티어가 생겼어요",
        body: "Opus를 넘어서는 최상위 Fable 모델을 대화별로 고를 수 있어요. 가장 까다로운 추론과 긴 작업에 적합해요.",
      },
      {
        title: "두 번째 뇌 저장이 활동 내역에 '기억'으로 보여요",
        body: "아바타가 대화 중에 지식 저장소로 기록한 내용이 활동 트리에 전용 '기억' 줄로 표시돼요. 무엇이 저장됐는지 대화 안에서 바로 확인할 수 있어요.",
      },
    ],
  },
  {
    id: "2026-08-03",
    items: [
      {
        title: "draw.io 다이어그램 그리기와 보기",
        body: "아바타가 draw.io(.drawio) 다이어그램을 직접 그려서 전달할 수 있어요. 파일 카드를 누르면 옆 패널에서 확대/이동, 페이지 전환이 되는 다이어그램으로 바로 보고, 내려받아 draw.io에서 이어서 편집할 수 있어요. Confluence 페이지에 첨부된 .drawio 파일도 같은 방식으로 볼 수 있어요.",
        example: "예: “우리 배포 파이프라인 구성도를 draw.io로 그려 줘.”",
      },
      {
        title: "그룹 메뉴 신설",
        body: "왼쪽 메뉴에 '그룹' 화면이 생겼어요. 내 그룹 확인과 그룹 설정, 관리자의 그룹 관리까지 한곳에서 해요. 설정과 관리자 화면에 나뉘어 있던 그룹 탭은 이곳으로 합쳐졌어요.",
      },
      {
        title: "그룹 에이전트 여러 개 만들기",
        body: "그룹 공유 에이전트를 이제 여러 개 둘 수 있어요. 역할별로 에이전트를 나눠 만들고 각각 따로 설정하거나 비활성화할 수 있어요.",
        example: "예: 그룹 화면 → 그룹 에이전트 추가",
      },
      {
        title: "대화로 그룹 에이전트 역할 바꾸기",
        body: "그룹 관리자는 그룹 에이전트와 대화하면서 역할·페르소나·소개를 바로 바꿀 수 있어요. 바뀐 내용은 다음 턴부터 모든 그룹원의 대화에 적용돼요.",
        example: "예: 그룹 에이전트에게 “지금부터 너는 우리 팀 코드리뷰 담당이야”라고 말해 보세요.",
      },
      {
        title: "에이전트 팀 (실험 기능)",
        body: "아바타가 복잡한 작업을 할 때 이름을 가진 팀원 에이전트들을 만들어 협업시킬 수 있어요. 진행 중 활동 표시에서 팀원별 작업을 볼 수 있어요.",
      },
    ],
  },
  {
    id: "2026-07-31",
    items: [
      {
        title: "그룹 중심 공개로 개편",
        body: "아바타의 '모두 공개' 상태가 사라졌어요. 이제 아바타는 같은 그룹의 동료에게만 보이고(또는 비공개), 그룹에 속하지 않으면 내 아바타와만 대화해요. 기존 '모두 공개' 아바타는 자동으로 '그룹 공개'로 바뀌었어요.",
      },
      {
        title: "그룹별 아바타 공개 정책",
        body: "그룹 관리자가 그룹 설정에서 '그룹원 아바타 상호 공개'를 끌 수 있어요. 끄면 지식 공유 전용 그룹이 되어 서로의 아바타가 보이지 않지만, 공용 지식 저장소는 계속 함께 사용해요.",
      },
      {
        title: "그룹 공유 에이전트",
        body: "그룹마다 그룹 에이전트를 만들 수 있어요. 그룹 지식 저장소를 공유 세컨드브레인으로 사용해서, 그룹원 누구든 대화하며 그룹 지식을 묻고 기록할 수 있어요. 대화는 개인별로 비공개이고, 그룹 공유는 세컨드브레인 기록으로 이뤄져요.",
        example: "예: 그룹 설정 → 그룹 에이전트 만들기 → 탐색에서 팀 에이전트와 대화 → “이 결정을 팀 노트에 기록해 줘.”",
      },
      {
        title: "외부 아바타 그룹 지정 필수",
        body: "관리자가 등록하는 외부 아바타도 이제 공개할 그룹을 반드시 지정해야 해요. 그룹이 지정되지 않은 항목은 아무에게도 표시되지 않아요. (운영자: EXTERNAL_AGENTS_JSON 항목에 visibleToGroupIds를 추가해 주세요.)",
      },
    ],
  },
  {
    id: "2026-07-29",
    items: [
      {
        title: "아바타 간 상담",
        body: "같은 그룹 동료의 아바타에게 필요한 정보를 요청해 보세요. 내 아바타가 대신 질문하고, 받은 답변을 정리해 대화에 활용해요.",
        example: "예: “민수님 아바타에게 이번 배포 체크리스트를 물어봐 줘.”",
      },
      {
        title: "예약 작업 실시간 보기",
        body: "예약 작업의 '지금 실행'이 실시간 대화 화면으로 열려 진행 상황을 지켜볼 수 있어요.",
      },
      {
        title: "문서 만들기와 미리보기",
        body: "아바타가 만든 PPTX 같은 문서를 채팅에서 페이지 미리보기와 함께 바로 내려받을 수 있어요.",
      },
      {
        title: "웹 페이지 읽기",
        body: "사내망을 포함한 웹 페이지를 아바타가 직접 읽어와 요약하고 활용해요.",
      },
      {
        title: "업데이트 소식 알림",
        body: "새 버전이 배포되면 지금처럼 새로워진 기능을 알려드려요.",
      },
    ],
  },
];

/** Latest release id (null only if the registry is ever emptied). */
export const CURRENT_RELEASE_ID: string | null = RELEASE_NOTES[0]?.id ?? null;

/** How many releases the dialog shows at most (long-away users aren't walled). */
export const MAX_RELEASES_SHOWN = 3;

/** Whether `id` is a registered release id (validation for the seen endpoint). */
export function isKnownReleaseId(id: unknown): id is string {
  return typeof id === "string" && RELEASE_NOTES.some((note) => note.id === id);
}

/**
 * Releases the user hasn't seen yet, newest first, capped. `lastSeen` null or
 * unknown (pruned id / rollback) counts as "never seen" — see the module note.
 */
export function unseenReleases(lastSeen: string | null | undefined): ReleaseNote[] {
  const seenIndex = lastSeen ? RELEASE_NOTES.findIndex((note) => note.id === lastSeen) : -1;
  const fresh = seenIndex >= 0 ? RELEASE_NOTES.slice(0, seenIndex) : RELEASE_NOTES;
  return fresh.slice(0, MAX_RELEASES_SHOWN);
}

/** "2026-07-29" → "2026년 7월 29일" (unparseable ids fall back to the raw id). */
export function releaseDateLabel(id: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(id);
  if (!match) {
    return id;
  }
  return `${Number(match[1])}년 ${Number(match[2])}월 ${Number(match[3])}일`;
}
