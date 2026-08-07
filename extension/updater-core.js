// Pure logic of the self-updater page, kept apart from updater.js (which touches
// chrome.*, fetch, and File System Access) so it can be unit tested like axtree.js.
//
// Trust model: the update payload comes from a PUBLIC GitHub release, so nothing
// here is trusted until the RSA signature over the exact payload bytes verifies
// against the public key pinned in this extension's own manifest `key` — the
// same key that fixes the extension id. Validation below is defence in depth
// AFTER that signature check, never a substitute for it.

/** Files the updater may write. Anything else in a payload is refused. */
export const UPDATABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Numeric dotted-version compare ("0.10.0" > "0.9.1"): negative when a<b,
 * 0 when equal, positive when a>b — null when either side is not
 * dotted-numeric, so callers fail toward "cannot compare".
 */
export function compareDottedVersions(a, b) {
  const parse = (v) => {
    const parts = String(v).trim().split(".");
    return parts.length && parts.every((p) => /^\d+$/.test(p)) ? parts.map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Shape-check a SIGNATURE-VERIFIED payload: `{ version, files: [{name, content}] }`.
 * Throws with a user-facing Korean message on any violation. Name rules keep a
 * payload from ever writing outside the connected folder (no separators, no
 * dot-navigation), and manifest.json must be present — a payload without it
 * could strand the install on a version the server no longer recognizes.
 */
export function validateUpdatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("업데이트 데이터의 형식이 올바르지 않습니다.");
  }
  const version = payload.version;
  if (typeof version !== "string" || compareDottedVersions(version, version) === null) {
    throw new Error("업데이트 데이터에 유효한 버전이 없습니다.");
  }
  const files = payload.files;
  if (!Array.isArray(files) || !files.length) {
    throw new Error("업데이트 데이터에 파일 목록이 없습니다.");
  }
  for (const file of files) {
    if (
      !file ||
      typeof file.name !== "string" ||
      typeof file.content !== "string" ||
      !UPDATABLE_NAME.test(file.name) ||
      file.name === "." ||
      file.name === ".." ||
      file.name.includes("/") ||
      file.name.includes("\\")
    ) {
      throw new Error("업데이트 데이터에 허용되지 않는 파일 항목이 있습니다.");
    }
  }
  if (!files.some((file) => file.name === "manifest.json")) {
    throw new Error("업데이트 데이터에 manifest.json이 없습니다.");
  }
  return { version, files: files.map((file) => ({ name: file.name, content: file.content })) };
}

/**
 * New manifest bytes with THIS install's `externally_connectable.matches`
 * preserved: the released payload is generic, but a folder may carry a stamped
 * or hand-added Noah address, and dropping it would silently disconnect the
 * bridge (`chrome.runtime` just vanishes from that page). Mirrors the merge the
 * Noah-page one-click updater performs.
 */
export function mergeManifestPreservingMatches(newManifestJson, currentMatches) {
  const manifest = JSON.parse(newManifestJson);
  const shipped = Array.isArray(manifest?.externally_connectable?.matches)
    ? manifest.externally_connectable.matches
    : [];
  const merged = [...shipped];
  for (const pattern of Array.isArray(currentMatches) ? currentMatches : []) {
    if (typeof pattern === "string" && pattern && !merged.includes(pattern)) {
      merged.push(pattern);
    }
  }
  manifest.externally_connectable = { ...manifest.externally_connectable, matches: merged };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Noah addresses this install talks to, derived from its OWN
 * `externally_connectable.matches` — the manual fallback links to the zip on
 * the server the user actually reaches. Localhost sorts last: a dev entry
 * ships in every build, and it must never outrank the real deployment.
 */
export function noahOriginsFromMatches(matches) {
  const origins = [];
  for (const pattern of Array.isArray(matches) ? matches : []) {
    if (typeof pattern !== "string") continue;
    try {
      const url = new URL(pattern.replace(/\*$/, ""));
      if (url.protocol !== "https:" && url.protocol !== "http:") continue;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      // A malformed match pattern is not worth failing the page over.
    }
  }
  const local = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
  return [...origins.filter((o) => !local(o)), ...origins.filter(local)];
}

/** Where a given Noah server hands out the extension zip (cookie-authenticated). */
export function zipUrlForOrigin(origin) {
  return `${origin}/api/browser-extension.zip`;
}

/** base64 → bytes, for the manifest `key` (SPKI) and the detached signature. */
export function base64ToBytes(b64) {
  const binary = atob(String(b64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
