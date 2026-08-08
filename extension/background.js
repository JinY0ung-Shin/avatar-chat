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

import { renderAxTree, renderAxText, capSnapshot, mergeTextLines, axProp } from "./axtree.js";

const GROUP_TITLE = "Noah";
const CDP_VERSION = "1.3";

/**
 * Default-deny allowlist of CDP methods. Everything the bridge needs and
 * nothing else — notably no `Runtime.*`, no `Network.*` (which would reach
 * cookies), no `Storage.*`, no `Browser.*`. The read-only additions stay
 * inside that line: `DOM.describeNode` reads structure, `Page.captureScreenshot`
 * reads pixels — the same exfiltration class as a snapshot, gated by the same
 * origin allowlist — `DOM.getNodeForLocation` hit-tests a point so a
 * coordinate click can report what it landed on instead of assuming success,
 * and `Page.getFrameTree` reads the frame STRUCTURE (ids only, no content) so
 * same-process iframes can be walked at all.
 */
const CDP_ALLOWLIST = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "DOM.describeNode",
  "DOM.enable",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.imeSetComposition",
  "Input.insertText",
  "Page.captureScreenshot",
  "Page.enable",
  "Page.getFrameTree",
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

/**
 * uid -> { tabId, sessionId, backendNodeId }, and its reverse index. STABLE
 * ACROSS SNAPSHOTS by design: these used to reset on every buildSnapshot, so
 * "e42" silently addressed a DIFFERENT element after any re-snapshot — on a
 * page that re-orders itself (a rolling newsstand) the agent clicked a
 * stranger and had no way to notice. Now an element keeps its uid for as long
 * as it stays in the page, a re-rendered element gets a fresh one, and a dead
 * uid fails loudly instead of resolving to whatever took its place.
 */
const refMap = new Map();
const uidByNode = new Map();
let refSeq = 0;

/**
 * Ceiling on remembered uids. A long-lived worker crawling many pages would
 * otherwise grow both maps without bound; past this, everything is forgotten
 * at the start of a snapshot and agents recover through the ordinary
 * unknown-uid error. `refSeq` deliberately keeps counting — reusing numbers
 * would reintroduce exactly the wrong-element bug this map exists to prevent.
 */
const REF_MAP_MAX = 30000;

function nodeKey(tabId, sessionId, backendNodeId) {
  return `${tabId}:${sessionId || "root"}:${backendNodeId}`;
}

/** The uid for a node, minting one only the first time it is seen. */
function mintUid(tabId, sessionId, backendNodeId) {
  const key = nodeKey(tabId, sessionId, backendNodeId);
  const known = uidByNode.get(key);
  if (known) return known;
  const uid = `e${++refSeq}`;
  refMap.set(uid, { tabId, sessionId, backendNodeId });
  uidByNode.set(key, uid);
  return uid;
}

/** Forget one tab's elements: nothing there is addressable once it is gone. */
function forgetTabRefs(tabId) {
  for (const [uid, ref] of refMap) {
    if (ref.tabId !== tabId) continue;
    refMap.delete(uid);
    uidByNode.delete(nodeKey(ref.tabId, ref.sessionId, ref.backendNodeId));
  }
}

/**
 * Pixel→CSS mapping of the most recent screenshot, so `click_at` can invert
 * the downscale the capture applied. Coordinates are only valid for the
 * screenshot that produced them — unlike snapshot uids there is no mint-time
 * reset, so the click_at branch re-checks tab, URL, scroll origin, and
 * viewport size at CLICK time and refuses on drift. Non-viewport modes are
 * recorded too, so the refusal can say WHY those pixels don't map onto input
 * coordinates.
 */
let lastShot = null;

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
  forgetTabRefs(tabId);
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

/** Ids of a target's NON-main frames — the same-process iframes, recursively. */
async function childFrameIds(target) {
  try {
    const { frameTree } = await sendCdp(target, "Page.getFrameTree", {});
    const ids = [];
    const walk = (entry) => {
      for (const child of entry?.childFrames || []) {
        if (child.frame?.id) ids.push(child.frame.id);
        walk(child);
      }
    };
    walk(frameTree);
    return ids;
  } catch {
    return [];
  }
}

/**
 * Every accessibility tree that makes up one tab's page, as
 * `{ target, frameId? }` sources.
 *
 * Three kinds, and the middle one is easy to miss: `getFullAXTree` without a
 * frameId covers only the target's MAIN frame, so a SAME-process iframe
 * (a same-site widget box) rendered as an empty `Iframe "name"` line with all
 * of its content missing. Asking per frame id fills that in. Out-of-process
 * frames have their own sessions instead — their ids fail on the root session,
 * which the caller's try/continue absorbs.
 */
async function axSources(tab) {
  const entry = attached.get(tab.id);
  return [
    { target: { tabId: tab.id } },
    ...(await childFrameIds({ tabId: tab.id })).map((frameId) => ({
      target: { tabId: tab.id },
      frameId,
    })),
    ...[...(entry?.children || [])].map((sessionId) => ({
      target: { tabId: tab.id, sessionId },
    })),
  ];
}

