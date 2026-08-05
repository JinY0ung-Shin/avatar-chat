// Noah Almighty browser bridge — MV3 service worker.
//
// Receives semantic operations from an authenticated Noah tab and performs them
// with CDP over chrome.debugger. Two invariants shape the whole file:
//
//  1. NO JAVASCRIPT EXECUTION. `Runtime.*` is not in the allowlist and no code
//     path builds a script string. Elements are addressed by backendNodeId from
//     the accessibility tree, so there is nothing for injected page text to
//     escape into. This is the property that bounds credential reach — the
//     permission manifest does not (a page-context fetch with credentials
//     included would inherit every session, which is exactly why we never gain
//     the ability to run one).
//
//  2. ENFORCE HERE, NOT UPSTREAM. The server also gates, but a guardrail that
//     lives only on the far side of the wire is not a guardrail. Every command
//     passes CDP_ALLOWLIST and the origin allowlist inside this worker.
//
// Scope is the tab group: a tab inside the Noah group is attached, dragging it
// out detaches it. That makes consent a live, visible surface the user can
// revoke without a settings screen.

const GROUP_TITLE = "Noah";
const CDP_VERSION = "1.3";

/**
 * Default-deny allowlist of CDP methods. Everything the bridge needs and
 * nothing else — notably no `Runtime.*`, no `Network.*` (which would reach
 * cookies), no `Storage.*`, no `Browser.*`.
 */
const CDP_ALLOWLIST = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.enable",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Page.enable",
  "Page.navigate",
  "Target.setAutoAttach",
]);

/**
 * Which hostnames the bridge may drive. EMPTY MEANS DENY EVERYTHING — the
 * opposite of nanobrowser's firewall, whose enabled-but-empty default silently
 * permits the whole web.
 *
 * Two sources, and the precedence matters more than the mechanism:
 *
 *   managed  — chrome.storage.managed, pushed by enterprise policy. When it is
 *              present it is the WHOLE answer; the local list is ignored, so a
 *              user on a managed fleet cannot widen what the operator allowed.
 *   local    — chrome.storage.local, edited on the options page. Only consulted
 *              on an UNMANAGED install (development). This grants nothing extra
 *              in practice: someone who can set it could equally edit this file.
 *
 * Cached because it is read on every operation; invalidated on any storage
 * change so a policy push takes effect without reinstalling.
 */
const POLICY_KEY = "allowedOrigins";

let policyCache = null;

async function readPolicy() {
  if (policyCache) return policyCache;

  let managed = [];
  try {
    const stored = await chrome.storage.managed.get(POLICY_KEY);
    if (Array.isArray(stored?.[POLICY_KEY])) managed = stored[POLICY_KEY].filter(Boolean);
  } catch {
    // No managed store exists on an unmanaged install; that is not an error.
  }
  if (managed.length) {
    policyCache = { patterns: managed, source: "managed" };
    return policyCache;
  }

  let local = [];
  try {
    const stored = await chrome.storage.local.get(POLICY_KEY);
    if (Array.isArray(stored?.[POLICY_KEY])) local = stored[POLICY_KEY].filter(Boolean);
  } catch {
    // Ignore: an unreadable local list must fail closed, not open.
  }
  policyCache = { patterns: local, source: local.length ? "local" : "empty" };
  return policyCache;
}

chrome.storage.onChanged.addListener(() => {
  policyCache = null;
});

/** tabId -> { rootSession: true, children: Set<sessionId> } */
const attached = new Map();

/** uid -> { tabId, sessionId, backendNodeId } from the most recent snapshot. */
let refMap = new Map();
let refSeq = 0;

// ---------------------------------------------------------------- CDP plumbing

function sendCdp(target, method, params) {
  if (!CDP_ALLOWLIST.has(method)) {
    return Promise.reject(new Error(`Method not allowed: ${method}`));
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result || {});
    });
  });
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      const err = chrome.runtime.lastError;
      // Already attached by us is fine; attached by another client is not.
      if (err && !/already attached/i.test(err.message || "")) reject(new Error(err.message));
      else resolve();
    });
  });
}

