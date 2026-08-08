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

import {
  renderAxTree,
  renderAxText,
  capSnapshot,
  mergeTextLines,
  axProp,
  axValueAnswer,
  clearFailed,
  unlabeledInteractiveIds,
} from "./axtree.js";

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
 * `Page.getFrameTree` reads the frame STRUCTURE (ids only, no content) so
 * same-process iframes can be walked at all, `DOM.getFrameOwner` answers the
 * other half of that structure question — which element OWNS a given frame — so
 * a frame's content block can name the `Iframe` line it belongs to, and
 * `Accessibility.getPartialAXTree` reads ONE node — the same exfiltration class
 * as the getFullAXTree already here, and strictly less of it. It exists so a
 * clearing write can be VERIFIED by reading the field back instead of claiming
 * success on faith, the line select_option already draws.
 */
const CDP_ALLOWLIST = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.describeNode",
  "DOM.enable",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getFrameOwner",
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

chrome.storage.onChanged.addListener((_changes, areaName) => {
  // The SESSION area holds only the bridge's own working-tab pointer — a policy
  // push never lands there, and dropping the cache on every tab switch would
  // re-read managed storage for nothing.
  if (areaName !== "session") policyCache = null;
});

/** tabId -> { children: Map<sessionId, frameId> } — the OOPIF sessions of a tab. */
const attached = new Map();

/**
 * `${tabId}:${sessionId||"root"}` -> how many DOCUMENTS that session has shown.
 *
 * Chrome REUSES backendNodeIds across documents in a tab, so after a navigation
 * a remembered uid still RESOLVES — to whatever element inherited the number.
 * In the field `[e15] link "메일"` on finance.naver.com became
 * `button "Add Element"` on the next page, and the tool's "a uid keeps pointing
 * at the same element" contract broke with no error anywhere. Namespacing uids
 * by tab+session was never enough because the reuse happens INSIDE one session;
 * the epoch is the missing component, and comparing it at resolve time is what
 * turns a silent wrong-element action into an explicit "take a fresh snapshot".
 *
 * Wiped with the worker, which is safe: refMap is module state too, so a restart
 * loses every uid before it can lose an epoch.
 */
const docEpochs = new Map();

function docKey(tabId, sessionId) {
  return `${tabId}:${sessionId || "root"}`;
}

function docEpoch(tabId, sessionId) {
  return docEpochs.get(docKey(tabId, sessionId)) || 0;
}

function bumpDocEpoch(tabId, sessionId) {
  const key = docKey(tabId, sessionId);
  docEpochs.set(key, (docEpochs.get(key) || 0) + 1);
}

/**
 * uid -> { tabId, sessionId, backendNodeId, epoch }, and its reverse index.
 * STABLE ACROSS SNAPSHOTS by design: these used to reset on every buildSnapshot, so
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
 * nodeKey -> DOM hint for an interactive element the accessibility tree cannot
 * name (see buildDomHint). Keyed exactly like uidByNode and swept with it, so a
 * hint can never outlive its tab and get printed against a stranger. An empty
 * string means "asked, nothing useful" and is CACHED: a miss costs the same
 * round trip as a hit, and refetching it every snapshot would spend the whole
 * per-snapshot budget on the same handful of nodes.
 */
const hintByNode = new Map();

/**
 * Ceiling on remembered uids. A long-lived worker crawling many pages would
 * otherwise grow both maps without bound; past this, everything is forgotten
 * at the start of a snapshot and agents recover through the ordinary
 * unknown-uid error. `refSeq` deliberately keeps counting — reusing numbers
 * would reintroduce exactly the wrong-element bug this map exists to prevent.
 */
const REF_MAP_MAX = 30000;

/** Keyed by DOCUMENT, not just by session — see docEpochs for why. */
function nodeKey(tabId, sessionId, epoch, backendNodeId) {
  return `${tabId}:${sessionId || "root"}:${epoch}:${backendNodeId}`;
}

/** The uid for a node, minting one only the first time it is seen. */
function mintUid(tabId, sessionId, backendNodeId) {
  const epoch = docEpoch(tabId, sessionId);
  const key = nodeKey(tabId, sessionId, epoch, backendNodeId);
  const known = uidByNode.get(key);
  if (known) return known;
  const uid = `e${++refSeq}`;
  refMap.set(uid, { tabId, sessionId, backendNodeId, epoch });
  uidByNode.set(key, uid);
  return uid;
}

/** Forget one tab's elements: nothing there is addressable once it is gone. */
function forgetTabRefs(tabId) {
  for (const [uid, ref] of refMap) {
    if (ref.tabId !== tabId) continue;
    refMap.delete(uid);
    uidByNode.delete(nodeKey(ref.tabId, ref.sessionId, ref.epoch, ref.backendNodeId));
  }
  // Swept by key prefix rather than through refMap: a cached hint must go even
  // if its uid was already evicted. Tab ids are integers, so "12:" never
  // matches "123:…". Epochs share the shape, so one prefix sweeps both.
  const prefix = `${tabId}:`;
  for (const key of hintByNode.keys()) {
    if (key.startsWith(prefix)) hintByNode.delete(key);
  }
  for (const key of docEpochs.keys()) {
    if (key.startsWith(prefix)) docEpochs.delete(key);
  }
}

/**
 * tabId -> the snapshot TEXT last returned for that tab. An action that really
 * did mutate the DOM has come back with a BYTE-IDENTICAL snapshot (see
 * flushLifecycle), and identical-to-last is the only cheap signal that the read
 * was too early. One entry per GROUPED tab, dropped when the tab closes; module
 * state, so a worker restart just skips one re-poll.
 */
const lastSnapshotByTab = new Map();

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
  attached.set(tabId, { children: new Map() });
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
  // For an iframe target the targetId IS the frameId, and it is the only place
  // that mapping is offered: it names the document behind this session, which
  // the epoch check needs (which frameNavigated is this session's ROOT?) and
  // the frame labeller needs (which <iframe> element owns this tree?).
  entry.children.set(params.sessionId, params.targetInfo?.targetId || "");
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

/**
 * A new DOCUMENT in a session's root frame retires every uid minted against the
 * old one. Only cross-document navigations fire this — an SPA route change is
 * `Page.navigatedWithinDocument`, where the ids genuinely do stay put — so the
 * epoch moves exactly when the numbering can restart underneath us.
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.frameNavigated" || source.tabId == null) return;
  const frameId = params?.frame?.id;
  const isSessionRoot = source.sessionId
    ? attached.get(source.tabId)?.children?.get(source.sessionId) === frameId
    : !params?.frame?.parentId;
  if (isSessionRoot) bumpDocEpoch(source.tabId, source.sessionId);
});

// Clicking Chrome's own "cancel" on the debugging banner, or any other detach,
// must drop our state rather than leave stale sessions that fail confusingly.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId);
    pendingDialogs.delete(source.tabId);
    // Detached means UNOBSERVED: a navigation during the gap raises no
    // frameNavigated, so the epoch can no longer vouch for the ids minted before
    // it. Bump rather than trust — a needless "take a fresh snapshot" costs one
    // round trip, a uid that silently addresses a stranger costs the whole task.
    // Only this session's document needs it: the child sessions died with the
    // detach and their ids are not reused, so their refs already fail loudly.
    bumpDocEpoch(source.tabId, source.sessionId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  pendingDialogs.delete(tabId);
  forgetTabRefs(tabId);
  lastSnapshotByTab.delete(tabId);
  if (currentTabId === tabId) setCurrentTab(null);
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
 *
 * Sticky was never the whole story: this is MV3 service-worker state, and the
 * worker idles out BETWEEN TURNS. The pointer came back null on the next turn
 * and the fallback picked tabs[0] — the OLDEST tab in the group, which is
 * typically the user's own — so a `navigate` overwrote the page they were
 * reading. The mirror in chrome.storage.session survives the worker restart and
 * dies with the browser session, which is exactly the lifetime a working tab has.
 */
