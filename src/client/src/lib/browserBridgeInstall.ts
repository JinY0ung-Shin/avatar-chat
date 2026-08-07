// Page-driven one-click update for the browser-bridge extension.
//
// An unpacked extension is just a folder Chrome re-reads on reload, so
// "update" decomposes into: overwrite that folder with the server's current
// files (File System Access), then ask the extension to reload itself. The
// folder handle is picked ONCE by the user and kept in IndexedDB — neither the
// page nor the extension can discover the path on their own (by design), so
// the picker gesture is the entire path disclosure.
//
// Trust model unchanged from the zip flow: the files come from the same
// authenticated endpoint the zip does; the page only gains write access
// to the one folder the user pointed at, revocable in site settings.

import { api } from "./api";
import { bridgeExtensionId, readAllowedOrigins, requestExtensionReload } from "./browserBridge";

// --- File System Access structural types ------------------------------------
// Deliberately local and minimal: lib.dom's FSA coverage varies by TS version
// and the picker/permission members are WICG extensions. Structural typing
// also lets unit tests pass plain objects.

export interface WritableLike {
  write(data: string | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable(): Promise<WritableLike>;
}

export interface DirHandleLike {
  name?: string;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  queryPermission?(desc: { mode: string }): Promise<string>;
  requestPermission?(desc: { mode: string }): Promise<string>;
}

/** File System Access is Chromium-only and can be disabled by enterprise policy. */
export function fsaSupported(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/** Open the OS directory picker. Null when unsupported or the user cancels. */
export async function pickExtensionDir(): Promise<DirHandleLike | null> {
  const picker = (
    globalThis as { showDirectoryPicker?: (opts: { mode: string }) => Promise<DirHandleLike> }
  ).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ mode: "readwrite" });
  } catch {
    return null; // cancelled (AbortError) — not an error state worth surfacing
  }
}

// --- Handle persistence -------------------------------------------------------
// FileSystemDirectoryHandle is structured-clonable, so IndexedDB (not
// localStorage) is the required store. Scoped per origin + browser profile,
// which matches the extension being per-profile.

const DB_NAME = "noah-browser-bridge";
const STORE = "install";
const HANDLE_KEY = "extensionDir";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

async function idbOp<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB op failed"));
    });
  } finally {
    db.close();
  }
}

