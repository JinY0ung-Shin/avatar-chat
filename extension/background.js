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
  "Input.imeSetComposition",
  "Input.insertText",
  "Page.enable",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.handleJavaScriptDialog",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
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
  // Page powers navigation history, layout metrics and — critically — the
  // javascriptDialogOpening events the dialog tracking below depends on.
  await sendCdp({ tabId }, "Page.enable", {});
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
    // A dialog raised from inside an OOPIF surfaces on the child's session.
    await sendCdp(child, "Page.enable", {});
  } catch {
    // A frame can die between attach and configure; the next snapshot re-walks.
  }
});

// Clicking Chrome's own "cancel" on the debugging banner, or any other detach,
// must drop our state rather than leave stale sessions that fail confusingly.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId);
    pendingDialogs.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  pendingDialogs.delete(tabId);
});

// ------------------------------------------------------------------- dialogs
//
// A JavaScript dialog (alert/confirm/prompt/beforeunload) BLOCKS the renderer:
// any CDP command that needs the page — a snapshot walk, even the ack of the
// input event that triggered the dialog — hangs until it is answered. So the
// open dialog is tracked here, input sends RACE against it, and perform()
// reports the dialog instead of freezing the bridge. The user answering the
// native dialog by hand lands in javascriptDialogClosed like any other path.

/** tabId -> { type, message, defaultPrompt, target } while a dialog is open. */
const pendingDialogs = new Map();
/** tabId -> Set<wake> for in-flight input sends racing dialog-open. */
const dialogWaiters = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  if (method === "Page.javascriptDialogOpening") {
    pendingDialogs.set(source.tabId, {
      type: params?.type || "alert",
      message: params?.message || "",
      defaultPrompt: params?.defaultPrompt || "",
      // Answer on the session that raised it — an OOPIF's dialog belongs to
      // the child session, not the root.
      target: source.sessionId
        ? { tabId: source.tabId, sessionId: source.sessionId }
        : { tabId: source.tabId },
    });
    for (const wake of dialogWaiters.get(source.tabId) || []) wake();
  } else if (method === "Page.javascriptDialogClosed") {
    pendingDialogs.delete(source.tabId);
  }
});

/**
 * Await `work`, but stop waiting the moment a JS dialog opens on the tab —
 * the send that triggered it will not ack until the dialog is answered.
 */
async function raceDialogOpen(tabId, work) {
  if (pendingDialogs.has(tabId)) {
    work.catch(() => {});
    return;
  }
  let wake;
  const opened = new Promise((resolve) => {
    wake = resolve;
  });
  let waiters = dialogWaiters.get(tabId);
  if (!waiters) dialogWaiters.set(tabId, (waiters = new Set()));
  waiters.add(wake);
  try {
    await Promise.race([work, opened]);
  } finally {
    waiters.delete(wake);
    if (!waiters.size) dialogWaiters.delete(tabId);
    // When the dialog won, the blocked send settles whenever the dialog is
    // answered — keep that from becoming an unhandled rejection.
    work.catch(() => {});
  }
}

/** Result for "a dialog is open": everything but a snapshot, which would hang. */
async function dialogBlockedResult(tab) {
  const dialog = pendingDialogs.get(tab.id);
  return {
    ok: true,
    dialog: dialog
      ? { type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt }
      : undefined,
    url: tab.url || "",
    title: tab.title || "",
    snapshot: "",
    tabs: (await groupedTabs()).map(describeTab),
  };
}

// ------------------------------------------------------------------- scoping

/** The Noah tab group, or null when the user has not made one yet. */
async function noahGroup() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return groups.length ? groups[0] : null;
}

/**
 * Every tab inside the Noah group. THE scope boundary — nothing outside this
 * list is reachable, which is what keeps the agent away from the user's other
 * logged-in tabs. `chrome.tabs.query` by groupId is the only lookup used; there
 * is deliberately no path that resolves a tab by index, title, or activity.
 */