let currentTabId = null;
const WORKING_TAB_KEY = "workingTabId";

/** Point at a tab (or forget one), in module state AND across worker restarts. */
function setCurrentTab(tabId) {
  currentTabId = tabId;
  // Fire and forget: the module state is already correct, and a storage failure
  // must degrade to "forgets between turns" rather than fail the operation.
  const write =
    tabId == null
      ? chrome.storage.session.remove(WORKING_TAB_KEY)
      : chrome.storage.session.set({ [WORKING_TAB_KEY]: tabId });
  Promise.resolve(write).catch(() => {});
}

async function storedTabId() {
  try {
    const stored = await chrome.storage.session.get(WORKING_TAB_KEY);
    const id = stored?.[WORKING_TAB_KEY];
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/**
 * BRIDGE-authored caveat about WHICH TAB the bridge is on, left here by
 * targetTab and drained by perform() into the result's `note`. A guess about the
 * working tab has to be visible in the same turn it is made — the field failure
 * was silent drift, not a wrong answer.
 */
let pendingTabNotice = "";

function takeTabNotice() {
  const notice = pendingTabNotice;
  pendingTabNotice = "";
  return notice;
}

async function targetTab() {
  const tabs = await groupedTabs();
  if (!tabs.length) throw new Error(NO_TAB_MESSAGE);
  if (currentTabId == null) {
    const stored = await storedTabId();
    // Validated against the group like any other pointer: a stored id whose tab
    // was closed or dragged out grants nothing.
    if (stored != null && tabs.some((tab) => tab.id === stored)) currentTabId = stored;
  }
  const picked = tabs.find((tab) => tab.id === currentTabId);
  if (picked) return picked;
  // FALLING BACK: nothing was ever chosen, or the chosen tab is gone. tabs[0] is
  // the oldest tab in the group, so with more than one candidate this is a guess
  // — and the guess is the drift itself, so it must be said out loud.
  const fallback = tabs[0];
  if (tabs.length > 1) {
    pendingTabNotice =
      `No working tab was remembered, so this operation ran on the OLDEST of the ${tabs.length} tabs in the group: ` +
      `tabId ${fallback.id}, "${quoteForNote(fallback.title || "(untitled)")}" — ` +
      `${quoteForNote(fallback.url, NOTE_URL_MAX)}. That tab may be the user's own rather than the one you were ` +
      "working in; if it is not the one you meant, call mcp__browser__list_tabs and mcp__browser__select_tab before acting further.";
  }
  setCurrentTab(fallback.id);
  return fallback;
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

function policySource(source) {
  return source === "managed"
    ? "The site is not in the administrator's browser-control policy."
    : source === "local"
      ? "The site is not in this browser's local allowlist (extension options page)."
      : "No browser-control allowlist is configured yet, so every site is denied.";
}

/**
 * The tab is not on a WEB page at all — ANOTHER extension took it over. The
 * field case is a PDF-viewer extension (Adobe's) intercepting a .pdf navigation:
 * the tab lands on `chrome-extension://…`, and calling that "not in the
 * allowlist" sent the agent hunting for a different URL to reach the same
 * document, when no allowlist change could ever help. Null when the URL is an
 * ordinary denied site, so the caller falls through to its normal refusal.
 */
function hijackRefusal(rawUrl) {
  if (!String(rawUrl || "").startsWith("chrome-extension://")) return null;
  return (
    `This tab is showing a page that belongs to ANOTHER browser extension (${rawUrl}) — most often a PDF-viewer ` +
    "extension that intercepted a PDF link. The bridge cannot read or drive pages inside other extensions, and this " +
    "is not an allowlist decision, so no policy change would open it. Recover with mcp__browser__navigate to an " +
    "allowed http(s) URL (that op still works from here) or open a fresh page with mcp__browser__new_tab, and tell " +
    "the user their PDF opened in their PDF-viewer extension."
  );
}

/** Refusal text is model-facing: say what happened and close off the retry. */
function refuseOrigin(rawUrl, source) {
  const hijacked = hijackRefusal(rawUrl);
  if (hijacked) return { ok: false, message: hijacked };
  return {
    ok: false,
    message:
      `${policySource(source)} Blocked: ${rawUrl}. Tell the user which site was blocked and who can change it; ` +
      "do not try a different URL to reach the same content.",
  };
}

/**
 * The POST-action landing refusal, which is a different fact from the pre-action
 * one: the op RAN and the tab MOVED. Wording it like a refusal ("blocked") made
 * the agent read a completed navigation as a failure and do it again, so this
 * says what happened first and what is still possible second.
 */
function refuseLanding(op, rawUrl, source) {
  const hijacked = hijackRefusal(rawUrl);
  if (hijacked) {
    return { ok: false, message: `The ${op} itself completed, and then: ${hijacked}` };
  }
  return {
    ok: false,
    message:
      `The ${op} itself completed and the tab now sits at ${rawUrl}, which is outside the allowlist, so no page ` +
      `content is returned. ${policySource(source)} Do not repeat the ${op} — it already happened. Move on with ` +
      "mcp__browser__navigate to an allowed URL (navigation is not blocked by a denied current page), and tell the " +
      "user where the tab ended up.",
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
 * `{ target, frameId?, docFrameId? }` sources.
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
      docFrameId: frameId,
    })),
    // `docFrameId` names the DOCUMENT a source renders, for the frame labeller.
    // It is separate from `frameId` on purpose: `frameId` is an argument to
    // getFullAXTree (which asks the ROOT session for one of ITS frames), while an
    // OOPIF's session already IS that document and must not be asked that way.
    ...[...(entry?.children || [])].map(([sessionId, frameId]) => ({
      target: { tabId: tab.id, sessionId },
      docFrameId: frameId,
    })),
  ];
}

/**
 * Force a document lifecycle tick before reading the accessibility tree.
 *
 * Chrome updates its AXObject tree LAZILY, and nothing in the snapshot path used
 * to pump it: on an IDLE tab (no animation, no further input) getFullAXTree
 * answered from a tree that predated the DOM change the action had just made.
 * The field failure was a click on "Add Element" that reported success while the
 * new <button> stayed missing from snapshot, read_text and wait_for for many
 * seconds — intermittent only because a page with a running animation flushes
 * itself. Page.getLayoutMetrics is the cheapest ALLOWLISTED call that forces the
 * tick, which is also why screenshots and quad reads never showed this bug.
 *
 * Non-fatal by design: a mid-navigation or dying target throws here, and a
 * snapshot that skips the flush is exactly the previous behavior.
 */
async function flushLifecycle(target) {
  try {
    await sendCdp(target, "Page.getLayoutMetrics", {});
  } catch {
    // Nothing to flush (navigating, detached, closed); the walk continues.
  }
}

