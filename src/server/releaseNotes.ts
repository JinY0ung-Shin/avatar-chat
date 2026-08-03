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
export interface ReleaseNoteItem {
  /** User-facing feature name (Korean). */
  title: string;
  /** User-facing one-line description (Korean). */
  body: string;
  /** Optional usage example (Korean) — rendered as a highlighted hint line. */
  example?: string;
}

export interface ReleaseNote {
  /** Stable release id, e.g. "2026-07-29". Unique; newest entry sits first. */
  id: string;
  /** What changed in this release (Korean, shown as a list). */
  items: ReleaseNoteItem[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    id: "2026-08-03",
    items: [
      {
        title: "draw.io 다이어그램 그리기와 보기",
        body: "아바타가 draw.io(.drawio) 다이어그램을 직접 그려서 전달할 수 있어요. 파일 카드를 누르면 옆 패널에서 확대/이동, 페이지 전환이 되는 다이어그램으로 바로 보고, 내려받아 draw.io에서 이어서 편집할 수 있습니다. Confluence 페이지에 첨부된 .drawio 파일도 같은 방식으로 볼 수 있어요.",
        example: "예: “우리 배포 파이프라인 구성도를 draw.io로 그려 줘.”",
      },
    ],
  },
  {
    id: "2026-07-31",
    items: [
      {
        title: "그룹 중심 공개로 개편",
        body: "아바타의 '모두 공개' 상태가 사라졌어요. 이제 아바타는 같은 그룹의 동료에게만 보이고(또는 비공개), 그룹에 속하지 않으면 내 아바타와만 대화합니다. 기존 '모두 공개' 아바타는 자동으로 '그룹 공개'로 바뀌었어요.",
      },
      {
        title: "그룹별 아바타 공개 정책",
        body: "그룹 관리자가 그룹 설정에서 '멤버 아바타 상호 공개'를 끌 수 있어요. 끄면 지식 공유 전용 그룹이 되어 서로의 아바타가 보이지 않지만, 공용 지식 저장소는 계속 함께 사용합니다.",
      },
      {
        title: "그룹 공유 에이전트",
        body: "그룹마다 팀 공용 에이전트를 만들 수 있어요. 그룹 지식저장소를 공유 세컨드브레인으로 사용해서, 멤버 누구든 대화하며 팀 지식을 묻고 기록할 수 있습니다. 대화는 개인별로 비공개이고, 팀 공유는 세컨드브레인 기록으로 이뤄져요.",
        example: "예: 그룹 설정 → 그룹 에이전트 만들기 → 탐색에서 팀 에이전트와 대화 → “이 결정을 팀 노트에 기록해 줘.”",
      },
      {
        title: "외부 아바타 그룹 지정 필수",
        body: "관리자가 등록하는 외부 아바타도 이제 공개할 그룹을 반드시 지정해야 해요. 그룹이 지정되지 않은 항목은 아무에게도 표시되지 않습니다. (운영자: EXTERNAL_AGENTS_JSON 항목에 visibleToGroupIds를 추가해 주세요.)",
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