async function groupedTabs() {
  const group = await noahGroup();
  if (!group) return [];
  const tabs = await chrome.tabs.query({ groupId: group.id });
  return tabs.filter((tab) => tab.id != null);
}

const NO_TAB_MESSAGE =
  `No tab is attached. Ask the user to put the tab you should drive into a tab group named "${GROUP_TITLE}" ` +
  "(right-click a tab → add to new group → name it Noah), or open one yourself with mcp__browser__new_tab — " +
  "the user will be asked to approve creating the group. " +
  "Dragging a tab out of that group revokes access immediately.";

/**
 * Which grouped tab subsequent operations act on. Sticky so a multi-step task
 * doesn't silently hop tabs, but always re-validated against the group: if the
 * user dragged the current tab out, the pointer is stale and must not be used.
 */
let currentTabId = null;

async function targetTab() {
  const tabs = await groupedTabs();
  if (!tabs.length) throw new Error(NO_TAB_MESSAGE);
  const picked = tabs.find((tab) => tab.id === currentTabId) || tabs[0];
  currentTabId = picked.id;
  return picked;
}

/** Resolve a caller-supplied tab id, refusing anything outside the group. */
async function groupedTabById(tabId) {
  const tabs = await groupedTabs();
  if (!tabs.length) throw new Error(NO_TAB_MESSAGE);
  const found = tabs.find((tab) => String(tab.id) === String(tabId));
  if (!found) {
    throw new Error(
      `Tab ${tabId} is not in the "${GROUP_TITLE}" group. Call mcp__browser__list_tabs for the tabs you may use — ` +
        "tabs outside the group are off limits and cannot be reached by any other means.",
    );
  }
  return found;
}

function describeTab(tab) {
  return {
    tabId: String(tab.id),
    title: tab.title || "",
    url: tab.url || "",
    current: tab.id === currentTabId,
  };
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

// ------------------------------------------------- group-creation consent

/**
 * Creating the "Noah" group is what switches browser control ON in a browser
 * that has none, so it must not happen as a silent side effect of new_tab.
 * The question is asked in EXTENSION UI (a popup window): consent granted in
 * browser chrome cannot be forged, auto-clicked, or restyled by anything the
 * bridge drives. An existing group needs no prompt — its presence IS the
 * consent, and dragging tabs out remains the revocation.
 *
 * The budget is deliberately tight: the Noah client gives the whole operation
 * 40s before it reports a bridge timeout, and a confirmed new_tab still has to
 * create the tab and wait for it to load (up to 15s). 20s to answer keeps the
 * worst case inside the client's window.
 */
const CONSENT_TIMEOUT_MS = 20 * 1000;

const CONSENT_DECLINED =
  `The user declined to create the "${GROUP_TITLE}" tab group, so no tab was opened and browser control stays off. ` +
  "Do not retry — tell the user what you wanted to open and let them decide how to proceed.";
const CONSENT_UNANSWERED =
  "The user did not answer the tab-group prompt in time, so no tab was opened. " +
  "Tell the user a confirmation popup appears in their browser when you open a tab, and retry when they are ready.";

let consentSeq = 0;
/** The single in-flight consent: { token, windowId, timer, settle }. */
let pendingConsent = null;

function settleConsent(token, outcome) {
  if (!pendingConsent || pendingConsent.token !== token) return;
  const { windowId, timer, settle } = pendingConsent;
  pendingConsent = null;
  clearTimeout(timer);
  chrome.windows.remove(windowId).catch(() => {
    // Already closed — the user's click and our cleanup can race; both are fine.
  });
  settle(outcome);
}

/** Ask the user, in extension UI, whether to create the Noah group for `url`. */
async function requestGroupConsent(url) {
  if (pendingConsent) {
    return {
      granted: false,
      reason:
        "A tab-group confirmation popup is already open in the user's browser. Wait for their answer instead of calling new_tab again.",
    };
  }
  const token = String(++consentSeq);
  const page = `${chrome.runtime.getURL("consent.html")}?token=${token}&url=${encodeURIComponent(url)}`;
  let win;
  try {
    win = await chrome.windows.create({ url: page, type: "popup", width: 440, height: 400, focused: true });
  } catch (error) {
    return {
      granted: false,
      reason:
        `The consent popup could not be opened (${String(error?.message || error)}). Ask the user to create the ` +
        `"${GROUP_TITLE}" tab group themselves: right-click a tab → add to new group → name it ${GROUP_TITLE}.`,
    };
  }
  return new Promise((resolve) => {
    pendingConsent = {
      token,
      windowId: win.id,
      timer: setTimeout(
        () => settleConsent(token, { granted: false, reason: CONSENT_UNANSWERED }),
        CONSENT_TIMEOUT_MS,
      ),
      settle: resolve,
    };
  });
}

// Internal channel only — the consent page is part of this extension. Web
// pages land on onMessageExternal instead, so no site content can answer.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "noah-group-consent") return;
  settleConsent(
    String(message.token),
    message.allow ? { granted: true } : { granted: false, reason: CONSENT_DECLINED },
  );
});