/** The previously connected extension folder, or null (never picked / cleared / storage wiped). */
export async function loadSavedExtensionDir(): Promise<DirHandleLike | null> {
  try {
    return ((await idbOp("readonly", (s) => s.get(HANDLE_KEY))) as DirHandleLike | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveExtensionDir(handle: DirHandleLike): Promise<void> {
  await idbOp("readwrite", (s) => s.put(handle, HANDLE_KEY));
}

export async function clearExtensionDir(): Promise<void> {
  try {
    await idbOp("readwrite", (s) => s.delete(HANDLE_KEY));
  } catch {
    // Already unreachable — the goal state.
  }
}

/**
 * True when the handle is (re-)authorized for readwrite. A stored handle wakes
 * up as "prompt" unless the user granted persistent access (Chrome 122+), so
 * call this inside the button's click handler — requestPermission needs a user
 * gesture. Handles without the permission API (tests, future spec drift) pass.
 */
export async function ensureDirPermission(handle: DirHandleLike): Promise<boolean> {
  try {
    const current = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "granted";
    if (current === "granted") return true;
    if (current === "denied") return false;
    return ((await handle.requestPermission?.({ mode: "readwrite" })) ?? "denied") === "granted";
  } catch {
    return false;
  }
}

// --- Folder verification -------------------------------------------------------

/**
 * Chrome derives an unpacked extension's id from the manifest `key`: sha256 of
 * the DER public key, first 16 bytes, each nibble mapped into a–p. Mirrors the
 * server's browserExtensionId(); running it here lets the page check that a
 * picked folder holds OUR extension before overwriting anything in it.
 */
export async function extensionIdFromManifestKey(keyBase64: string): Promise<string | null> {
  try {
    const der = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
    let id = "";
    for (const byte of digest.slice(0, 16)) {
      id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f));
    }
    return id;
  } catch {
    return null;
  }
}

export type DirVerdict = "ok" | "not-extension" | "different-extension";

/**
 * Refuse to overwrite a folder that is not our unpacked extension. A keyless
 * manifest fails closed ("different-extension"): without `key` there is no id
 * to check against, and every bundle we ship carries one. This proves the
 * folder holds a COPY of our extension — whether it is the copy Chrome loaded
 * is only provable end-to-end (version re-probe after reload).
 */
export async function verifyExtensionDir(handle: DirHandleLike): Promise<DirVerdict> {
  let text: string;
  try {
    text = await (await (await handle.getFileHandle("manifest.json")).getFile()).text();
  } catch {
    return "not-extension";
  }
  try {
    const manifest = JSON.parse(text) as { key?: unknown };
    if (typeof manifest.key !== "string") return "different-extension";
    return (await extensionIdFromManifestKey(manifest.key)) === bridgeExtensionId()
      ? "ok"
      : "different-extension";
  } catch {
    return "not-extension";
  }
}

// --- Update ---------------------------------------------------------------------

export interface ExtensionFilePayload {
  name: string;
  content: string;
  /** Present on binary entries (icons): `content` is base64, not utf8 text. */
  encoding?: "base64";
}

/**
 * Keep hand-added Noah addresses across an update: the install guide documents
 * editing `externally_connectable.matches` for multi-address setups, and a
 * rewrite silently dropping them is exactly the breakage this flow exists to
 * end. Server-stamped entries come first; existing extras are appended.
 */
export function mergeManifestOrigins(existingText: string | null, incomingText: string): string {
  if (!existingText) return incomingText;
  try {
    const existing = JSON.parse(existingText) as {
      externally_connectable?: { matches?: unknown };
    };
    const incoming = JSON.parse(incomingText) as {
      externally_connectable?: { matches?: unknown };
    };
    const extra = Array.isArray(existing.externally_connectable?.matches)
      ? existing.externally_connectable.matches.filter((m): m is string => typeof m === "string")
      : [];
    const merged = Array.isArray(incoming.externally_connectable?.matches)
      ? incoming.externally_connectable.matches.filter((m): m is string => typeof m === "string")
      : [];
    for (const pattern of extra) {
      if (!merged.includes(pattern)) merged.push(pattern);
    }
    incoming.externally_connectable = { ...incoming.externally_connectable, matches: merged };
    return `${JSON.stringify(incoming, null, 2)}\n`;
  } catch {
    return incomingText; // unparseable side → the server's copy wins
  }
}

/**
 * Overwrite the bundle files in the folder. Names come from the server's own
 * allowlist, but refuse anything path-like anyway — this function holds a
 * write handle to a real user folder. manifest.json goes LAST as the commit
 * marker: a write that dies midway leaves the old manifest (and thus a
 * loadable extension) in place. Base64 entries (the icons) are decoded to raw
 * bytes — written as a utf8 string they would corrupt, and Chrome refuses to
 * LOAD an extension whose manifest names an unreadable icon.
 */
export async function writeExtensionFiles(
  handle: DirHandleLike,
  files: ExtensionFilePayload[],
): Promise<void> {
  const ordered = [...files].sort(
    (a, b) => Number(a.name === "manifest.json") - Number(b.name === "manifest.json"),
  );
  for (const file of ordered) {
    if (!/^[\w][\w.-]*$/.test(file.name)) {
      throw new Error(`unexpected bundle filename: ${file.name}`);
    }
    const fh = await handle.getFileHandle(file.name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(
      file.encoding === "base64"
        ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
        : file.content,
    );
    await writable.close();
  }
}

export type UpdateOutcome =
  | { status: "updated"; version: string }
  /** Files are in place; one manual chrome://extensions ↻ finishes it (pre-0.5.0 build, or reload unconfirmed). */
  | { status: "manual-reload"; version: string }
  /** Reload ran but the running version did not change — the connected folder is a copy, not the loaded one. */
  | { status: "wrong-folder" }
  | { status: "failed"; reason: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The one-click update: fetch the server's current files, overwrite the
 * folder, ask the extension to reload, then re-probe the RUNNING build. The
 * probe is the real verdict — a reload "ok" only proves the OLD worker heard
 * us, and a dropped reply can still be a successful reload mid-teardown.
 */
export async function updateExtensionInPlace(handle: DirHandleLike): Promise<UpdateOutcome> {
  let payload: { version?: string | null; files?: ExtensionFilePayload[] };
  try {
    payload = await api<{ version?: string | null; files?: ExtensionFilePayload[] }>(
      "/api/browser-extension.files",
    );
  } catch (err) {
    return { status: "failed", reason: (err as Error).message };
  }
  const serverVersion = typeof payload.version === "string" ? payload.version : "";
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length || !serverVersion) {
    return { status: "failed", reason: "서버가 확장 파일 목록을 주지 않았습니다." };
  }

  let existingManifest: string | null = null;
  try {
    existingManifest = await (await (await handle.getFileHandle("manifest.json")).getFile()).text();
  } catch {
    // Fresh/renamed folder: nothing to merge, the server manifest stands alone.
  }
  const stamped = files.map((file) =>
    file.name === "manifest.json"
      ? { ...file, content: mergeManifestOrigins(existingManifest, file.content) }
      : file,
  );

  try {
    await writeExtensionFiles(handle, stamped);
  } catch (err) {
    return { status: "failed", reason: (err as Error).message };
  }

  const reply = await requestExtensionReload();
  await sleep(1500);
  let probe = await readAllowedOrigins();
  if (!probe.ok) {
    // The worker may still be mid-restart; one more beat before giving up.
    await sleep(1500);
    probe = await readAllowedOrigins();
  }
  const running = probe.ok && typeof probe.version === "string" ? probe.version : "";

  if (running === serverVersion && running) return { status: "updated", version: running };
  if (!reply.ok && /unsupported operation/i.test(reply.message || "")) {
    // Pre-0.5.0 build: it cannot reload itself, but the new files are already
    // in place — one manual ↻ and every later update is one click.
    return { status: "manual-reload", version: serverVersion };
  }
  if (running && running !== serverVersion) return { status: "wrong-folder" };
  return { status: "manual-reload", version: serverVersion };
}