/**
 * Attach and turn on flat-mode auto-attach. Without setAutoAttach we never
 * learn that out-of-process iframes exist, and there is no lighter substitute:
 * getFullAXTree does not cross an OOPIF boundary.
 */
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await attachDebugger(tabId);
  attached.set(tabId, { children: new Set() });
  await sendCdp({ tabId }, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await sendCdp({ tabId }, "DOM.enable", {});
  await sendCdp({ tabId }, "Accessibility.enable", {});
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== "Target.attachedToTarget") return;
  const entry = attached.get(source.tabId);
  if (!entry || !params?.sessionId) return;
  entry.children.add(params.sessionId);
  const child = { tabId: source.tabId, sessionId: params.sessionId };
  try {
    // Nested OOPIFs only surface if each new child also auto-attaches.
    await sendCdp(child, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await sendCdp(child, "DOM.enable", {});
    await sendCdp(child, "Accessibility.enable", {});
  } catch {
    // A frame can die between attach and configure; the next snapshot re-walks.
  }
});

// Clicking Chrome's own "cancel" on the debugging banner, or any other detach,
// must drop our state rather than leave stale sessions that fail confusingly.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));

// ------------------------------------------------------------------- scoping

async function groupedTabIds() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  if (!groups.length) return [];
  const tabs = await chrome.tabs.query({ groupId: groups[0].id });
  return tabs.map((tab) => tab.id).filter((id) => id != null);
}

/**
 * The single tab the bridge may drive: the first tab in the Noah group. Scope
 * is deliberately the GROUP and not "whatever is active" — an agent that
 * follows the user's focus can act on a tab the user never consented to.
 */
async function targetTab() {
  const ids = await groupedTabIds();
  if (!ids.length) {
    throw new Error(
      `No tab is attached. Ask the user to put the tab you should drive into a tab group named "${GROUP_TITLE}" — ` +
        "dragging a tab out of that group revokes access immediately.",
    );
  }
  const tab = await chrome.tabs.get(ids[0]);
  return tab;
}

function originAllowed(rawUrl, patterns) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    // `*.corp.local` matches sub.corp.local but NOT corp.local itself, so a
    // wildcard can't silently pull in the apex a operator didn't list.
    if (pattern.startsWith("*.")) return url.hostname.endsWith(pattern.slice(1));
    return url.hostname === pattern;
  });
}

/** Refusal text is model-facing: say what happened and close off the retry. */
function refuseOrigin(rawUrl, source) {
  const where =
    source === "managed"
      ? "The site is not in the administrator's browser-control policy."
      : source === "local"
        ? "The site is not in this browser's local allowlist (extension options page)."
        : "No browser-control allowlist is configured yet, so every site is denied.";
  return {
    ok: false,
    message:
      `${where} Blocked: ${rawUrl}. Tell the user which site was blocked and who can change it; ` +
      "do not try a different URL to reach the same content.",
  };
}

// ------------------------------------------------------------------ snapshot

/** Walk every attached session and merge the accessibility trees into one view. */
async function buildSnapshot(tab) {
  const entry = attached.get(tab.id);
  const sessions = [{ tabId: tab.id }, ...[...(entry?.children || [])].map((sessionId) => ({ tabId: tab.id, sessionId }))];

  refMap = new Map();
  refSeq = 0;
  const lines = [];

  for (const session of sessions) {
    let nodes;
    try {
      ({ nodes } = await sendCdp(session, "Accessibility.getFullAXTree", {}));
    } catch {
      continue; // A frame can vanish mid-walk; the rest of the page still renders.
    }
    for (const node of nodes || []) {
      if (node.ignored) continue;
      const role = node.role?.value;
      if (!role || role === "none" || role === "generic" || role === "InlineTextBox") continue;
      const name = (node.name?.value || "").trim();
      const value = (node.value?.value || "").trim();
      if (!name && !value) continue;

      const interactive = INTERACTIVE_ROLES.has(role);
      if (interactive && node.backendDOMNodeId != null) {
        const uid = `e${++refSeq}`;
        refMap.set(uid, {
          tabId: tab.id,
          sessionId: session.sessionId,
          backendNodeId: node.backendDOMNodeId,
        });
        lines.push(`[${uid}] ${role} "${name}"${value ? ` = "${value}"` : ""}`);
      } else {
        lines.push(`${role} "${name || value}"`);
      }
    }
  }
  return lines.join("\n");
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "spinbutton",
]);

// -------------------------------------------------------------------- actions

function resolveRef(uid) {
  const ref = refMap.get(uid);
  if (!ref) {
    throw new Error(
      `Unknown element uid "${uid}". Take a fresh mcp__browser__snapshot — uids are only valid for the snapshot that produced them.`,
    );
  }
  return ref;
}