/** One source's AX nodes, or null when that frame/session is not readable. */
async function sourceAxNodes(source) {
  try {
    const { nodes } = await sendCdp(source.target, "Accessibility.getFullAXTree", {
      ...(source.frameId ? { frameId: source.frameId } : {}),
    });
    return nodes || [];
  } catch {
    return null; // A frame can vanish mid-walk; the rest of the page still renders.
  }
}

/** Walk every attached session and merge the accessibility trees into one view. */
async function buildSnapshot(tab) {
  if (refMap.size > REF_MAP_MAX) {
    refMap.clear();
    uidByNode.clear();
  }
  const lines = [];
  for (const source of await axSources(tab)) {
    const nodes = await sourceAxNodes(source);
    if (!nodes) continue;
    // Frame nodes ride the session that fetched them; backendNodeIds are
    // unique per target, so click/type resolve unchanged.
    lines.push(
      ...renderAxTree(nodes, (backendNodeId) =>
        mintUid(source.target.tabId, source.target.sessionId, backendNodeId),
      ),
    );
  }
  return lines.join("\n");
}

// -------------------------------------------------------------------- actions

function resolveRef(uid) {
  const ref = refMap.get(uid);
  if (!ref) {
    throw new Error(
      `Unknown element uid "${uid}". No current snapshot has minted it (or the extension restarted and forgot it) — take a fresh mcp__browser__snapshot and use a uid it prints.`,
    );
  }
  return ref;
}

/** CDP's way of saying the backendNodeId no longer resolves to anything. */
const DEAD_NODE_MESSAGE = /no node|not found|could not find node/i;

/**
 * Run a CDP call against a resolved ref, translating "the node is gone" into
 * an instruction. A uid that RESOLVED but whose element left the page is the
 * common case on a re-rendering site, and raw CDP text ("No node with given
 * id") tells an agent neither what happened nor what to do next.
 */
async function nodeCall(ref, work) {
  try {
    return await work();
  } catch (error) {
    const message = String(error?.message || error);
    if (!DEAD_NODE_MESSAGE.test(message)) throw error;
    const uid = uidByNode.get(nodeKey(ref.tabId, ref.sessionId, ref.backendNodeId));
    throw new Error(
      `The element behind ${uid ? `uid "${uid}"` : "that uid"} is no longer in the page ` +
        "(it re-rendered or was removed). Take a fresh mcp__browser__snapshot and use a current uid.",
    );
  }
}

/** Every content quad of an element, on its OWN session, scrolled into view. */
async function quadsOf(ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  const { quads } = await nodeCall(ref, async () => {
    await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
    return sendCdp(target, "DOM.getContentQuads", { backendNodeId: ref.backendNodeId });
  });
  return { target, quads: quads || [] };
}

/** Centre point of an element, via quads on the element's OWN session. */
async function centerOf(ref) {
  const { target, quads } = await quadsOf(ref);
  if (!quads.length) {
    throw new Error("The element is not visible on screen, so it cannot be clicked.");
  }
  const [x1, y1, x2, , x3, y3] = quads[0];
  return { target, x: (x1 + x3) / 2, y: (y1 + y3) / 2, width: Math.abs(x2 - x1) };
}

/**
 * Ops whose events go through the BROWSER-side input router, which only
 * delivers to a renderer whose view is visible. A tab that sits in the group
 * but is not selected in its window is hidden, and every one of these is
 * dropped on the floor — while Input.insertText still lands, because that path
 * talks to the renderer's input method directly. That split is exactly what
 * made click and press_key look like successful no-ops.
 */
const INPUT_OPS = new Set(["click", "click_at", "type", "fill_form", "select_option", "press_key", "hover", "scroll"]);

/**
 * Ops that need the tab VISIBLE even though they dispatch no input: capturing
 * a hidden tab's surface returns stale or empty pixels, so `screenshot` rides
 * the same show-the-tab path as the input ops.
 */
const VISIBLE_OPS = new Set([...INPUT_OPS, "screenshot"]);

/**
 * Ops that CHANGE the page, so the snapshot they return has to wait for the
 * change to land. A page's response to input is ASYNC — an autocomplete layer,
 * a menu, a validation message all arrive at least a frame after the event is
 * acknowledged — and a snapshot taken the instant the op returned showed the
 * page as it was BEFORE, so the agent concluded nothing had happened and
 * repeated the action. Read-only ops need no settle; wait_for owns its own loop.
 */
const SETTLE_OPS = new Set([...INPUT_OPS, "navigate", "navigate_back", "new_tab", "handle_dialog"]);
const ACTION_SETTLE_MS = 350;

/** Make the tab actually visible, so dispatched input reaches its renderer. */
async function showTab(tab) {
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  // A minimized window hides the view no matter which tab is selected. Restore
  // it, but never take OS focus: the user is usually in another app, and
  // stealing focus mid-task is worse than the agent working out of sight.
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") {
      await chrome.windows.update(tab.windowId, { state: "normal", focused: false });
    }
  } catch {
    // The window can close between the read and the update; the operation below
    // then fails on its own with a better message than anything invented here.
  }
}