/**
 * Per-snapshot `f1, f2 …` labels for the child-frame trees, resolved to the
 * `<iframe>` element that OWNS each one.
 *
 * A child frame renders as its own detached `RootWebArea` block appended after
 * the main tree, and nothing said which `Iframe` line it belonged to — on a page
 * with several (naver map) there was no way to tell the search panel's frame from
 * the map's. One label rides BOTH ends: the renderer appends it to the owner's
 * line and the block gets a `frame f1:` header.
 *
 * `DOM.getFrameOwner` is read-only structure (frameId → the owning element's
 * backendNodeId), the same class as Page.getFrameTree. It is asked on the ROOT
 * target only — which is also why the map is handed to root-target renders only:
 * backendNodeIds are unique per TARGET, so an id resolved in the root process
 * names a DIFFERENT node inside an OOPIF's session, and labelling a stranger is
 * worse than labelling nothing. A frame whose owner will not resolve (a nested
 * OOPIF, a frame that died mid-walk) simply goes unlabelled.
 */
async function labelFrames(tab, sources) {
  const byOwner = new Map();
  const labelBySource = new Map();
  let seq = 0;
  for (const source of sources) {
    if (!source.docFrameId) continue;
    try {
      const { backendNodeId } = await sendCdp({ tabId: tab.id }, "DOM.getFrameOwner", {
        frameId: source.docFrameId,
      });
      if (backendNodeId == null) continue;
      const label = `f${++seq}`;
      byOwner.set(backendNodeId, label);
      labelBySource.set(source, label);
    } catch {
      // The frame is gone, or its owner lives in another process's document.
    }
  }
  return { byOwner, labelBySource };
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

/**
 * Uncached DOM-hint lookups one snapshot may spend. Each is a round trip, and a
 * page can hold dozens of unlabeled controls; the cache means later snapshots
 * pick up where this one stopped rather than re-asking about the same nodes.
 */
const HINT_FETCH_PER_SNAPSHOT = 8;

/**
 * DOM hints for the nodes in one source the AX tree could not name at all,
 * newly fetched ones bounded by `budget`. Returns the map renderAxTree prints
 * from and how much budget is left.
 */
async function collectDomHints(source, nodes, budget) {
  const hints = new Map();
  let left = budget;
  // Same document key the uids use, so a hint cached against a backendNodeId the
  // NEXT page reused cannot be printed against the stranger that inherited it.
  const epoch = docEpoch(source.target.tabId, source.target.sessionId);
  for (const backendNodeId of unlabeledInteractiveIds(nodes)) {
    const key = nodeKey(source.target.tabId, source.target.sessionId, epoch, backendNodeId);
    let hint = hintByNode.get(key);
    if (hint === undefined) {
      if (left <= 0) continue;
      left -= 1;
      hint = await buildDomHint(source.target, backendNodeId);
      hintByNode.set(key, hint);
    }
    if (hint) hints.set(backendNodeId, hint);
  }
  return { hints, left };
}

/** The uid minter bound to one source's session — every render needs one. */
function mintForSource(source) {
  return (backendNodeId) => mintUid(source.target.tabId, source.target.sessionId, backendNodeId);
}

/** Walk every attached session and merge the accessibility trees into one view. */
async function buildSnapshot(tab) {
  if (refMap.size > REF_MAP_MAX) {
    refMap.clear();
    uidByNode.clear();
    hintByNode.clear();
  }
  await flushLifecycle({ tabId: tab.id });
  const sources = await axSources(tab);
  const { byOwner, labelBySource } = await labelFrames(tab, sources);
  const lines = [];
  let hintBudget = HINT_FETCH_PER_SNAPSHOT;
  for (const source of sources) {
    const nodes = await sourceAxNodes(source);
    if (!nodes) continue;
    const { hints, left } = await collectDomHints(source, nodes, hintBudget);
    hintBudget = left;
    const label = labelBySource.get(source);
    if (label) lines.push(`frame ${label}:`);
    // Frame nodes ride the session that fetched them; backendNodeIds are
    // unique per target, so click/type resolve unchanged.
    lines.push(
      ...renderAxTree(
        nodes,
        mintForSource(source),
        hints,
        // Owner ids were resolved in the ROOT target's id space — valid for
        // every source that renders that target, meaningless in an OOPIF's.
        { frameLabels: source.target.sessionId ? undefined : byOwner },
      ),
    );
  }
  return lines.join("\n");
}

/**
 * The source rendering the frame this element OWNS, or null when it owns none.
 *
 * The snapshot tool promises that an Iframe's uid scopes INTO that frame, and a
 * subtree walk cannot deliver it: the `<iframe>` ELEMENT and the frame's CONTENT
 * live in DIFFERENT accessibility trees. getFullAXTree stops at the frame
 * boundary (the same fact axSources exists for), so the element's subtree in the
 * parent tree is the lone `Iframe` node — scoping to it would answer one useless
 * line for the one uid an agent is most likely to scope by.
 *
 * `DOM.describeNode` settles it in a single round trip: `frameId` is populated on
 * frame OWNER elements and absent on everything else. Matching it against the
 * sources' `docFrameId` is sound from ANY session because a frameId is a
 * browser-global string — unlike the backendNodeIds `DOM.getFrameOwner` returns,
 * which only mean anything in the target that resolved them, and which would
 * therefore risk matching a stranger when the uid came from an OOPIF.
 */
async function frameSourceFor(ref, sources) {
  let frameId;
  try {
    const { node } = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "DOM.describeNode",
      { backendNodeId: ref.backendNodeId },
    );
    frameId = node?.frameId;
  } catch {
    return null; // not describable — the ordinary subtree walk still applies
  }
  if (!frameId) return null;
  return sources.find((source) => source.docFrameId === frameId) || null;
}

/**
 * One element's subtree, rendered like a snapshot — the `uid` form of the
 * snapshot op, so following up on a search-results list or a dialog costs a few
 * hundred characters instead of re-reading the whole page.
 *
 * Two shapes, because a uid can name either a piece of ONE document or the
 * BOUNDARY between two:
 *
 *   frame owner — render that frame's whole tree (see frameSourceFor).
 *   anything else — walk the subtree, mirroring buildPageText's scoped source
 *     strategy: the session that minted the uid first, then that session's
 *     same-process child frames, because an element can sit in a frame whose
 *     nodes are absent from the session's main tree. A tree that does not contain
 *     the start node answers null and the walk moves on.
 *
 * Deliberately does NOT run the REF_MAP_MAX reset buildSnapshot opens with:
 * clearing the map mid-op would evict the very uid being scoped by, and a
 * subtree mints few uids anyway.
 */
