import DOMPurify from "dompurify";
import { marked } from "marked";

export function avatarImageUrl(user: { id: string; hasImage?: boolean } | null, size = 96): string | null {
  if (!user?.id || !user.hasImage) return null;
  return `/api/users/${encodeURIComponent(user.id)}/avatar-image?v=${size}`;
}

export function initials(user: { alias?: string; displayName?: string; username?: string } | null): string {
  const label = user?.displayName || user?.username || user?.alias || "?";
  return label.trim().charAt(0).toUpperCase() || "?";
}

// Seed → stable hue (0..359), mirroring the old paintGenerated() so generated
// avatars keep the same colors as before the Svelte migration.
export function hashHue(seed: string): number {
  let h = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

// The generated-avatar gradient background for a user with no uploaded image.
export function avatarGradient(user: { id?: string; username?: string; displayName?: string } | null): string {
  const seed = user?.id || user?.username || user?.displayName || "a";
  const h = hashHue(seed);
  return `linear-gradient(135deg, hsl(${h} 58% 52%), hsl(${(h + 48) % 360} 64% 42%))`;
}

export function renderMarkdown(text: string | null | undefined): string {
  const source = text || "";
  const html = DOMPurify.sanitize(marked.parse(source) as string);
  if (source.trim() && !html.trim()) {
    const escaped = source.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] || c);
    return DOMPurify.sanitize(`<pre>${escaped}</pre>`);
  }
  return html;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function normalizeTags(input: unknown): string[] {
  const parts = Array.isArray(input) ? input : String(input || "").split(/[\s,]+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    if (typeof raw !== "string") continue;
    let tag = raw.trim().replace(/^[#*•·\-\s]+/, "").replace(/\s+/g, "-").replace(/[.,!?]+$/, "");
    if (!tag) continue;
    if (tag.length > 30) tag = tag.slice(0, 30);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

// Resolve a knowledge-repo address (owner/repo shorthand or full git URL) to a
// browsable https href, or null when it's neither. `githubHost` is the configured
// internal GitHub host (falls back to github.com). Hand-mirrors the server-side
// repo-href logic; keep them in lockstep.
export function repoToHref(repo: string | null, githubHost: string): string | null {
  if (!repo) return null;
  const r = repo.trim();
  if (/^https?:\/\//.test(r)) return r.replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) {
    const host = (githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
    return `https://${host}/${r.replace(/\.git$/, "")}`;
  }
  return null;
}

export function timeToMinute(value: string): number {
  const [hh, mm] = value.split(":").map((part) => Number(part));
  return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0);
}

export function minuteToTime(minute: number | null | undefined): string {
  const value = Math.max(0, Math.min(1439, Number(minute) || 0));
  const hh = String(Math.floor(value / 60)).padStart(2, "0");
  const mm = String(value % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Short, locale-aware timestamp for message rows / conversation list. Includes
// the year only when the date isn't from the current year (older "06. 11."
// alone is ambiguous). Mirrors the old core.js timeLabel().
export function timeLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const opts: Intl.DateTimeFormatOptions = { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "2-digit";
    return d.toLocaleString("ko-KR", opts);
  } catch {
    return "";
  }
}

export const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

// Human routine schedule label, e.g. "매일 09:00 (KST)", "매주 월·수·금 09:00 (KST)",
// "3시간마다", "45분마다". Mirrors the old routines.js formatRoutineSchedule().
export function formatRoutineSchedule(routine: {
  scheduleKind?: string;
  time?: string;
  daysOfWeek?: number[] | null;
  intervalMinutes?: number | null;
}): string {
  if (routine.scheduleKind === "interval") {
    const minutes = Number(routine.intervalMinutes) || 0;
    if (minutes && minutes % 60 === 0) return `${minutes / 60}시간마다`;
    return `${minutes}분마다`;
  }
  if (routine.scheduleKind === "weekly") {
    const days = (routine.daysOfWeek || [])
      .slice()
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_NAMES[d] ?? "?")
      .join("·");
    return `매주 ${days || "—"} ${routine.time || ""} (KST)`.trim();
  }
  return `매일 ${routine.time || ""} (KST)`.trim();
}

function oneLine(text: string, limit: number): string {
  const trimmed = (text || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

// Display title for a routine: explicit name, else a one-line prompt preview,
// else a placeholder. Mirrors the old routines.js routineTitle().
export function routineTitle(routine: { name?: string | null; prompt?: string }): string {
  return (routine.name || "").trim() || oneLine(routine.prompt || "", 40) || "(이름 없는 루틴)";
}

// Compact token count: 950 → "950", 17500 → "17.5K", 184000 → "184K".
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return (k < 100 ? k.toFixed(1) : Math.round(k)) + "K";
}

// "이번 턴" 토큰 사용량 배지 라벨: 컨텍스트 점유(입력/윈도우) + 출력.
export function formatUsageLabel(usage: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number; contextWindow?: number } | null | undefined): string {
  if (!usage) return "";
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const thinking = Number(usage.thinkingTokens) || 0;
  const ctx = Number(usage.contextWindow) || 0;
  if (!input && !output) return "";
  const parts: string[] = [];
  if (ctx && input) {
    // Cap the display at 100%: the server corrects an under-reported window, but
    // clamp defensively so a stale/oversized snapshot can never show e.g. 175%.
    const pct = Math.min(100, Math.round((input / ctx) * 100));
    parts.push(`컨텍스트 ${formatTokenCount(input)}/${formatTokenCount(ctx)} (${pct}%)`);
  } else if (input) {
    parts.push(`입력 ${formatTokenCount(input)}`);
  }
  // input === 0 marks a turn with no honest occupancy snapshot (see
  // finalizeTurnUsage); fall through to output-only rather than show "입력 0".
  // `output` is the turn-cumulative total (every request, incl. reasoning), so a
  // short visible reply can still read large — append the reasoning share when
  // present so the number doesn't look bogus.
  parts.push(
    thinking > 0 && thinking <= output
      ? `출력 ${formatTokenCount(output)} (추론 ${formatTokenCount(thinking)})`
      : `출력 ${formatTokenCount(output)}`,
  );
  return parts.join(" · ");
}