/** Dispatch a full left click (move → press → release) at a viewport point. */
async function clickPoint(target, x, y) {
  const base = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
  // Hit-testing starts from the last known pointer position, so a press with no
  // preceding move can resolve against a stale target; and `buttons` carries the
  // pressed-button bitmask that pointer-events handlers read instead of
  // `button`. Either omission yields a press the page may legitimately ignore.
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await sendCdp(target, "Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...base });
  await sendCdp(target, "Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...base });
}

async function clickNode(ref) {
  const { target, x, y } = await centerOf(ref);
  await clickPoint(target, x, y);
}

async function clickRef(uid) {
  return clickNode(resolveRef(uid));
}

/**
 * A 0–1 position inside an element's box for click_at's uid mode. Anything
 * that is not a real number means the centre — `null` arrives on the wire
 * whenever the caller omitted the field, and Number(null) is 0, which would
 * quietly click the left edge instead.
 */
function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Best-effort description of the element at a viewport point — the blind spot
 * of a coordinate click. Read-only (`DOM.getNodeForLocation` + `describeNode`);
 * any failure degrades to "no description", never to a failed click. When the
 * point lands in a cross-origin frame the root session resolves the <iframe>
 * element itself, which is still an honest answer.
 */
async function describePoint(tabId, x, y) {
  try {
    // ensureAttached already enabled the DOM domain for this tab.
    const target = { tabId };
    const { backendNodeId } = await sendCdp(target, "DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
    });
    if (!backendNodeId) return null;
    // Cross-check: the node's own geometry must contain the point. If the hit
    // test resolved in a different coordinate space (scroll offset, zoom),
    // the mismatch surfaces here — describe NOTHING rather than the wrong
    // element, since this line exists to keep a blind click honest.
    const { quads } = await sendCdp(target, "DOM.getContentQuads", { backendNodeId });
    const contains = (quads || []).some((quad) => {
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      return (
        x >= Math.min(...xs) - 1 &&
        x <= Math.max(...xs) + 1 &&
        y >= Math.min(...ys) - 1 &&
        y <= Math.max(...ys) + 1
      );
    });
    if (!contains) return null;
    const { node } = await sendCdp(target, "DOM.describeNode", { backendNodeId, depth: 2 });
    if (!node) return null;
    const attrs = {};
    const flat = node.attributes || [];
    for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i]] = flat[i + 1];
    // First non-empty text anywhere in the described subtree, so a wrapper
    // like <button><span>Save</span></button> still yields a label.
    const firstText = (nodes) => {
      for (const child of nodes || []) {
        if (child.nodeName === "#text" && (child.nodeValue || "").trim()) {
          return child.nodeValue.trim();
        }
        const nested = firstText(child.children);
        if (nested) return nested;
      }
      return "";
    };
    const label =
      attrs["aria-label"] || attrs.title || attrs.alt || attrs.placeholder || firstText(node.children);
    const tag = String(node.nodeName || "?").toLowerCase();
    const id = attrs.id ? ` id="${attrs.id}"` : "";
    const role = attrs.role ? ` role="${attrs.role}"` : "";
    return `<${tag}${id}${role}>${label ? ` "${label.slice(0, 80)}"` : ""}`.slice(0, 200);
  } catch {
    return null;
  }
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

/** The user's OS, for platform-mapped editing shortcuts (⌘A vs Ctrl+A). */
let cachedPlatformOs = null;

async function platformOs() {
  if (cachedPlatformOs !== null) return cachedPlatformOs;
  try {
    const info = await chrome.runtime.getPlatformInfo();
    cachedPlatformOs = info?.os || "";
  } catch {
    cachedPlatformOs = "";
  }
  return cachedPlatformOs;
}

/**
 * Focus an element for input, falling back to a real click when DOM.focus
 * refuses. Rich-text editors (ProseMirror bodies) and canvases often expose
 * an AX node whose DOM element is not natively focusable — a person focuses
 * them by clicking, and "Element is not focusable" was exactly how typing
 * into them failed before this fallback.
 */
async function focusForInput(ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await nodeCall(ref, () =>
    sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId }),
  );
  try {
    await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });
  } catch {
    await clickNode(ref);
  }
}

/**
 * Focus one field and enter `value` — the shared insert path of type and
 * fill_form. `clear` first selects the existing content the way a person
 * would (select-all, then overtype / delete), so edit forms can be REPLACED
 * rather than appended to.
 */