async function buildScopedSnapshot(tab, ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await flushLifecycle(target);
  const frameSource = await frameSourceFor(ref, await axSources(tab));
  if (frameSource) {
    // An OOPIF's document is a different target, so the parent's flush above did
    // nothing for it; give the tree we are about to read its own lifecycle tick.
    await flushLifecycle(frameSource.target);
    const nodes = await sourceAxNodes(frameSource);
    if (nodes) {
      const { hints } = await collectDomHints(frameSource, nodes, HINT_FETCH_PER_SNAPSHOT);
      // No startBackendNodeId: the frame's tree IS the requested scope, and
      // without one renderAxTree cannot answer null.
      return renderAxTree(nodes, mintForSource(frameSource), hints).join("\n");
    }
    // Attached but unreadable this instant (navigating, dying). Fall through, so
    // the answer is at least the Iframe element rather than an outright failure.
  }
  const sources = [
    { target },
    ...(await childFrameIds(target)).map((frameId) => ({ target, frameId })),
  ];
  for (const source of sources) {
    const nodes = await sourceAxNodes(source);
    if (!nodes) continue;
    const { hints } = await collectDomHints(source, nodes, HINT_FETCH_PER_SNAPSHOT);
    const lines = renderAxTree(nodes, mintForSource(source), hints, {
      startBackendNodeId: ref.backendNodeId,
    });
    if (lines === null) continue; // the start node is not in THIS tree — try the next
    return lines.join("\n");
  }
  throw new Error(
    "The element behind that uid is gone from the page. Take a fresh mcp__browser__snapshot without `uid` and use a current uid.",
  );
}

// -------------------------------------------------------------------- actions

function resolveRef(uid) {
  const ref = refMap.get(uid);
  if (!ref) {
    throw new Error(
      `Unknown element uid "${uid}". No current snapshot has minted it (or the extension restarted and forgot it) — take a fresh mcp__browser__snapshot and use a uid it prints.`,
    );
  }
  // The uid still RESOLVES after a navigation — that is the danger. Chrome hands
  // the new document the same backendNodeIds, so without this check the old uid
  // quietly operates on whatever inherited the number (a naver "메일" link became
  // an "Add Element" button, with no error anywhere).
  if (ref.epoch !== docEpoch(ref.tabId, ref.sessionId)) {
    throw new Error(
      `The element uid "${uid}" belongs to a PREVIOUS page in that tab — it has navigated since the snapshot that ` +
        "minted it, and uids do not survive a navigation (the browser reuses its internal node ids, so acting on this " +
        "one would hit an unrelated element). Take a fresh mcp__browser__snapshot and use a uid it prints.",
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
    const uid = uidByNode.get(nodeKey(ref.tabId, ref.sessionId, ref.epoch, ref.backendNodeId));
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
/**
 * Second look when a settled action's snapshot came back BYTE-IDENTICAL to the
 * one before it. Chrome's AX flush can land after the lifecycle tick
 * flushLifecycle forces, and one bounded re-poll is the difference between
 * reporting "the click did nothing" and the truth.
 */
const STALE_SNAPSHOT_REPOLL_MS = 250;

/**
 * The snapshot op's `maxChars`, clamped. The floor keeps a request from asking
 * for a snapshot too small to hold any uid line; the ceiling is the point past
 * which the default cap is the better answer anyway.
 *
 * Type-checked rather than coerced, for the same reason clampFraction is: an
 * omitted field arrives on the wire as `null`, and `Number(null)` is 0 — finite,
 * so a coercing version would read "not asked" as "clamp me to the floor" and
 * silently truncate every snapshot to the minimum.
 */
const SNAPSHOT_CHARS_MIN = 2000;
const SNAPSHOT_CHARS_MAX = 30000;

function clampSnapshotChars(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.round(value), SNAPSHOT_CHARS_MIN), SNAPSHOT_CHARS_MAX);
}

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

/** A described DOM node's attributes as an object — CDP hands them back flat. */
function flatAttrs(node) {
  const attrs = {};
  const flat = node?.attributes || [];
  for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i]] = flat[i + 1];
  return attrs;
}

/**
 * First non-empty text anywhere in a described subtree, so a wrapper like
 * `<button><span>Save</span></button>` still yields a label.
 */
function firstDomText(nodes) {
  for (const child of nodes || []) {
    if (child.nodeName === "#text" && (child.nodeValue || "").trim()) {
      return child.nodeValue.trim();
    }
    const nested = firstDomText(child.children);
    if (nested) return nested;
  }
  return "";
}

/** Cap for a printed DOM hint: enough to tell two controls apart, never a dump. */
const HINT_MAX_CHARS = 60;

/**
 * A short DOM identifier for an interactive element the accessibility tree
 * cannot name — the last thing that tells `[e48] button ""` from
 * `[e49] button ""` once name, value AND title are all empty. Read-only
 * (`DOM.describeNode`, already allowlisted for describePoint).
 *
 * Priority is "what a person would quote to a colleague": `#id`, else the first
 * two class tokens, else an input's `type`, else the label of the icon inside it
 * (the depth-2 subtree is already in hand, so this costs no extra round trip).
 * Any failure returns "" — a missing hint is the status quo, never an error.
 * The result is page-derived text riding inside the snapshot, which is already
 * quarantined as untrusted, so it needs no wrapper of its own.
 */
async function buildDomHint(target, backendNodeId) {
  try {
    const { node } = await sendCdp(target, "DOM.describeNode", { backendNodeId, depth: 2 });
    if (!node) return "";
    const clip = (value) => String(value).replace(/\s+/g, " ").trim().slice(0, HINT_MAX_CHARS);
    const attrs = flatAttrs(node);
    if (attrs.id) return clip(`#${attrs.id}`);
    const classes = String(attrs.class || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (classes.length) return clip(`.${classes.join(".")}`);
    if (attrs.type) return clip(`type=${attrs.type}`);
    const findIcon = (items) => {
      for (const child of items || []) {
        const tag = String(child.nodeName || "").toLowerCase();
        if (tag === "img" || tag === "svg") return child;
        const nested = findIcon(child.children);
        if (nested) return nested;
      }
      return null;
    };
    const icon = flatAttrs(findIcon(node.children));
    const label = icon.alt || icon["aria-label"] || icon.title || firstDomText(node.children);
    return label ? clip(label) : "";
  } catch {
    return "";
  }
}

/**
 * Best-effort description of the element at a point — the blind spot of a
 * coordinate click. Read-only (`DOM.getNodeForLocation` + `describeNode`); any
 * failure degrades to "no description", never to a failed click. When a
 * root-session hit test lands in a cross-origin frame it resolves the <iframe>
 * element itself, which is still an honest answer.
 *
 * `target` is the session the coordinates BELONG TO ({tabId} for the root,
 * {tabId, sessionId} for a frame — both have DOM enabled: ensureAttached for
 * the tab, the auto-attach handler for each child). Asking the wrong session
 * is not a silent lie: the containment cross-check below fails and the answer
 * degrades to null.
 */
async function describePoint(target, x, y) {
  try {
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
    const attrs = flatAttrs(node);
    const label =
      attrs["aria-label"] ||
      attrs.title ||
      attrs.alt ||
      attrs.placeholder ||
      firstDomText(node.children);
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
 * Select everything in the focused element, the way a person does AND the way
 * the editor itself does.
 *
 * The keystroke alone was not enough: on a script-controlled combobox
 * (map.naver.com's React search box) Ctrl+A silently did nothing, so the insert
 * that followed APPENDED — "광교" + "카페거리" became "광교카페거리" instead of
 * replacing. `commands: ["selectAll"]` is CDP's escape hatch into the Blink
 * editor command the shortcut would have triggered: it runs in the focused
 * element directly, without depending on our synthetic key fields being
 * interpreted by the platform keymap. The key fields stay exactly as dispatchKey
 * would have sent them so a page listening for ⌘A/Ctrl+A still sees a plausible
 * event, and the paired keyUp carries no command — an editor command runs once,
 * on the way down.
 *
 * It is NOT a guarantee, which is exactly why the read-back below exists: the
 * command still travels through the default keydown handler, so a page that
 * preventDefault()s the shortcut defeats this too (verified against one that
 * does). Selecting nothing is invisible at this layer — only reading the field
 * afterwards can tell.
 */
async function selectAllIn(target) {
  // Blink maps the select-all editing command per platform.
  const modifiers = (await platformOs()) === "mac" ? MODIFIER_BITS.Meta : MODIFIER_BITS.Control;
  const key = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 };
  await sendCdp(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers,
    ...key,
    commands: ["selectAll"],
  });
  await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...key });
}

