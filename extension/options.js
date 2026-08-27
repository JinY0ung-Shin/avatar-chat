// Options page for the local (development) allowlist and the on-screen
// preferences.
//
// Enterprise policy WINS: when chrome.storage.managed carries allowedOrigins,
// the editor is disabled and the managed list is shown read-only, because the
// background worker ignores the local list entirely in that case. Letting
// someone type into a box that has no effect would be worse than showing none.

const POLICY_KEY = "allowedOrigins";
const HIGHLIGHT_KEY = "highlightActions";

const managedBanner = document.getElementById("managed");
const managedList = document.getElementById("managed-list");
const editor = document.getElementById("editor");
const textarea = document.getElementById("origins");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");
const highlightToggle = document.getElementById("highlight-actions");
const uidMapButton = document.getElementById("uid-map");
const uidMapStatus = document.getElementById("uid-map-status");
const versionLine = document.getElementById("version");

function parseLines(raw) {
  const seen = new Set();
  return raw
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    });
}

async function readManaged() {
  try {
    const stored = await chrome.storage.managed.get(POLICY_KEY);
    const list = stored?.[POLICY_KEY];
    return Array.isArray(list) ? list.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function init() {
  const managed = await readManaged();
  if (managed.length) {
    managedBanner.hidden = false;
    for (const entry of managed) {
      const li = document.createElement("li");
      li.textContent = entry;
      managedList.appendChild(li);
    }
    textarea.disabled = true;
    saveButton.disabled = true;
    editor.classList.add("disabled");
    return;
  }
  const stored = await chrome.storage.local.get(POLICY_KEY);
  const local = Array.isArray(stored?.[POLICY_KEY]) ? stored[POLICY_KEY] : [];
  textarea.value = local.join("\n");
}

saveButton.addEventListener("click", async () => {
  const patterns = parseLines(textarea.value);
  await chrome.storage.local.set({ [POLICY_KEY]: patterns });
  // Normalize the box to exactly what was stored, so what the user sees is
  // what the bridge will enforce.
  textarea.value = patterns.join("\n");
  status.textContent = patterns.length
    ? `저장됨 — ${patterns.length}개 사이트 허용`
    : "저장됨 — 허용된 사이트가 없어 모든 조작이 거부됩니다";
  setTimeout(() => {
    status.textContent = "";
  }, 4000);
});

// The action highlight is deliberately OUTSIDE enterprise policy, so it gets
// its own init instead of riding init()'s managed early-return: policy decides
// what the agent may TOUCH (allowedOrigins), this preference decides only what
// the human SEES on their own screen. A managed install must therefore still
// be able to turn the box off.
//
// Absent means ON, so the stored value is read as `!== false` — never as
// truthy, which would leave a fresh profile showing an unchecked box while the
// background worker draws the highlight.
async function initHighlight() {
  const stored = await chrome.storage.local.get(HIGHLIGHT_KEY);
  highlightToggle.checked = stored?.[HIGHLIGHT_KEY] !== false;
}

// No save button: the checkbox state IS the feedback, and the background
// worker re-reads the key on storage.onChanged, so the very next operation
// already honors it.
highlightToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ [HIGHLIGHT_KEY]: highlightToggle.checked });
});

// ------------------------------------------------------------- uid map
//
// The worker does all of it: capture, build, store the payload, open the
// viewer tab. This page only asks and reports why not — so on success there is
// nothing to say, the new tab takes focus and (as the action popup) this window
// closes itself mid-flight.
//
// Every failure the worker can name gets its own sentence, because "지도를
// 만들지 못했습니다" alone would leave the user with no idea whether to drag a
// tab into the Noah group, widen the allowlist, or just ask the avatar to look
// at the page first.
const UID_MAP_ERRORS = {
  no_tab: "브릿지가 잡고 있는 탭이 없습니다 — 아바타로 브라우저 조작을 먼저 시작하세요.",
  origin_denied: "현재 탭은 허용 목록 밖이라 캡처하지 않습니다.",
  no_uids: "이 페이지에서 부여된 uid가 없습니다 — 아바타가 스냅샷을 찍은 뒤 다시 시도하세요.",
  capture_failed: "지도를 만들지 못했습니다 — 탭 상태를 바꾼 뒤 다시 시도하세요.",
};

// Callback form, not the promise form: a service worker that never answers (an
// older build without this op, a listener that threw) surfaces as
// chrome.runtime.lastError here, and reading it inside the callback is what
// marks it handled. Resolving null then joins the same path as a malformed
// reply — the user gets the capture_failed line either way.
function requestUidMap() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ op: "buildUidMap" }, (reply) => {
        resolve(chrome.runtime.lastError ? null : reply);
      });
    } catch {
      resolve(null);
    }
  });
}