async function fillField(ref, value, clear) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await focusForInput(ref);
  if (clear) {
    // Blink maps the select-all editing command per platform.
    const mask = (await platformOs()) === "mac" ? MODIFIER_BITS.Meta : MODIFIER_BITS.Control;
    await dispatchKey(target, "a", mask);
    if (!value) {
      await dispatchKey(target, "Delete", 0);
      return;
    }
    // Non-empty value: the insert below replaces the selection, like paste-over.
  }
  if (!value) return;
  if (needsComposition(value)) {
    await insertTextAsIme(target, value);
  } else {
    await sendCdp(target, "Input.insertText", { text: value });
  }
}

async function typeRef(uid, value, submit, keystrokes) {
  const ref = resolveRef(uid);
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  if (keystrokes) {
    await focusForInput(ref);
    // Replay as real per-character key events, ONE bridge operation for the
    // whole string — for editors that only listen to keyboard input. Server
    // caps the length; the dialog check keeps a mid-string alert() from
    // queueing keystrokes into a frozen renderer.
    for (const ch of [...value]) {
      if (pendingDialogs.has(ref.tabId)) return;
      await dispatchKey(target, ch === "\n" ? "Enter" : ch, 0);
    }
  } else {
    await fillField(ref, value, false);
  }
  if (submit) {
    await dispatchKey(target, "Enter", 0);
  }
}

// ------------------------------------------------------------- select_option
//
// CDP has no setter for a <select>'s value short of running page JS, which
// this worker never does. So selection is driven the way a person drives it:
// a visibly rendered option is CLICKED; a collapsed native dropdown is walked
// with arrow keys and the landing value is VERIFIED afterwards — the keyboard
// path is the one that can silently no-op (macOS opens the native popup
// instead of moving the selection), and it must never claim success on faith.

async function sessionAxNodes(target) {
  const { nodes } = await sendCdp(target, "Accessibility.getFullAXTree", {});
  return nodes || [];
}