/**
 * What the accessibility tree reports as one element's CURRENT value: one node,
 * read-only, no relatives. It exists so a clearing write can be verified instead
 * of assumed, and it answers three ways — the text, "" for a genuinely empty
 * field, or null when verification is UNAVAILABLE here (`axValueAnswer` in
 * `axtree.js` holds that decision and the reasons it is a three-way one; a null
 * from THIS layer additionally covers an older Chrome without the method, or a
 * node that just detached). See `resolveValueNode` for what to do about null.
 */
async function readAxValue(ref) {
  try {
    const { nodes } = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "Accessibility.getPartialAXTree",
      { backendNodeId: ref.backendNodeId, fetchRelatives: false },
    );
    const list = Array.isArray(nodes) ? nodes : [];
    // Prefer the node we ASKED about; an ignored relative can ride along.
    return axValueAnswer(list.find((one) => one?.backendDOMNodeId === ref.backendNodeId) || list[0]);
  } catch {
    return null;
  }
}

/** DOM elements that OWN a text value the accessibility tree can report. */
const VALUE_NODE_NAMES = new Set(["INPUT", "TEXTAREA"]);
/** Nodes inspected while hunting for a field's value-bearing element. */
const VALUE_NODE_SCAN_MAX = 300;

/** True for a DOM.Node that is a text field or an explicitly editable element. */
function ownsTextValue(node) {
  if (VALUE_NODE_NAMES.has(node?.nodeName)) return true;
  // DOM.Node.attributes is a FLAT name,value,name,value… array.
  const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] === "contenteditable" && String(attributes[i + 1]).toLowerCase() !== "false") {
      return true;
    }
  }
  return false;
}

/**
 * The ref whose AX node actually CARRIES a value, so the clear below can be
 * verified: the ref itself when it reads, otherwise its first text-field
 * descendant. The `role="combobox"` wrapper is the shape that forced this — the
 * uid an agent addresses is the wrapper, the text lives in an <input> inside it,
 * and reading the wrapper answers "nothing readable".
 *
 * Returns `{ ref, value }` (the value already read, so the caller's `before`
 * costs no second round trip), or null when NO readable node was found — which
 * every caller treats as "verification unavailable", never as "the field is empty".
 *
 * Structure only (`DOM.describeNode`, already allowed), nothing cached: a clear
 * is rare, so paying the walk beats holding ids that can go stale. Deliberately
 * does NOT descend into `contentDocument`: an iframe's input is a DIFFERENT
 * field, and verifying against the wrong field would invent failures.
 */
async function resolveValueNode(ref) {
  const own = await readAxValue(ref);
  if (own !== null) return { ref, value: own };
  let root = null;
  try {
    const described = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "DOM.describeNode",
      { backendNodeId: ref.backendNodeId, depth: -1, pierce: true },
    );
    root = described?.node || null;
  } catch {
    return null;
  }
  // Breadth-first, so the SHALLOWEST field wins on a wrapper holding several.
  const queue = root ? [root] : [];
  let seen = 0;
  while (queue.length && seen < VALUE_NODE_SCAN_MAX) {
    const node = queue.shift();
    seen += 1;
    if (node !== root && typeof node?.backendNodeId === "number" && ownsTextValue(node)) {
      const candidate = { ...ref, backendNodeId: node.backendNodeId };
      const value = await readAxValue(candidate);
      if (value !== null) return { ref: candidate, value };
    }
    for (const child of node?.children || []) queue.push(child);
    // A web component hides its real <input> in a shadow root, and the value the
    // AX tree reports lives THERE, so the walk has to reach inside.
    for (const shadow of node?.shadowRoots || []) queue.push(shadow);
  }
  return null;
}

/** Enter text at the caret the way the field expects (IME for non-ASCII). */
async function insertValue(target, value) {
  if (needsComposition(value)) {
    await insertTextAsIme(target, value);
  } else {
    await sendCdp(target, "Input.insertText", { text: value });
  }
}

/** A page can sync its own model back into the field a beat after the events. */
const VALUE_SETTLE_MS = 150;
/** Backspaces the clearing fallback may press: a field is not a document. */
const CLEAR_BACKSPACE_MAX = 300;
/** How much of a page-derived value a bridge note may quote. */
const NOTE_VALUE_MAX = 80;
/** URLs get more room than values: a truncated one is not a URL at all. */
const NOTE_URL_MAX = 120;
/** A bridge note rides into the model turn like any other field: one paragraph. */
const NOTE_MAX = 480;

/**
 * Quote a page-derived value inside a bridge note. A note is rendered OUTSIDE
 * the untrusted wrapper, so whatever it embeds is pre-sliced here, at the source.
 */
function quoteForNote(value, max = NOTE_VALUE_MAX) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

/** Keep a note (or several, joined) inside its budget. */
function capNote(note) {
  const text = String(note || "");
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX)}…` : text;
}

/** Read the field back once the page has had its beat to re-assert its model. */
async function settledValue(valueNode) {
  await new Promise((resolve) => setTimeout(resolve, VALUE_SETTLE_MS));
  return readAxValue(valueNode);
}

/**
 * Rewrite the whole field through the IME REPLACEMENT RANGE: compose `value`
 * over the range the old text occupies, then commit it. Depends on NEITHER a
 * selection nor a keymap — Blink's IME pipeline fires real
 * beforeinput/input events, which is what a controlled input accepts — so it is
 * the one clearing path that survives a page which consumed our ⌘A/Ctrl+A.
 * Measured against a controlled input that does exactly that
 * (`tests/visual/clear-ladder.spec.ts`): the select-all rung leaves the old
 * value, this one replaces it.
 *
 * false means the browser refused the composition (no IME-capable focus, an
 * older Chrome) — the caller falls through to the keyboard rung.
 */
async function imeRewrite(target, value, current) {
  try {
    await sendCdp(target, "Input.imeSetComposition", {
      text: value,
      // These are DOM text offsets: UTF-16 code units, so `.length` is the count
      // Blink means. A code-point count would cut a surrogate pair in half.
      selectionStart: value.length,
      selectionEnd: value.length,
      replacementStart: 0,
      replacementEnd: String(current ?? "").length,
    });
    await sendCdp(target, "Input.insertText", { text: value });
    return true;
  } catch {
    return false;
  }
}

/** Bridge note for a clear that only succeeded after a repair. */
function repairedNote(how, after) {
  return (
    `The field's previous value resisted the standard clear and was replaced via ${how}; ` +
    `it now reads "${quoteForNote(after)}".`
  );
}

/** Bridge note for a clear whose outcome cannot be read back at all. */
const UNVERIFIED_CLEAR_NOTE =
  "This element exposes no readable value, so the clear could NOT be verified — check the field's " +
  '= "…" value in the returned snapshot before relying on it.';

