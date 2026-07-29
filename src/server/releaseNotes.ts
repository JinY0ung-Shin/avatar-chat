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
}

export interface ReleaseNote {
  /** Stable release id, e.g. "2026-07-29". Unique; newest entry sits first. */
  id: string;
  /** What changed in this release (Korean, shown as a list). */
  items: ReleaseNoteItem[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    id: "2026-07-29",
    items: [
      {
        title: "아바타 간 상담",
        body: "아바타가 같은 그룹 동료의 아바타에게 직접 질문하고, 받은 답변을 대화에 활용해요.",
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