/** Option descendants of one AX node, in document order, as a uniform shape. */
function collectAxOptions(nodes, root) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const seen = new Set();
  const out = [];
  const walk = (node) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    for (const childId of node.childIds || []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (child.role?.value === "option") {
        out.push({
          label: String(child.name?.value || ""),
          disabled: axProp(child, "disabled") === true,
          selected: axProp(child, "selected") === true,
          backendNodeId: child.backendDOMNodeId,
        });
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Text of a described DOM node: its #text descendants, whitespace-collapsed. */
function domNodeText(node) {
  const texts = [];
  const walk = (item) => {
    if (!item) return;
    if (item.nodeType === 3 && item.nodeValue) texts.push(item.nodeValue);
    for (const child of item.children || []) walk(child);
  };
  walk(node);
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * OPTION elements from a described <select> subtree — the fallback when the
 * AX tree hides a collapsed popup's options. The DOM `selected` attribute
 * only reflects the markup default, not live state, so it is left undefined
 * and the caller falls back to the select's accessible value.
 */
function collectDomOptions(root) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (String(node.nodeName || "").toUpperCase() === "OPTION") {
      const attrs = node.attributes || [];
      let disabled = false;
      for (let i = 0; i < attrs.length; i += 2) {
        if (String(attrs[i]).toLowerCase() === "disabled") disabled = true;
      }
      out.push({
        label: domNodeText(node),
        disabled,
        selected: undefined,
        backendNodeId: node.backendNodeId,
      });
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}

/** Exact match first, then trimmed, then case-insensitive — never substring. */
function matchOptionLabel(options, wanted) {
  const trimmed = wanted.trim();
  return (
    options.find((option) => option.label === wanted) ||
    options.find((option) => option.label.trim() === trimmed) ||
    options.find((option) => option.label.trim().toLowerCase() === trimmed.toLowerCase()) ||
    null
  );
}

async function selectOption(uid, wanted) {
  const ref = resolveRef(uid);
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  const described = await nodeCall(ref, () =>
    sendCdp(target, "DOM.describeNode", { backendNodeId: ref.backendNodeId, depth: -1 }),
  );
  const tagName = String(described?.node?.nodeName || "").toUpperCase();
  const domAttrs = described?.node?.attributes || [];
  let isMultiple = false;
  for (let i = 0; i < domAttrs.length; i += 2) {
    if (String(domAttrs[i]).toLowerCase() === "multiple") isMultiple = true;
  }

  const nodes = await sessionAxNodes(target);
  const rootAx = nodes.find((node) => node.backendDOMNodeId === ref.backendNodeId) || null;
  let options = rootAx ? collectAxOptions(nodes, rootAx) : [];
  if (!options.length && tagName === "SELECT") options = collectDomOptions(described.node);
  if (!options.length) {
    throw new Error(
      "No options were found under this element. If it is a custom dropdown, drive it like any UI: " +
        "click it open, take a snapshot, then click (or select_option) the option that appears.",
    );
  }
  const picked = matchOptionLabel(options, wanted);
  if (!picked) {
    throw new Error(
      `No option labeled "${wanted}" was found here (${options.length} option${options.length === 1 ? "" : "s"} present). ` +
        "Take a fresh snapshot and pass the option's label exactly as it is shown.",
    );
  }
  if (picked.disabled) {
    throw new Error(`The option "${wanted}" is disabled and cannot be selected.`);
  }

  // A visibly rendered option (expanded dropdown, size>1 list, multi-select,
  // ARIA listbox) is clicked like real UI, firing the page's own handlers.
  if (picked.backendNodeId != null) {
    try {
      await clickNode({ tabId: ref.tabId, sessionId: ref.sessionId, backendNodeId: picked.backendNodeId });
      return;
    } catch {
      // No geometry — a collapsed native dropdown. Fall through to keys.
    }
  }
  if (tagName !== "SELECT") {
    throw new Error(
      `The option "${wanted}" is not currently clickable and this is not a native dropdown. ` +
        "Click the widget open, take a snapshot, then click the option that appears.",
    );
  }
  if (isMultiple) {
    throw new Error(
      `The option "${wanted}" is not currently visible in this multi-select list. ` +
        "Scroll the list (scroll with its uid), take a snapshot, then click the option.",
    );
  }

  // Collapsed native single <select>: arrows move by one ENABLED option.
  const enabled = options.filter((option) => !option.disabled);
  const targetIdx = enabled.indexOf(picked);
  let currentIdx = enabled.findIndex((option) => option.selected === true);
  if (currentIdx < 0) {
    const currentLabel = String(rootAx?.value?.value || "").trim();
    currentIdx = enabled.findIndex((option) => option.label.trim() === currentLabel);
  }
  if (currentIdx < 0) currentIdx = 0; // best effort — the verify below is the referee
  await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
  await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });
  const delta = targetIdx - currentIdx;
  for (let i = 0; i < Math.abs(delta); i += 1) {
    if (pendingDialogs.has(ref.tabId)) return; // a change handler froze the page
    await dispatchKey(target, delta > 0 ? "ArrowDown" : "ArrowUp", 0);
  }
  const after = (await sessionAxNodes(target)).find(
    (node) => node.backendDOMNodeId === ref.backendNodeId,
  );
  const landed = String(after?.value?.value || "").trim();
  if (landed !== picked.label.trim()) {
    throw new Error(
      `Selecting "${wanted}" did not take: the dropdown now reads "${landed || "(unknown)"}". ` +
        "This platform's native dropdown may not be keyboard-drivable — ask the user to pick the option themselves, then take a snapshot.",
    );
  }
}

// ------------------------------------------------------------------- reading

/** Characters of page text one read_text call returns; continue via `offset`. */
const READ_TEXT_MAX = 20000;

/**
 * Plain readable text of the page (or of one element's subtree), across every
 * attached session, in the same order the snapshot walks. Mints no uids, so
 * the previous snapshot's refs stay valid.
 */
async function buildPageText(tab, scope) {
  // A uid-scoped read stays on the session that minted the uid, but the
  // element may sit in a SAME-process child frame, whose nodes are absent from
  // that session's main tree — so the frame trees are a fallback, not a miss.
  const sources = scope
    ? [
        { target: { tabId: scope.tabId, sessionId: scope.sessionId } },
        ...(
          await childFrameIds({ tabId: scope.tabId, sessionId: scope.sessionId })
        ).map((frameId) => ({
          target: { tabId: scope.tabId, sessionId: scope.sessionId },
          frameId,
        })),
      ]
    : await axSources(tab);
  const parts = [];
  let scopeFound = false;
  for (const source of sources) {
    const nodes = await sourceAxNodes(source);
    if (!nodes) continue;
    const lines = renderAxText(nodes, scope ? scope.backendNodeId : undefined);
    if (lines === null) continue; // the start node is not in THIS tree — try the next
    scopeFound = true;
    if (lines.length) parts.push(lines.join("\n"));
    if (scope) break; // a scoped subtree lives in exactly one tree
  }
  if (scope && !scopeFound) {
    throw new Error(
      "The element behind that uid is gone from the page. Take a fresh mcp__browser__snapshot and retry read_text with a current uid.",
    );
  }
  return parts.join("\n");
}

/**
 * Time budget for the `expand` scroll loop. The Noah client parks the whole
 * bridge operation for 40s; stopping here leaves room for the final walk and
 * the reply on a big page.
 */
const EXPAND_BUDGET_MS = 18000;
/** Hard stop for text accumulated during `expand`, in characters. */
const EXPAND_MAX_CHARS = 500000;
/** Scroll steps that add no new lines before `expand` concludes it is done. */
const EXPAND_STALL_LIMIT = 3;

/**
 * read_text with `expand`: scroll toward the end of the page in viewport-sized
 * steps, collecting text at every stop. Lazy-loaded and VIRTUALIZED content
 * only exists in the DOM near the viewport (a feed can render 6 of 334
 * comments), so a single walk misses it — and content that scrolls out may be
 * REMOVED again, so chunks are merged as we go rather than read once at the
 * bottom. Infinite feeds never reach the end; the stall/time/size caps are
 * what terminate those.
 */
async function buildExpandedPageText(tab) {
  const started = Date.now();
  let lines = [];
  let stalled = 0;
  for (;;) {
    if (pendingDialogs.has(tab.id)) break;
    const text = await buildPageText(tab, null);
    const before = lines.length;
    lines = mergeTextLines(lines, text ? text.split("\n") : []);
    stalled = lines.length > before ? 0 : stalled + 1;
    const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
    const height = viewport.clientHeight || 600;
    const atEnd =
      (viewport.pageY || 0) + height >= ((metrics.cssContentSize || {}).height || 0) - 2;
    if (atEnd && stalled >= 1) break; // bottom reached and nothing new loaded
    if (stalled >= EXPAND_STALL_LIMIT) break; // nothing loads; stop spending the budget
    if (Date.now() - started >= EXPAND_BUDGET_MS) break;
    if (lines.join("\n").length >= EXPAND_MAX_CHARS) break;
    await sendCdp({ tabId: tab.id }, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: (viewport.clientWidth || 800) / 2,
      y: height / 2,
      deltaX: 0,
      deltaY: Math.round(height * 0.8),
    });
    // Give the page a beat to fetch and render what the scroll uncovered.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return lines.join("\n");
}

/** Longest horizontal edge of a screenshot after scaling, in CSS px. */
const SCREENSHOT_MAX_WIDTH = 1400;
/** fullPage capture height cap, CSS px — beyond this the image is cut off. */
const SCREENSHOT_MAX_FULL_HEIGHT = 6000;

async function captureShot(tab, message) {
  const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
  const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
  const content = metrics.cssContentSize || {};
  let clip;
  let beyondViewport = false;
  if (message.uid) {
    const ref = resolveRef(message.uid);
    if (ref.sessionId) {
      throw new Error(
        "This element lives inside a cross-origin frame, which cannot be captured on its own. " +
          "Take a screenshot without `uid` to capture the viewport instead.",
      );
    }
    const { quads } = await quadsOf(ref);
    if (!quads.length) {
      throw new Error("The element is not visible on screen, so it cannot be captured.");
    }
    // Quads are viewport-relative; the capture clip is page-absolute.
    const xs = [];
    const ys = [];
    for (const quad of quads) {
      for (let i = 0; i < quad.length; i += 2) {
        xs.push(quad[i]);
        ys.push(quad[i + 1]);
      }
    }
    const pad = 8;
    clip = {
      x: Math.max(0, Math.min(...xs) - pad + (viewport.pageX || 0)),
      y: Math.max(0, Math.min(...ys) - pad + (viewport.pageY || 0)),
      width: Math.max(...xs) - Math.min(...xs) + pad * 2,
      height: Math.max(...ys) - Math.min(...ys) + pad * 2,
    };
    beyondViewport = true;
  } else if (message.fullPage) {
    clip = {
      x: 0,
      y: 0,
      width: content.width || viewport.clientWidth || 1024,
      height: Math.min(content.height || viewport.clientHeight || 768, SCREENSHOT_MAX_FULL_HEIGHT),
    };
    beyondViewport = true;
  } else {
    clip = {
      x: viewport.pageX || 0,
      y: viewport.pageY || 0,
      width: viewport.clientWidth || 1024,
      height: viewport.clientHeight || 768,
    };
  }
  clip.width = Math.max(1, Math.round(clip.width));
  clip.height = Math.max(1, Math.round(clip.height));
  // Bound the pixel size for the model: cap the width, and stay inside the
  // 8000px-per-edge ceiling vision APIs enforce even for tall captures.
  const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / clip.width, 7900 / clip.height);
  const { data } = await sendCdp({ tabId: tab.id }, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 75,
    clip: { ...clip, scale },
    ...(beyondViewport ? { captureBeyondViewport: true } : {}),
  });
  if (!data) {
    throw new Error("The browser returned an empty screenshot. Retry after the page settles.");
  }
  // Remember this capture's pixel→CSS mapping so click_at can invert it. Only
  // a viewport capture's origin coincides with the input coordinate space;
  // element/fullPage clips are page-absolute and must be refused there. URL,
  // scroll origin, and viewport size anchor the click-time drift check.
  lastShot = {
    tabId: tab.id,
    url: tab.url || "",
    mode: message.uid ? "element" : message.fullPage ? "fullPage" : "viewport",
    scale,
    clipWidth: clip.width,
    clipHeight: clip.height,
    pageX: viewport.pageX || 0,
    pageY: viewport.pageY || 0,
  };
  return { imageBase64: data, imageMimeType: "image/jpeg" };
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
    forgetTabRefs(picked.id);
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
  // read_text with `expand` scrolls, and wheel events go through the
  // browser-side input router — dropped unless the tab's view is visible.
  if (VISIBLE_OPS.has(message.op) || (message.op === "read_text" && message.expand)) {
    await showTab(tab);
  }

  // An open JS dialog freezes the renderer: every page-touching command below
  // would hang. Surface the dialog instead — only handle_dialog may proceed.
  if (message.op !== "handle_dialog" && pendingDialogs.has(tab.id)) {
    return dialogBlockedResult(tab);
  }

  // click_at's pre-click hit-test result, reported alongside the snapshot so a
  // blind coordinate click states what it actually hit.
  let landedOn = null;

  // Read-only extraction ops answer directly: their payload REPLACES the
  // snapshot, so the common action tail below (which walks the AX tree again)
  // would only double what the agent pays for.
  if (message.op === "read_text") {
    let scope = null;
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source);
      if (refused) return refused;
      scope = resolveRef(message.uid);
    }
    const offset = Math.min(Math.max(Math.round(Number(message.offset) || 0), 0), 5_000_000);
    // `expand` is page-level by definition (scrolling loads content relative
    // to the viewport, not one element); the server refuses uid+expand, and
    // ignoring expand here keeps a mixed call honest rather than wrong.
    const full =
      message.expand && !scope ? await buildExpandedPageText(tab) : await buildPageText(tab, scope);
    return {
      ok: true,
      pageText: full.slice(offset, offset + READ_TEXT_MAX),
      pageTextOffset: Math.min(offset, full.length),
      pageTextTotal: full.length,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "screenshot") {
    const shot = await captureShot(tab, message);
    return {
      ok: true,
      ...shot,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
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
  } else if (message.op === "click_at" && typeof message.uid === "string" && message.uid) {
    // uid mode: a RELATIVE position inside a known element. No screenshot is
    // involved, so this is the escape hatch that still works for a canvas or a
    // map when the conversation's model cannot receive images at all.
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    const ref = resolveRef(message.uid);
    const { target, quads } = await quadsOf(ref);
    if (!quads.length) {
      return { ok: false, message: "The element is not visible on screen, so it cannot be clicked." };
    }
    const xs = [];
    const ys = [];
    for (const quad of quads) {
      for (let i = 0; i < quad.length; i += 2) {
        xs.push(quad[i]);
        ys.push(quad[i + 1]);
      }
    }
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const width = Math.max(...xs) - minX;
    const height = Math.max(...ys) - minY;
    // Clamp a pixel inside the box, so fraction 0 or 1 still lands ON the
    // element rather than on whatever owns its border.
    const inside = (start, span, fraction) =>
      Math.min(Math.max(start + fraction * span, start + 1), start + Math.max(span - 1, 0));
    const px = inside(minX, width, clampFraction(message.xFraction));
    const py = inside(minY, height, clampFraction(message.yFraction));
    // describePoint hit-tests in ROOT-session coordinates. A child frame's
    // quads are frame-relative, so asking there would name a different element
    // with total confidence — no description beats a false one.
    if (!ref.sessionId) landedOn = await describePoint(tab.id, px, py);
    await raceDialogOpen(tab.id, clickPoint(target, px, py));
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "click_at") {
    const x = message.x;
    const y = message.y;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0
    ) {
      return {
        ok: false,
        message:
          "click_at needs numeric, non-negative `x` and `y` — pixel coordinates measured on the most recent viewport screenshot.",
      };
    }
    if (!lastShot || lastShot.tabId !== tab.id) {
      return {
        ok: false,
        message:
          "No screenshot of THIS tab to take coordinates from. Take a fresh mcp__browser__screenshot of the viewport " +
          "(no uid, no fullPage) first — click_at coordinates are pixel positions measured on that image.",
      };
    }
    if (lastShot.mode !== "viewport") {
      return {
        ok: false,
        message:
          `The most recent screenshot captured ${lastShot.mode === "fullPage" ? "the full page" : "a single element"}, ` +
          "whose pixels do not map onto viewport click coordinates. Take a plain viewport screenshot " +
          "(no uid, no fullPage), then pass pixel positions measured on that image.",
      };
    }
    const imageWidth = Math.round(lastShot.clipWidth * lastShot.scale);
    const imageHeight = Math.round(lastShot.clipHeight * lastShot.scale);
    if (x > imageWidth || y > imageHeight) {
      return {
        ok: false,
        message:
          `(${x}, ${y}) is outside the most recent screenshot image (${imageWidth}×${imageHeight}px). ` +
          "Coordinates are pixel positions on that image — take a fresh viewport screenshot if the page changed.",
      };
    }
    // Drift check: the mapping is only valid while the page still shows what
    // the capture showed. A scroll, resize, or navigation moves DIFFERENT
    // content under the same image pixel — and a stale image size would even
    // pass the bounds check above — so refuse rather than click something the
    // model never saw. (±2px absorbs subpixel scroll jitter.)
    const nowMetrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
    const nowView = nowMetrics.cssVisualViewport || nowMetrics.cssLayoutViewport || {};
    const drifted =
      (tab.url || "") !== lastShot.url ||
      Math.abs((nowView.pageX || 0) - lastShot.pageX) > 2 ||
      Math.abs((nowView.pageY || 0) - lastShot.pageY) > 2 ||
      Math.abs((nowView.clientWidth || 0) - lastShot.clipWidth) > 2 ||
      Math.abs((nowView.clientHeight || 0) - lastShot.clipHeight) > 2;
    if (drifted) {
      return {
        ok: false,
        message:
          "The page has navigated, scrolled, or resized since that screenshot was taken, so its pixel coordinates " +
          "no longer point at the same content. Take a fresh viewport screenshot and measure the position again.",
      };
    }
    // The capture downscaled CSS pixels by `scale`; invert it to land on the
    // exact point the model saw, clamped a hair inside the viewport so an
    // exact-edge coordinate still hits the page. A viewport capture's image
    // origin IS the viewport origin, so no offset applies (enforced above).
    // Hit-test BEFORE clicking: the click itself may change what sits there.
    const cssX = Math.min(x / lastShot.scale, lastShot.clipWidth - 1);
    const cssY = Math.min(y / lastShot.scale, lastShot.clipHeight - 1);
    landedOn = await describePoint(tab.id, cssX, cssY);
    await raceDialogOpen(tab.id, clickPoint({ tabId: tab.id }, cssX, cssY));
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "type") {
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    await raceDialogOpen(
      tab.id,
      typeRef(message.uid, message.text || "", Boolean(message.submit), Boolean(message.keystrokes)),
    );
    if (message.submit) await waitForLoad(tab.id, 5000);
  } else if (message.op === "fill_form") {
    const fields = Array.isArray(message.fields) ? message.fields : [];
    if (!fields.length) {
      return {
        ok: false,
        message: "fill_form needs a non-empty `fields` array of { uid, value } entries.",
      };
    }
    for (let i = 0; i < fields.length; i += 1) {
      if (pendingDialogs.has(tab.id)) break; // frozen — the tail reports the open dialog
      const field = fields[i] || {};
      const uid = String(field.uid || "");
      const refused = await assertRefTabUsable(uid, patterns, source);
      if (refused) return refused;
      try {
        await raceDialogOpen(
          tab.id,
          fillField(resolveRef(uid), String(field.value ?? ""), Boolean(field.clear)),
        );
      } catch (error) {
        // Partial progress is real progress: say exactly where it stopped so
        // the agent re-snapshots and continues instead of re-filling from zero.
        return {
          ok: false,
          message:
            `Field ${i + 1} of ${fields.length} (uid "${uid}") could not be filled: ${String(error?.message || error)} ` +
            "Fields before it were already filled — take a fresh snapshot and continue from there.",
        };
      }
    }
  } else if (message.op === "select_option") {
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    await raceDialogOpen(tab.id, selectOption(message.uid, String(message.option ?? "")));
    // A change handler can submit or navigate, same as a click.
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "press_key") {
    let target = { tabId: tab.id };
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source);
      if (refused) return refused;
      const ref = resolveRef(message.uid);
      target = { tabId: ref.tabId, sessionId: ref.sessionId };
      await focusForInput(ref);
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
      sendCdp(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
        pointerType: "mouse",
      }),
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

  // Let an action's async effect land before reading the page back. Without
  // this, typing a query returned a snapshot with no autocomplete layer in it
  // and the next identical call showed one — the action looked like a no-op.
  if (SETTLE_OPS.has(message.op)) {
    await new Promise((resolve) => setTimeout(resolve, ACTION_SETTLE_MS));
  }

  // Re-check where we actually LANDED before reading the page: a permitted URL
  // can redirect somewhere denied, and the snapshot is the exfiltration path
  // that matters (reading a logged-in page is the risk, not just acting on it).
  const fresh = await chrome.tabs.get(tab.id);
  if (fresh.url && !originAllowed(fresh.url, patterns)) return refuseOrigin(fresh.url, source);

  // A dialog may have opened as a RESULT of the action (click → confirm). The
  // snapshot walk would hang on the frozen renderer — report the dialog
  // instead, keeping what a coordinate click landed on: the confirm() case is
  // exactly when knowing what was clicked matters most.
  if (pendingDialogs.has(tab.id)) {
    return { ...(await dialogBlockedResult(fresh)), ...(landedOn ? { landedOn } : {}) };
  }

  // Cap the snapshot uid-first: an uncapped long page fails the whole model
  // turn, which made merely REACHING such a page count as an error. wait_for's
  // internal matching above deliberately uses the uncapped walk.
  let snapshot = "";
  let snapshotError;
  try {
    snapshot = capSnapshot(await buildSnapshot(fresh));
  } catch (error) {
    // The ACTION already happened. Reporting the whole op as failed because
    // the read-back broke made the agent retry it — navigating twice, clicking
    // twice. Say the action ran and the view is missing, separately.
    snapshotError = String(error?.message || error);
  }
  // Always report the group's tabs: the agent needs to know a new tab appeared
  // (or that several are open) without spending a separate list_tabs round trip.
  return {
    ok: true,
    snapshot,
    ...(snapshotError ? { snapshotError } : {}),
    url: fresh.url,
    title: fresh.title,
    tabs: (await groupedTabs()).map(describeTab),
    ...(landedOn ? { landedOn } : {}),
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