/**
 * Clear a field and write `value` into it — the whole of `clear: true`, and the
 * only path here that can silently do the wrong thing, so it is the only one
 * that reads the field back. Returns the bridge note the caller must relay
 * ("" when the clear verified cleanly on the first try).
 *
 * A LADDER, stopping at the first rung that verifies (order measured, not
 * assumed — `tests/visual/clear-ladder.spec.ts` has the rung × page matrix):
 *
 *   A  select-all then overtype — what a person does, one round trip. Defeated
 *      by a page that consumes the shortcut's keydown.
 *   B  IME replacement-range rewrite — no selection, no keymap.
 *   C  End, Backspace × what is ACTUALLY there, re-insert. Counted off `after`,
 *      not `before`: counting off `before` would delete the tail of what we just
 *      wrote and leave the old value in FRONT, which is the failure itself.
 *
 * Rungs A and C re-enter the value through `insert`, the way the caller entered
 * it the first time (insertText/IME, or the per-character replay), so the field
 * keeps seeing the input path it was chosen for. Rung B is deliberately its OWN
 * path — being independent of selection and keymap is the whole point — which is
 * also why it is verified like everything else and falls through to C when an
 * editor that only listens to keydown ignores it.
 *
 * EXACTLY four end states, and none of them is silent-optimistic — silence was
 * the bug: a script-controlled input appended three times running, deterministic
 * and invisible, and the tool reported success every time.
 *
 *   verified on rung A          → ""
 *   verified after B or C       → a note naming which repair ran and what the
 *                                 field now reads
 *   every rung failed           → THROW, quoting the surviving value
 *   nothing readable to verify  → rung A only (a Backspace count cannot be
 *                                 derived either), plus a note saying the clear
 *                                 is UNVERIFIED
 */
async function clearAndWrite(ref, target, value, insert) {
  const overtype = async () => {
    if (value) await insert();
    // An empty value means "empty this field" — nothing follows to overtype the
    // selection, so remove it explicitly.
    else await dispatchKey(target, "Delete", 0);
  };
  const resolved = await resolveValueNode(ref);
  if (!resolved) {
    await selectAllIn(target);
    await overtype();
    return UNVERIFIED_CLEAR_NOTE;
  }
  const { ref: valueNode, value: before } = resolved;

  // Rung A. A mid-ladder null read means the value node DETACHED under us (the
  // page re-rendered the field while we wrote into it) — verification just
  // became unavailable, which must surface as the unverified note, never as a
  // clean "": that would reopen exactly the silent end state this ladder closed.
  await selectAllIn(target);
  await overtype();
  let after = await settledValue(valueNode);
  if (after === null) return UNVERIFIED_CLEAR_NOTE;
  if (!clearFailed(before, after, value)) return "";

  // Rung B.
  if (await imeRewrite(target, value, after)) {
    after = await settledValue(valueNode);
    if (after === null) return UNVERIFIED_CLEAR_NOTE;
    if (!clearFailed(before, after, value)) return repairedNote("ime-rewrite", after);
  }

  // Rung C.
  await dispatchKey(target, "End", 0);
  // Code points, not UTF-16 units: over-counting is harmless (Backspace on an
  // empty field is a no-op), under-counting would leave the old value behind.
  const presses = Math.min([...String(after ?? "")].length, CLEAR_BACKSPACE_MAX);
  for (let i = 0; i < presses; i += 1) {
    // Frozen renderer mid-erase. The op tail reports the open dialog instead of
    // a snapshot, so there is nothing this note could usefully add.
    if (pendingDialogs.has(ref.tabId)) return "";
    await dispatchKey(target, "Backspace", 0);
  }
  if (value) await insert();
  after = await settledValue(valueNode);
  if (after === null) return UNVERIFIED_CLEAR_NOTE;
  if (!clearFailed(before, after, value)) return repairedNote("keyboard-erase", after);

  throw new Error(
    `Clearing this field did not take: the page rewrote its value (it now reads "${quoteForNote(after, 120)}"). ` +
      "This input is script-controlled: a select-all overtype, an IME replacement-range rewrite, and erasing " +
      "it key by key were all tried, and the old value came back each time. Click the field's own clear (X) " +
      "control from the snapshot if it has one, or ask the user to clear it.",
  );
}

/**
 * Focus one field and enter `value` — the shared insert path of type and
 * fill_form. `clear` replaces the existing content instead of inserting into it,
 * through the verified ladder above. Returns that ladder's bridge note ("" when
 * there is nothing to report).
 */
async function fillField(ref, value, clear) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await focusForInput(ref);
  if (!clear) {
    // Insert-at-cursor is the default and stays a straight write: no read-back,
    // no settle delay, no note. Only a REPLACEMENT can silently do the wrong thing.
    if (value) await insertValue(target, value);
    return "";
  }
  return clearAndWrite(ref, target, value, () => insertValue(target, value));
}

/** Type into one field. Returns the clearing ladder's bridge note, or "". */
async function typeRef(uid, value, submit, keystrokes, clear) {
  const ref = resolveRef(uid);
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  let note = "";
  if (keystrokes) {
    await focusForInput(ref);
    // Replay as real per-character key events, ONE bridge operation for the
    // whole string — for editors that only listen to keyboard input. Server
    // caps the length; the dialog check keeps a mid-string alert() from
    // queueing keystrokes into a frozen renderer.
    const replay = async () => {
      for (const ch of [...value]) {
        if (pendingDialogs.has(ref.tabId)) return;
        await dispatchKey(target, ch === "\n" ? "Enter" : ch, 0);
      }
    };
    // Same ladder, same verification; the replay IS this mode's insert path, so
    // the first character overtypes the selection instead of extending the value.
    if (clear) note = await clearAndWrite(ref, target, value, replay);
    else await replay();
  } else {
    note = await fillField(ref, value, clear);
  }
  if (submit) {
    await dispatchKey(target, "Enter", 0);
  }
  return note;
}

// ------------------------------------------------------------- select_option
//
// CDP has no setter for a <select>'s value short of running page JS, which
// this worker never does. So selection is driven the way a person drives it:
// a visibly rendered option is CLICKED; a collapsed native dropdown is TYPED at
// and only then walked with arrow keys, and the landing value is VERIFIED
// afterwards — the keyboard path is the one that can silently no-op, and it must
// never claim success on faith.
//
// The order was measured, not assumed. On a COLLAPSED select this Linux build
// does what the comment here used to blame on macOS alone: ArrowDown does not
// move the selection, it opens the browser-process native popup, which lives
// outside the renderer and which `Input.*` cannot reach at all — so the arrow
// walk reported `Selecting "Option 2" did not take` on a plain
// the-internet.herokuapp.com/dropdown. Type-ahead is the path that survives it:
// a focused collapsed select jumps to the option whose label starts with what
// was typed, entirely inside the renderer. Arrows stay as the fallback for the
// platforms where they do move the selection.

/** Settle before believing a select's new value; the AX value lags the key. */
const SELECT_SETTLE_MS = 150;
/** One more look before calling it a failure — the field bug was a hasty read. */
const SELECT_RECHECK_MS = 250;

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