/** Centre point of an element, via quads on the element's OWN session. */
async function centerOf(ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
  const { quads } = await sendCdp(target, "DOM.getContentQuads", {
    backendNodeId: ref.backendNodeId,
  });
  if (!quads || !quads.length) {
    throw new Error("The element is not visible on screen, so it cannot be clicked.");
  }
  const [x1, y1, x2, , x3, y3] = quads[0];
  return { target, x: (x1 + x3) / 2, y: (y1 + y3) / 2, width: Math.abs(x2 - x1) };
}

async function clickRef(uid) {
  const { target, x, y } = await centerOf(resolveRef(uid));
  const base = { x, y, button: "left", clickCount: 1 };
  await sendCdp(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await sendCdp(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

async function typeRef(uid, value, submit) {
  const ref = resolveRef(uid);
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
  await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });
  await sendCdp(target, "Input.insertText", { text: value });
  if (submit) {
    for (const type of ["keyDown", "keyUp"]) {
      await sendCdp(target, "Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    }
  }
}

/** Wait for the tab to stop loading, so a snapshot reflects the new page. */
function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" || Date.now() - started > timeoutMs) {
          resolve();
          return;
        }
      } catch {
        resolve();
        return;
      }
      setTimeout(poll, 250);
    };
    setTimeout(poll, 250);
  });
}

// -------------------------------------------------------------- message entry

async function perform(message) {
  const { patterns, source } = await readPolicy();
  const tab = await targetTab();
  // Check the tab we are ABOUT to read as well as any URL we are asked to open:
  // an allowed navigation can land somewhere else via a redirect, and a tab the
  // user dragged in may already be sitting on a denied site.
  if (tab.url && !originAllowed(tab.url, patterns)) return refuseOrigin(tab.url, source);
  await ensureAttached(tab.id);

  if (message.op === "navigate") {
    if (!originAllowed(message.url, patterns)) return refuseOrigin(message.url, source);
    await sendCdp({ tabId: tab.id }, "Page.enable", {});
    await sendCdp({ tabId: tab.id }, "Page.navigate", { url: message.url });
    await waitForLoad(tab.id);
  } else if (message.op === "click") {
    await clickRef(message.uid);
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "type") {
    await typeRef(message.uid, message.text || "", Boolean(message.submit));
    if (message.submit) await waitForLoad(tab.id, 5000);
  } else if (message.op !== "snapshot") {
    return { ok: false, message: `Unsupported operation "${message.op}".` };
  }

  // Re-check where we actually LANDED before reading the page: a permitted URL
  // can redirect somewhere denied, and the snapshot is the exfiltration path
  // that matters (reading a logged-in page is the risk, not just acting on it).
  const fresh = await chrome.tabs.get(tab.id);
  if (fresh.url && !originAllowed(fresh.url, patterns)) return refuseOrigin(fresh.url, source);

  const snapshot = await buildSnapshot(fresh);
  return { ok: true, snapshot, url: fresh.url, title: fresh.title };
}

// `externally_connectable` restricts senders to the Noah origins declared in the
// manifest, and `sender.origin` is filled in by the browser, so the page cannot
// forge it. Re-check anyway: the manifest is the gate, this is the assertion.
/**
 * Read/write the local allowlist from the Noah page, so an operator can manage
 * it where they already are instead of hunting for the extension's options
 * page. Deliberately NOT a way around policy: when managed policy is present it
 * still wins in readPolicy(), and `setAllowedOrigins` refuses outright rather
 * than writing a list that would be silently ignored.
 */
async function handleConfig(message) {
  const { patterns, source } = await readPolicy();
  if (message.op === "getAllowedOrigins") {
    return { ok: true, patterns, source };
  }
  if (message.op === "setAllowedOrigins") {
    if (source === "managed") {
      return {
        ok: false,
        message:
          "An administrator policy controls the allowed sites for this browser; it cannot be changed from here.",
      };
    }
    const next = Array.isArray(message.patterns)
      ? [...new Set(message.patterns.map((p) => String(p).trim().toLowerCase()).filter(Boolean))]
      : [];
    await chrome.storage.local.set({ [POLICY_KEY]: next });
    policyCache = null;
    return { ok: true, patterns: next, source: next.length ? "local" : "empty" };
  }
  return null;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== "noah" || !sender.origin) {
    sendResponse({ ok: false, message: "Rejected: unrecognized sender." });
    return false;
  }
  const config = handleConfig(message);
  config
    .then((reply) => (reply ? reply : perform(message)))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));
  // Keep the channel open for the async reply.
  return true;
});
