// Relay between a parked browser-bridge operation and the Noah browser
// extension. The page cannot touch another origin's DOM, so every operation is
// handed to the extension, which performs the CDP calls and answers.
//
// This module deliberately holds NO authority of its own: it forwards an
// operation the server already authorized and returns whatever the extension
// says. The trust boundary is this page's authenticated session — which is why
// the extension only accepts messages from this origin.

/** The published extension id. Overridable for a locally loaded unpacked build. */
const EXTENSION_ID =
  (import.meta.env?.VITE_BROWSER_EXTENSION_ID as string | undefined) ||
  "fbohmmepjdncddcieglnblnlfiblbhbo";

/** Wire shape the extension answers with. `ok:false` carries a model-facing reason. */
export interface BridgeReply {
  ok: boolean;
  message?: string;
  snapshot?: string;
  url?: string;
  title?: string;
  tabs?: { tabId: string; title: string; url: string; current: boolean }[];
  /** A JS dialog is open on the tab (page frozen, no snapshot possible). */
  dialog?: { type: string; message: string; defaultPrompt?: string };
  /** screenshot: captured image bytes, base64 (no data: prefix). */
  imageBase64?: string;
  imageMimeType?: string;
  /** read_text: one chunk of the page's readable text, plus its range. */
  pageText?: string;
  pageTextOffset?: number;
  pageTextTotal?: number;
}

export interface BridgeOperation {
  op:
    | "snapshot"
    | "navigate"
    | "click"
    | "type"
    | "fill_form"
    | "select_option"
    | "press_key"
    | "scroll"
    | "hover"
    | "navigate_back"
    | "handle_dialog"
    | "wait_for"
    | "read_text"
    | "screenshot"
    | "list_tabs"
    | "new_tab"
    | "select_tab"
    | "close_tab";
  url?: string | null;
  uid?: string | null;
  text?: string | null;
  submit?: boolean;
  keystrokes?: boolean;
  key?: string | null;
  modifiers?: string[] | null;
  repeat?: number | null;
  direction?: string | null;
  pixels?: number | null;
  accept?: boolean | null;
  promptText?: string | null;
  textGone?: string | null;
  timeoutS?: number | null;
  tabId?: string | null;
  fields?: { uid: string; value: string; clear?: boolean }[] | null;
  option?: string | null;
  fullPage?: boolean | null;
  offset?: number | null;
}

/** Where the effective allowlist comes from; `managed` cannot be edited here. */
export type AllowlistSource = "managed" | "local" | "empty";

export interface AllowlistReply extends BridgeReply {
  patterns?: string[];
  source?: AllowlistSource;
  /** Installed extension build (manifest version). Absent on pre-0.4.0 builds. */
  version?: string;
}

type ChromeRuntime = {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
  ) => void;
  lastError?: { message?: string };
};

function runtime(): ChromeRuntime | null {
  // `chrome.runtime` is only defined on origins the extension declares in
  // `externally_connectable`. Its presence does NOT prove OUR extension is
  // installed — any matching extension defines it — so a send round-trip is
  // the only real probe.
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return chrome?.runtime && typeof chrome.runtime.sendMessage === "function"
    ? chrome.runtime
    : null;
}

/** True when this browser could plausibly reach the extension (not proof it is installed). */
export function browserBridgeReachable(): boolean {
  return runtime() !== null;
}

const NOT_INSTALLED: BridgeReply = {
  ok: false,
  message:
    "The Noah browser extension is not reachable from this page. Ask the user to install it and reload Noah; " +
    "without it there is no way to drive their browser.",
};

/**
 * Forward one operation to the extension. Never rejects — a failure becomes an
 * `ok:false` reply so the parked run always gets a definite answer rather than
 * waiting out its TTL.
 */
export function sendToExtension(operation: BridgeOperation): Promise<BridgeReply> {
  const rt = runtime();
  if (!rt) {
    return Promise.resolve(NOT_INSTALLED);
  }
  return new Promise<BridgeReply>((resolve) => {
    let settled = false;
    const finish = (reply: BridgeReply) => {
      if (settled) return;
      settled = true;
      resolve(reply);
    };
    // Below the server's park TTL so the client, not the timer, reports the
    // failure — a client-authored message can say what to do about it.
    const timer = setTimeout(() => {
      finish({
        ok: false,
        message:
          "The browser extension did not answer in time. The attached tab may have been closed or the page may be stuck loading. " +
          "Ask the user to check the attached tab, then retry.",
      });
    }, 40000);
    try {
      rt.sendMessage(EXTENSION_ID, { source: "noah", ...operation }, (response) => {
        clearTimeout(timer);
        if (rt.lastError) {
          finish(NOT_INSTALLED);
          return;
        }
        const reply = response as BridgeReply | undefined;
        if (!reply || typeof reply.ok !== "boolean") {
          finish({
            ok: false,
            message: "The browser extension returned an unreadable response.",
          });
          return;
        }
        finish(reply);
      });
    } catch {
      clearTimeout(timer);
      finish(NOT_INSTALLED);
    }
  });
}

/** The extension id this page targets (manifest-`key`-pinned, env-overridable). */
export function bridgeExtensionId(): string {
  return EXTENSION_ID;
}

/**
 * Numeric dotted-version compare ("0.10.0" > "0.9.1", unlike a string compare):
 * negative when a<b, 0 when equal, positive when a>b — null when either side is
 * not dotted-numeric, so callers fail toward "not vouched for".
 */
export function compareBridgeVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().split(".");
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

export type BridgeVersionVerdict = "current" | "compatible" | "outdated";

/**
 * Badge verdict for the INSTALLED extension build against the server bundle.
 * "current" = exact match; "compatible" = differs but at/above the server's
 * min-compatible floor (works now, update optional); "outdated" = below the
 * floor, no reported version (pre-0.4.0 builds), or no parseable floor to
 * vouch for the difference.
 */
export function bridgeVersionVerdict(
  installed: string,
  expected: string,
  minCompatible?: string | null,
): BridgeVersionVerdict {
  if (!installed) return "outdated";
  if (installed === expected) return "current";
  if (minCompatible) {
    const cmp = compareBridgeVersions(installed, minCompatible);
    if (cmp !== null && cmp >= 0) return "compatible";
  }
  return "outdated";
}

/**
 * Ask the extension to reload itself after the one-click update rewrote its
 * folder (the chrome://extensions ↻ equivalent). Builds before 0.5.0 answer
 * `Unsupported operation` — the caller falls back to asking for one manual ↻.
 */
export function requestExtensionReload(): Promise<BridgeReply> {
  return sendToExtension({ op: "reloadExtension" } as unknown as BridgeOperation);
}

/**
 * Read the allowlist the extension is currently enforcing. `source` matters as
 * much as the list: a `managed` list is pushed by policy and the editor must
 * present it read-only rather than offering a control that silently does
 * nothing.
 */
export function readAllowedOrigins(): Promise<AllowlistReply> {
  return sendToExtension({ op: "getAllowedOrigins" } as unknown as BridgeOperation);
}

/** Replace the local allowlist. Refused by the extension when policy governs it. */
export function writeAllowedOrigins(patterns: string[]): Promise<AllowlistReply> {
  return sendToExtension({
    op: "setAllowedOrigins",
    patterns,
  } as unknown as BridgeOperation);
}
