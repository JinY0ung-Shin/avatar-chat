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
}

export interface BridgeOperation {
  op: "snapshot" | "navigate" | "click" | "type";
  url?: string | null;
  uid?: string | null;
  text?: string | null;
  submit?: boolean;
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