uidMapButton.addEventListener("click", async () => {
  uidMapButton.disabled = true;
  uidMapStatus.textContent = "";
  try {
    const reply = await requestUidMap();
    if (reply?.ok === true) return;
    const code = typeof reply?.code === "string" ? reply.code : "capture_failed";
    uidMapStatus.textContent = UID_MAP_ERRORS[code] ?? UID_MAP_ERRORS.capture_failed;
  } finally {
    // Re-enabled even on success: as the options TAB this window stays open, so
    // leaving the button dead would strand it after one use.
    uidMapButton.disabled = false;
  }
});

// The extension fetches nothing by design, so the footer states the two LOCAL
// facts that matter when debugging "why doesn't the bridge work here": which
// bridge build this is, and which browser build is hosting it. Brand names
// come from userAgentData (always present on the Chromium ≥116 this manifest
// requires); specific brands are preferred over the generic "Chromium" entry.
function renderVersion() {
  const parts = [`브릿지 v${chrome.runtime.getManifest().version}`];
  const brands = navigator.userAgentData?.brands ?? [];
  for (const [brand, label] of [
    ["Microsoft Edge", "Edge"],
    ["Whale", "Whale"],
    ["Google Chrome", "Chrome"],
    ["Chromium", "Chromium"],
  ]) {
    const hit = brands.find((entry) => entry.brand === brand);
    if (hit?.version) {
      parts.push(`${label} ${hit.version}`);
      break;
    }
  }
  versionLine.textContent = parts.join(" · ");
}

// ------------------------------------------------------- cookie grants
//
// read_cookies consent is per SITE, per browser SESSION: the first read of a
// host prompts a popup, and background.js remembers an approved host in
// chrome.storage.session so the SAME site does not re-prompt for the rest of the
// session. This panel lists those remembered hosts and lets the user revoke one
// (취소) or all of them (모두 취소) mid-session; they also clear on their own when
// the browser closes. storage.session is a TRUSTED_CONTEXTS store and this page
// is a trusted extension context, so it is read/written here directly — the same
// way the allowlist above uses chrome.storage.local — with no setAccessLevel and
// no message to the background worker. The key MUST match background.js.
const COOKIE_GRANTS_KEY = "cookieConsentGrants";

const cookieGrantsList = document.getElementById("cookie-grants");
const cookieGrantsEmpty = document.getElementById("cookie-grants-empty");
const cookieGrantsClear = document.getElementById("cookie-grants-clear");
const cookieGrantsStatus = document.getElementById("cookie-grants-status");

async function readCookieGrants() {
  try {
    const stored = await chrome.storage.session.get(COOKIE_GRANTS_KEY);
    const grants = stored?.[COOKIE_GRANTS_KEY];
    return grants && typeof grants === "object" ? grants : {};
  } catch {
    // Unreadable session store (unusual on a trusted page): show the empty
    // state rather than a stale or broken list.
    return {};
  }
}

async function revokeCookieGrant(host) {
  const grants = await readCookieGrants();
  delete grants[host];
  try {
    // Drop the key entirely once the last host is gone, so an empty object never
    // lingers in the session store.
    if (Object.keys(grants).length) {
      await chrome.storage.session.set({ [COOKIE_GRANTS_KEY]: grants });
    } else {
      await chrome.storage.session.remove(COOKIE_GRANTS_KEY);
    }
    cookieGrantsStatus.textContent = `${host} 접근을 취소했습니다.`;
  } catch {
    cookieGrantsStatus.textContent = "취소하지 못했습니다. 다시 시도하세요.";
  }
  await renderCookieGrants();
}

async function clearCookieGrants() {
  try {
    await chrome.storage.session.remove(COOKIE_GRANTS_KEY);
    cookieGrantsStatus.textContent = "허용한 사이트를 모두 취소했습니다.";
  } catch {
    cookieGrantsStatus.textContent = "취소하지 못했습니다. 다시 시도하세요.";
  }
  await renderCookieGrants();
}

async function renderCookieGrants() {
  const grants = await readCookieGrants();
  const hosts = Object.keys(grants)
    .filter((host) => grants[host] === true)
    .sort();
  cookieGrantsList.textContent = "";
  if (!hosts.length) {
    cookieGrantsEmpty.hidden = false;
    cookieGrantsClear.hidden = true;
    return;
  }
  cookieGrantsEmpty.hidden = true;
  cookieGrantsClear.hidden = false;
  for (const host of hosts) {
    const li = document.createElement("li");
    // The host is a hostname the user already approved; render it as TEXT,
    // never markup, consistent with how the consent popup shows it.
    const name = document.createElement("span");
    name.className = "host";
    name.textContent = host;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "secondary";
    revoke.textContent = "취소";
    revoke.addEventListener("click", () => void revokeCookieGrant(host));
    li.append(name, revoke);
    cookieGrantsList.appendChild(li);
  }
}

cookieGrantsClear.addEventListener("click", () => void clearCookieGrants());

// Cheap live refresh: a grant added by a read_cookies approval, or revoked in
// another view, re-renders this list without a manual reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[COOKIE_GRANTS_KEY]) void renderCookieGrants();
});

renderVersion();
void init();
void initHighlight();
void renderCookieGrants();