// Closing the popup without clicking is an answer too: not granted.
chrome.windows.onRemoved.addListener((windowId) => {
  if (pendingConsent && pendingConsent.windowId === windowId) {
    settleConsent(pendingConsent.token, { granted: false, reason: CONSENT_DECLINED });
  }
});

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
      const interactive = INTERACTIVE_ROLES.has(role);
      // Nameless NON-interactive nodes are noise, but a nameless interactive
      // element (an unlabeled rich-text editor, an icon-only button) still
      // needs a uid — dropping those made such editors unreachable entirely.
      if (!name && !value && !interactive) continue;
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

/**
 * Key descriptors for Input.dispatchKeyEvent. `text` is what makes a key REAL
 * to the page: a keyDown without text is a rawKeyDown, which never produces a
 * keypress — an Enter without text:"\r" does not trigger implicit form submit.
 */
const KEY_DEFS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { code: "Space", keyCode: 32, text: " " },
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function modifierMask(names) {
  let mask = 0;
  for (const name of Array.isArray(names) ? names : []) {
    mask |= MODIFIER_BITS[name] || 0;
  }
  return mask;
}

/** True when the text is what a real keyboard would produce via an IME (한글 등). */
function needsComposition(text) {
  return /[^\x00-\x7F]/.test(text);
}

/**
 * Insert text the way an IME does: composition events bracket the commit.
 * Korean-aware editors often sync their model on compositionend and ignore a
 * bare insertText — without this, Hangul lands in the DOM but the editor's
 * state never learns about it.
 */
async function insertTextAsIme(target, text) {
  try {
    await sendCdp(target, "Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  } catch {
    // No IME-capable focus (or an older Chrome): the plain commit below still
    // inserts the text, which is exactly the previous behavior.
  }
  await sendCdp(target, "Input.insertText", { text });
}

/** Dispatch one full key press (down+up) with proper text/code/keyCode. */
async function dispatchKey(target, key, modifiers) {
  const def = KEY_DEFS[key];
  let params;
  if (def) {
    params = {
      key: def.key || key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      ...(def.text ? { text: def.text } : {}),
    };
  } else if ([...key].length === 1) {
    if (needsComposition(key)) {
      // A real IME key press: keydown "Process" (vk 229), composition, commit.
      const proc = { key: "Process", windowsVirtualKeyCode: 229 };
      await sendCdp(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, ...proc });
      await insertTextAsIme(target, key);
      await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...proc });
      return;
    }
    const upper = key.toUpperCase();
    params = {
      key,
      text: key,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      ...(/^[A-Z]$/.test(upper)
        ? { code: `Key${upper}` }
        : /^[0-9]$/.test(key)
          ? { code: `Digit${key}` }
          : {}),
    };
  } else {
    throw new Error(
      `Unsupported key "${key}". Use one of ${Object.keys(KEY_DEFS)
        .filter((name) => name !== " ")
        .join(", ")}, or a single printable character.`,
    );
  }
  // With Ctrl/Alt/Meta held the press is a shortcut, not text entry.
  if (modifiers & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) {
    delete params.text;
  }
  await sendCdp(target, "Input.dispatchKeyEvent", {
    type: params.text ? "keyDown" : "rawKeyDown",
    modifiers,
    ...params,
  });
  const { text: _text, ...upParams } = params;
  await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...upParams });
}

