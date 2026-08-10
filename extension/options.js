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

renderVersion();
void init();
void initHighlight();
