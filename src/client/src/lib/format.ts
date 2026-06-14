import DOMPurify from "dompurify";
import { marked } from "marked";

export function avatarImageUrl(user: { id: string; hasImage?: boolean } | null, size = 96): string | null {
  if (!user?.id || !user.hasImage) return null;
  return `/api/users/${encodeURIComponent(user.id)}/avatar-image?v=${size}`;
}

export function initials(user: { alias?: string; displayName?: string; username?: string } | null): string {
  const label = user?.alias || user?.displayName || user?.username || "?";
  return label.trim().slice(0, 2).toUpperCase();
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