async function typeRef(uid, value, submit, keystrokes) {
  const ref = resolveRef(uid);
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
  await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });
  if (keystrokes) {
    // Replay as real per-character key events, ONE bridge operation for the
    // whole string — for editors that only listen to keyboard input. Server
    // caps the length; the dialog check keeps a mid-string alert() from
    // queueing keystrokes into a frozen renderer.
    for (const ch of [...value]) {
      if (pendingDialogs.has(ref.tabId)) return;
      await dispatchKey(target, ch === "\n" ? "Enter" : ch, 0);
    }
  } else if (needsComposition(value)) {
    await insertTextAsIme(target, value);
  } else {
    await sendCdp(target, "Input.insertText", { text: value });
  }
  if (submit) {
    await dispatchKey(target, "Enter", 0);
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

/**
 * A ref carries the tab that minted it, which may not be the current one after
 * a tab switch. Re-check THAT tab: still in the group, still on an allowed
 * origin. Without this, a uid captured on an allowed page could be actioned
 * after the tab left the group or navigated somewhere denied.
 */
async function assertRefTabUsable(uid, patterns, source) {
  const ref = refMap.get(uid);
  if (!ref) return null;
  const tab = await groupedTabById(ref.tabId);
  if (tab.url && !originAllowed(tab.url, patterns)) return refuseOrigin(tab.url, source);
  return null;
}

async function perform(message) {
  const { patterns, source } = await readPolicy();

  // Tab management runs before the current-tab origin check: listing and
  // switching must work even when the tab you are on is not allowlisted,
  // otherwise a single denied tab strands the agent with no way to move.
  if (message.op === "list_tabs") {
    const tabs = await groupedTabs();
    if (!tabs.length) return { ok: false, message: NO_TAB_MESSAGE };
    await targetTab(); // settle `current` before describing
    return { ok: true, tabs: (await groupedTabs()).map(describeTab) };
  }

  if (message.op === "new_tab") {
    if (!originAllowed(message.url, patterns)) return refuseOrigin(message.url, source);
    let group = await noahGroup();
    // No group = browser control is currently OFF in this browser. Turning it
    // on must be the user's click, not a tab-creation side effect, so ask
    // first — and on refusal, leave nothing behind.
    if (!group) {
      const consent = await requestGroupConsent(message.url);
      if (!consent.granted) return { ok: false, message: consent.reason };
      // The user may have created the group by hand while the popup was open.
      group = await noahGroup();
    }
    const created = await chrome.tabs.create({ url: message.url, active: false });
    // Join the existing group, or start the one just approved — a tab the
    // agent opened carries none of the user's other state, and it stays
    // visible and revocable in the same green group as everything else.
    const groupId = await chrome.tabs.group(
      group ? { tabIds: [created.id], groupId: group.id } : { tabIds: [created.id] },
    );
    if (!group) {
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "green" });
    }
    currentTabId = created.id;
    await waitForLoad(created.id);
  }

  if (message.op === "select_tab") {
    const picked = await groupedTabById(message.tabId);
    currentTabId = picked.id;
  }

  if (message.op === "close_tab") {
    const picked = await groupedTabById(message.tabId);
    await chrome.tabs.remove(picked.id);
    attached.delete(picked.id);
    if (currentTabId === picked.id) currentTabId = null;
    const left = await groupedTabs();
    if (!left.length) {
      return { ok: true, tabs: [], url: "", title: "", snapshot: "" };
    }
  }

  const tab = await targetTab();
  // Check the tab we are ABOUT to read as well as any URL we are asked to open:
  // an allowed navigation can land somewhere else via a redirect, and a tab the
  // user dragged in may already be sitting on a denied site.
  if (tab.url && !originAllowed(tab.url, patterns)) return refuseOrigin(tab.url, source);
  await ensureAttached(tab.id);

  // An open JS dialog freezes the renderer: every page-touching command below
  // would hang. Surface the dialog instead — only handle_dialog may proceed.
  if (message.op !== "handle_dialog" && pendingDialogs.has(tab.id)) {
    return dialogBlockedResult(tab);
  }

  if (message.op === "handle_dialog") {
    const dialog = pendingDialogs.get(tab.id);
    if (!dialog) {
      return {
        ok: false,
        message:
          "No JavaScript dialog is open on this tab, so there is nothing to answer. Take a snapshot to see the current page state.",
      };
    }
    await sendCdp(dialog.target, "Page.handleJavaScriptDialog", {
      accept: Boolean(message.accept),
      ...(message.promptText != null ? { promptText: String(message.promptText) } : {}),
    });
    pendingDialogs.delete(tab.id);
    // Answering can resume a submit or navigation the dialog was holding up.
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "navigate") {
    if (!originAllowed(message.url, patterns)) return refuseOrigin(message.url, source);
    await sendCdp({ tabId: tab.id }, "Page.navigate", { url: message.url });
    await waitForLoad(tab.id);
  } else if (message.op === "navigate_back") {
    const { currentIndex, entries } = await sendCdp(
      { tabId: tab.id },
      "Page.getNavigationHistory",
      {},
    );
    const previous = currentIndex > 0 ? (entries || [])[currentIndex - 1] : null;
    if (!previous) {
      return {
        ok: false,
        message:
          "This tab has no earlier history entry to go back to. Open a page explicitly with mcp__browser__navigate instead.",
      };
    }
    // The destination is known BEFORE moving — refuse a back step into a
    // denied origin instead of visiting it and refusing afterwards.
    if (previous.url && !originAllowed(previous.url, patterns)) {
      return refuseOrigin(previous.url, source);
    }
    await sendCdp({ tabId: tab.id }, "Page.navigateToHistoryEntry", { entryId: previous.id });
    await waitForLoad(tab.id);
  } else if (message.op === "click") {
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    await raceDialogOpen(tab.id, clickRef(message.uid));
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "type") {
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    await raceDialogOpen(
      tab.id,
      typeRef(message.uid, message.text || "", Boolean(message.submit), Boolean(message.keystrokes)),
    );
    if (message.submit) await waitForLoad(tab.id, 5000);
  } else if (message.op === "press_key") {
    let target = { tabId: tab.id };
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source);
      if (refused) return refused;
      const ref = resolveRef(message.uid);
      target = { tabId: ref.tabId, sessionId: ref.sessionId };
      await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
      await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });
    }
    const repeat = Math.min(Math.max(Math.round(Number(message.repeat) || 1), 1), 50);
    await raceDialogOpen(
      tab.id,
      (async () => {
        for (let i = 0; i < repeat; i += 1) {
          if (pendingDialogs.has(tab.id)) return;
          await dispatchKey(target, String(message.key || ""), modifierMask(message.modifiers));
        }
      })(),
    );
    // Enter and shortcuts can submit or navigate, same as a click.
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "hover") {
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    const { target, x, y } = await centerOf(resolveRef(message.uid));
    await raceDialogOpen(
      tab.id,
      sendCdp(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
    );
  } else if (message.op === "scroll") {
    const direction = ["up", "down", "left", "right"].includes(message.direction)
      ? message.direction
      : "down";
    const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
    const viewWidth = viewport.clientWidth || 800;
    const viewHeight = viewport.clientHeight || 600;
    let target = { tabId: tab.id };
    let x = viewWidth / 2;
    let y = viewHeight / 2;
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source);
      if (refused) return refused;
      ({ target, x, y } = await centerOf(resolveRef(message.uid)));
    }
    const span = direction === "left" || direction === "right" ? viewWidth : viewHeight;
    const requested = Number(message.pixels);
    const amount = Math.min(Math.max(Math.round(requested > 0 ? requested : span * 0.8), 1), 20000);
    await raceDialogOpen(
      tab.id,
      sendCdp(target, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0,
        deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0,
      }),
    );
  } else if (message.op === "wait_for") {
    const wantText = typeof message.text === "string" && message.text ? message.text : null;
    const goneText =
      typeof message.textGone === "string" && message.textGone ? message.textGone : null;
    if (!wantText && !goneText) {
      return {
        ok: false,
        message:
          "wait_for needs `text` (wait until it appears), `textGone` (wait until it disappears), or both.",
      };
    }
    // Bounded well inside the Noah client's 40s bridge budget, leaving room
    // for the final snapshot walk on a big page.
    const timeoutMs = Math.min(Math.max(Number(message.timeoutS) || 10, 1), 25) * 1000;
    const started = Date.now();
    for (;;) {
      if (pendingDialogs.has(tab.id)) break; // frozen page — reported below
      const view = await buildSnapshot(tab);
      if ((!wantText || view.includes(wantText)) && (!goneText || !view.includes(goneText))) break;
      if (Date.now() - started >= timeoutMs) {
        return {
          ok: false,
          message:
            `Timed out after ${Math.round(timeoutMs / 1000)}s: ` +
            [
              wantText ? `"${wantText}" did not appear` : "",
              goneText ? `"${goneText}" did not disappear` : "",
            ]
              .filter(Boolean)
              .join(" and ") +
            ". Take a snapshot to inspect the current page state before deciding what to do next.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } else if (!["snapshot", "new_tab", "select_tab", "close_tab"].includes(message.op)) {
    return { ok: false, message: `Unsupported operation "${message.op}".` };
  }

  // Re-check where we actually LANDED before reading the page: a permitted URL
  // can redirect somewhere denied, and the snapshot is the exfiltration path
  // that matters (reading a logged-in page is the risk, not just acting on it).
  const fresh = await chrome.tabs.get(tab.id);
  if (fresh.url && !originAllowed(fresh.url, patterns)) return refuseOrigin(fresh.url, source);

  // A dialog may have opened as a RESULT of the action (click → confirm). The
  // snapshot walk would hang on the frozen renderer — report the dialog instead.
  if (pendingDialogs.has(tab.id)) return dialogBlockedResult(fresh);

  const snapshot = await buildSnapshot(fresh);
  // Always report the group's tabs: the agent needs to know a new tab appeared
  // (or that several are open) without spending a separate list_tabs round trip.
  return {
    ok: true,
    snapshot,
    url: fresh.url,
    title: fresh.title,
    tabs: (await groupedTabs()).map(describeTab),
  };
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
    // `version` doubles as the compatibility probe for the chat status badge:
    // this op exists in every build, so asking costs nothing on old installs
    // (they simply answer without a version, which reads as "outdated").
    return { ok: true, patterns, source, version: chrome.runtime.getManifest().version };
  }
  if (message.op === "reloadExtension") {
    // One-click update: the Noah page rewrote this extension's folder (File
    // System Access) and asks for the equivalent of the chrome://extensions ↻
    // button, which re-reads every file for an unpacked install. Reply first,
    // reload on a delay — reload() tears this worker down, and an unanswered
    // message would read as failure on a page whose update actually succeeded.
    // Benign by design: it grants nothing and reads nothing, so any
    // externally_connectable Noah page may ask.
    setTimeout(() => chrome.runtime.reload(), 50);
    return { ok: true, version: chrome.runtime.getManifest().version };
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