/**
 * The shortest prefix of `picked`'s label that Blink's select type-ahead would
 * land on, or "" when type-ahead cannot do the job here.
 *
 * Type-ahead matches the typed characters against the option labels
 * case-insensitively and keeps roughly a one-second buffer between keystrokes,
 * so the whole prefix goes out back to back. Three things rule it out, and all
 * three are decided BEFORE typing rather than discovered afterwards:
 *
 *   - a non-ASCII character leaves dispatchKey through the IME composition path,
 *     which does not feed type-ahead at all;
 *   - a leading SPACE opens the native popup instead of starting a session (a
 *     space INSIDE an active prefix is ordinary input, which is why only the
 *     first character is ruled on — and why the label is trimmed first);
 *   - two enabled options sharing a label cannot be told apart by any prefix.
 *
 * Uniqueness is judged among the ENABLED options only, matching what the arrow
 * fallback walks.
 */
function typeaheadPrefix(enabled, picked) {
  const wanted = picked.label.trim();
  // Printable ASCII throughout, and never a space first.
  if (!/^[!-~][ -~]*$/.test(wanted)) return "";
  const others = enabled
    .filter((option) => option !== picked)
    .map((option) => option.label.trim().toLowerCase());
  const lower = wanted.toLowerCase();
  for (let len = 1; len <= wanted.length; len += 1) {
    const prefix = lower.slice(0, len);
    if (!others.some((label) => label.startsWith(prefix))) return wanted.slice(0, len);
  }
  return ""; // a duplicate label: no prefix singles it out
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
      // Spread the ref so the option inherits its document epoch: nodeCall looks
      // the uid up by the full key when it has to explain a dead node.
      await clickNode({ ...ref, backendNodeId: picked.backendNodeId });
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

  // Collapsed native single <select>. Type-ahead first, arrows as the fallback.
  const enabled = options.filter((option) => !option.disabled);
  const wantLabel = picked.label.trim();
  await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
  await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });

  const readValue = async () =>
    String(
      (await sessionAxNodes(target)).find((node) => node.backendDOMNodeId === ref.backendNodeId)
        ?.value?.value || "",
    ).trim();
  /**
   * Read the value back the way the clearing ladder does — with a settle, and a
   * SECOND look before giving up. Reading immediately after the last key
   * reported successful selections as failures: the AX value is one flush
   * behind the keystroke that changed it.
   */
  const verify = async () => {
    await new Promise((resolve) => setTimeout(resolve, SELECT_SETTLE_MS));
    let landed = await readValue();
    if (landed !== wantLabel) {
      await new Promise((resolve) => setTimeout(resolve, SELECT_RECHECK_MS));
      landed = await readValue();
    }
    return landed;
  };

  let landed = "";
  const prefix = typeaheadPrefix(enabled, picked);
  for (const ch of prefix) {
    if (pendingDialogs.has(ref.tabId)) return; // a change handler froze the page
    await dispatchKey(target, ch, 0);
  }
  if (prefix) {
    landed = await verify();
    if (landed === wantLabel) return;
  }

  // Arrows move by one ENABLED option — on the platforms where they move at all.
  // The starting index comes from the value just READ, not from the pre-typing
  // snapshot: type-ahead may have moved the selection somewhere else entirely,
  // and walking from a stale index would overshoot by exactly that much.
  const targetIdx = enabled.indexOf(picked);
  let currentIdx = landed ? enabled.findIndex((option) => option.label.trim() === landed) : -1;
  if (currentIdx < 0) currentIdx = enabled.findIndex((option) => option.selected === true);
  if (currentIdx < 0) {
    const currentLabel = String(rootAx?.value?.value || "").trim();
    currentIdx = enabled.findIndex((option) => option.label.trim() === currentLabel);
  }
  if (currentIdx < 0) currentIdx = 0; // best effort — the verify below is the referee
  const delta = targetIdx - currentIdx;
  for (let i = 0; i < Math.abs(delta); i += 1) {
    if (pendingDialogs.has(ref.tabId)) return;
    await dispatchKey(target, delta > 0 ? "ArrowDown" : "ArrowUp", 0);
  }
  landed = await verify();
  if (landed !== wantLabel) {
    throw new Error(
      `Selecting "${wanted}" did not take: the dropdown still reads "${landed || "(unknown)"}". ` +
        "Typing the option's label (the browser's own type-ahead) and walking with arrow keys were both tried and " +
        "the value did not change — on this platform the keys open the browser's NATIVE dropdown popup, which is " +
        "browser UI that synthetic input cannot reach. Ask the user to pick the option themselves, then take a " +
        "snapshot to confirm what is selected.",
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
  // Same lazily-updated AX tree the snapshot path reads: the field report had
  // the page's new button missing from read_text too, so the flush belongs here.
  await flushLifecycle(
    scope ? { tabId: scope.tabId, sessionId: scope.sessionId } : { tabId: tab.id },
  );
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

/**
 * Ops exempt from the CURRENT-url origin gate, because they are the way OUT of a
 * denied page and both check their own DESTINATION before moving. Gating them on
 * where the tab already sits is what stranded a tab an Adobe PDF-viewer
 * extension had hijacked: every op refused while quoting the stuck URL, and the
 * only recovery left was new_tab + close_tab. Everything else still refuses —
 * reading or acting on a denied page is the risk this gate exists for — and the
 * post-action landing check still decides what may be READ.
 */
const ORIGIN_EXEMPT_OPS = new Set(["navigate", "navigate_back"]);

async function performOp(message) {
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
    setCurrentTab(created.id);
    await waitForLoad(created.id);
  }

  if (message.op === "select_tab") {
    const picked = await groupedTabById(message.tabId);
    setCurrentTab(picked.id);
    // No snapshot: switching tabs used to fall through to the tail and return a
    // full page walk nobody asked for. Answer like list_tabs does — and from the
    // same pre-gate position, so a denied tab can still be switched away from.
    return {
      ok: true,
      url: picked.url || "",
      title: picked.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "close_tab") {
    const picked = await groupedTabById(message.tabId);
    await chrome.tabs.remove(picked.id);
    attached.delete(picked.id);
    forgetTabRefs(picked.id);
    lastSnapshotByTab.delete(picked.id);
    if (currentTabId === picked.id) setCurrentTab(null);
    const left = await groupedTabs();
    if (!left.length) {
      return { ok: true, tabs: [], url: "", title: "", snapshot: "" };
    }
  }

  // Baseline for the new-tab announcement in the tail. Taken AFTER the
  // tab-management branches so new_tab's own tab is not announced as a surprise.
  const tabIdsBefore = new Set((await groupedTabs()).map((one) => one.id));

  const tab = await targetTab();
  // Check the tab we are ABOUT to read as well as any URL we are asked to open:
  // an allowed navigation can land somewhere else via a redirect, and a tab the
  // user dragged in may already be sitting on a denied site.
  if (!ORIGIN_EXEMPT_OPS.has(message.op) && tab.url && !originAllowed(tab.url, patterns)) {
    return refuseOrigin(tab.url, source);
  }
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
  // BRIDGE-authored caveat about this op's outcome (a repaired or unverifiable
  // clear) — not page content, and the reason a clear can no longer end silently.
  let note = "";

  // A uid-scoped snapshot resolves its element BEFORE any page work, so a uid
  // from a previous page fails with the uid error rather than after a full walk.
  let snapshotScope = null;
  if (message.op === "snapshot" && message.uid) {
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    snapshotScope = resolveRef(message.uid);
  }
  // `maxChars` is the snapshot op's own budget and applies to both its forms.
  // No other op's snapshot sizing changes — those are the tool's contract, not
  // the caller's choice.
  const snapshotChars =
    message.op === "snapshot" ? clampSnapshotChars(message.maxChars) : undefined;

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
    // Hit-test the SAME point on the SAME session the click goes to, so a
    // frame-local coordinate is resolved in the space it was measured in. If
    // the spaces disagree anyway, describePoint's containment cross-check
    // fails and reports nothing — a missing description beats a false one.
    landedOn = await describePoint(target, px, py);
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
    landedOn = await describePoint({ tabId: tab.id }, cssX, cssY);
    await raceDialogOpen(tab.id, clickPoint({ tabId: tab.id }, cssX, cssY));
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "type") {
    const refused = await assertRefTabUsable(message.uid, patterns, source);
    if (refused) return refused;
    // raceDialogOpen resolves on whichever of the work or a dialog wins, so the
    // note is captured HERE rather than returned through it.
    await raceDialogOpen(
      tab.id,
      (async () => {
        note = await typeRef(
          message.uid,
          message.text || "",
          Boolean(message.submit),
          Boolean(message.keystrokes),
          Boolean(message.clear),
        );
      })(),
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
    // Per-field clear notes, attributed: with 25 fields in one call, "a clear
    // was repaired" is useless without saying WHICH field it was.
    const notes = [];
    for (let i = 0; i < fields.length; i += 1) {
      if (pendingDialogs.has(tab.id)) break; // frozen — the tail reports the open dialog
      const field = fields[i] || {};
      const uid = String(field.uid || "");
      const refused = await assertRefTabUsable(uid, patterns, source);
      if (refused) return refused;
      try {
        await raceDialogOpen(
          tab.id,
          (async () => {
            const fieldNote = await fillField(
              resolveRef(uid),
              String(field.value ?? ""),
              Boolean(field.clear),
            );
            if (fieldNote) notes.push(`Field ${i + 1} (uid "${uid}"): ${fieldNote}`);
          })(),
        );
      } catch (error) {
        // Partial progress is real progress: say exactly where it stopped so
        // the agent re-snapshots and continues instead of re-filling from zero.
        // "may hold partly-written text" covers the clearing failure, where the
        // field was written but the old value survived in front of it.
        return {
          ok: false,
          message:
            `Field ${i + 1} of ${fields.length} (uid "${uid}") could not be filled: ${String(error?.message || error)} ` +
            "Fields before it were already filled, and this one may hold partly-written text — " +
            "take a fresh snapshot and continue from there." +
            // An earlier field's caveat must not be lost just because a later
            // one failed outright: the ok:false reply carries only `message`.
            (notes.length ? ` Notes from earlier fields: ${capNote(notes.join(" "))}` : ""),
        };
      }
    }
    note = notes.join("\n");
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
  if (fresh.url && !originAllowed(fresh.url, patterns)) {
    return refuseLanding(message.op, fresh.url, source);
  }

  // A dialog may have opened as a RESULT of the action (click → confirm). The
  // snapshot walk would hang on the frozen renderer — report the dialog
  // instead, keeping what a coordinate click landed on: the confirm() case is
  // exactly when knowing what was clicked matters most.
  if (pendingDialogs.has(tab.id)) {
    return {
      ...(await dialogBlockedResult(fresh)),
      ...(landedOn ? { landedOn } : {}),
      // A clear caveat outlives the interruption: the field still holds whatever
      // the note says it holds, and there is no snapshot here to check it against.
      ...(note ? { note: capNote(note) } : {}),
    };
  }

  // Cap the snapshot uid-first: an uncapped long page fails the whole model
  // turn, which made merely REACHING such a page count as an error. wait_for's
  // internal matching above deliberately uses the uncapped walk.
  let snapshot = "";
  let snapshotError;
  const readSnapshot = async () =>
    capSnapshot(
      snapshotScope ? await buildScopedSnapshot(fresh, snapshotScope) : await buildSnapshot(fresh),
      snapshotChars,
    );
  try {
    snapshot = await readSnapshot();
    // A BYTE-IDENTICAL snapshot after an action that changed the page is the
    // shape of a too-early read, not of a no-op: clicking "Add Element" returned
    // success while the new button was absent from the walk. flushLifecycle
    // forces the lifecycle tick, but the AX flush can still land a beat later, so
    // one bounded re-poll separates "the click did nothing" from the truth.
    if (SETTLE_OPS.has(message.op) && snapshot && lastSnapshotByTab.get(fresh.id) === snapshot) {
      await new Promise((resolve) => setTimeout(resolve, STALE_SNAPSHOT_REPOLL_MS));
      snapshot = await readSnapshot();
    }
    lastSnapshotByTab.set(fresh.id, snapshot);
  } catch (error) {
    // The ACTION already happened. Reporting the whole op as failed because
    // the read-back broke made the agent retry it — navigating twice, clicking
    // twice. Say the action ran and the view is missing, separately.
    snapshotError = String(error?.message || error);
  }
  // Always report the group's tabs: the agent needs to know a new tab appeared
  // (or that several are open) without spending a separate list_tabs round trip.
  const groupNow = await groupedTabs();
  // …and a target=_blank click ADDS one silently: the array changes and nothing
  // says so, so the agent kept driving the old page while the result it asked
  // for was on the new one. new_tab is exempt — its tab is in the baseline.
  const opened = message.op === "new_tab" ? [] : groupNow.filter((one) => !tabIdsBefore.has(one.id));
  if (opened.length) {
    note = [
      note,
      ...opened.map(
        (one) =>
          `A new tab opened during this ${message.op}: "${quoteForNote(one.title || "(untitled)")}" — ` +
          `${quoteForNote(one.url, NOTE_URL_MAX)} (tabId ${one.id}). It did NOT become the working tab; ` +
          "use mcp__browser__select_tab to work in it.",
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return {
    ok: true,
    snapshot,
    ...(snapshotError ? { snapshotError } : {}),
    url: fresh.url,
    title: fresh.title,
    tabs: groupNow.map(describeTab),
    ...(landedOn ? { landedOn } : {}),
    ...(note ? { note: capNote(note) } : {}),
  };
}

/**
 * The op, plus any working-tab notice targetTab left behind.
 *
 * It rides `note` — the existing BRIDGE-authored caveat channel, already relayed
 * and capped — rather than a new wire field, and it is folded in HERE so an op
 * with its own early-return shape (read_text, screenshot, a blocked dialog)
 * cannot drop it. A refusal carries no `note` across the wire, so there it joins
 * the message instead: "Blocked: <url>" is exactly the case where the reason may
 * BE that the bridge is on a tab the agent never chose. First in either string,
 * because it reframes every other line and capNote truncates the tail.
 */
async function perform(message) {
  let result;
  try {
    result = await performOp(message);
  } catch (error) {
    takeTabNotice(); // never let a stale notice surface on the NEXT op
    throw error;
  }
  const notice = takeTabNotice();
  if (!notice) return result;
  if (result?.ok === false) {
    return { ...result, message: `${notice} ${result.message || ""}`.trim() };
  }
  return { ...result, note: capNote([notice, result?.note].filter(Boolean).join(" ")) };
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
