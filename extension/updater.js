// Self-updater page. An extension cannot rewrite its own files, so the user
// connects the unpacked folder ONCE (File System Access), and from then on the
// toolbar button fetches the latest signed payload from GitHub Releases,
// verifies it against the public key pinned in this manifest, writes the
// files, and asks the worker to reload the extension.
//
// Everything fetched is UNTRUSTED until crypto.subtle.verify passes — the
// payload is parsed only after the signature over its exact bytes checks out.

import {
  base64ToBytes,
  compareDottedVersions,
  mergeManifestPreservingMatches,
  noahOriginsFromMatches,
  validateUpdatePayload,
  zipUrlForOrigin,
} from "./updater-core.js";

/** Stable "latest release" alias — each release attaches both assets. */
const UPDATE_BASE = "https://github.com/JinY0ung-Shin/noah-almighty/releases/latest/download";
const PAYLOAD_ASSET = "noah-bridge-update.json";
const SIGNATURE_ASSET = "noah-bridge-update.sig";

const els = {
  current: document.getElementById("current-version"),
  latest: document.getElementById("latest-version"),
  check: document.getElementById("check-status"),
  connect: document.getElementById("connect"),
  folder: document.getElementById("folder-status"),
  update: document.getElementById("update"),
  status: document.getElementById("update-status"),
  log: document.getElementById("log"),
  manual: document.getElementById("manual"),
  manualLinks: document.getElementById("manual-links"),
};

const manifest = chrome.runtime.getManifest();

// Everything here is Chromium-common; the one thing Edge renames is the
// extensions-manager page, so guidance text resolves it at runtime.
const EXTENSIONS_PAGE = /\bEdg\//.test(navigator.userAgent)
  ? "edge://extensions"
  : "chrome://extensions";
for (const el of document.querySelectorAll(".extensions-page")) {
  el.textContent = EXTENSIONS_PAGE;
}

/** Verified-and-validated payload; null until checkLatest succeeds. */
let latestPayload = null;
/** Connected unpacked-folder handle; null until connected. */
let dirHandle = null;

function setStatus(el, text, tone) {
  el.textContent = text;
  el.classList.remove("ok", "bad");
  if (tone) el.classList.add(tone);
}

function logLine(text) {
  els.log.hidden = false;
  els.log.textContent += `${text}\n`;
}

/**
 * The button is live as soon as there is something verified to install — it
 * does NOT wait for a connected folder. Requiring the folder first left a dead
 * button under a "새 버전이 있습니다" message with nothing saying why, so the
 * missing folder is now just the button's first step (the click is the user
 * gesture the directory picker needs anyway).
 */
function refreshUpdateButton() {
  els.update.disabled = !latestPayload;
  if (!latestPayload) return;
  if (!dirHandle) {
    els.update.textContent = "폴더 연결하고 업데이트";
    return;
  }
  const cmp = compareDottedVersions(latestPayload.version, manifest.version);
  els.update.textContent = cmp !== null && cmp <= 0 ? "다시 설치" : "업데이트";
}

// ------------------------------------------------------------ handle storage
// FSA handles survive in IndexedDB across page loads and extension reloads;
// only the permission may fall back to "prompt", which one click re-grants.

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("noah-updater", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("handles").objectStore("handles").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -------------------------------------------------------------- verification

async function verifySignature(payloadBytes, signatureB64) {
  if (typeof manifest.key !== "string" || !manifest.key) {
    throw new Error("이 설치본의 매니페스트에 검증 키가 없어 업데이트를 검증할 수 없습니다.");
  }
  const key = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(manifest.key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64ToBytes(signatureB64), payloadBytes);
}

async function checkLatest() {
  setStatus(els.check, "");
  els.latest.textContent = "확인 중…";
  latestPayload = null;
  let payloadBytes;
  let signatureB64;
  try {
    const [payloadRes, sigRes] = await Promise.all([
      fetch(`${UPDATE_BASE}/${PAYLOAD_ASSET}`, { cache: "no-store", credentials: "omit" }),
      fetch(`${UPDATE_BASE}/${SIGNATURE_ASSET}`, { cache: "no-store", credentials: "omit" }),
    ]);
    if (!payloadRes.ok || !sigRes.ok) {
      // A REPLY means the network is fine — do not send the user hunting for a
      // proxy problem. 404 in particular is the ordinary "the newest release
      // carries no update assets" case, which only publishing can fix.
      const status = payloadRes.ok ? sigRes.status : payloadRes.status;
      els.latest.textContent = status === 404 ? "게시 안 됨" : "확인 실패";
      setStatus(
        els.check,
        status === 404
          ? "GitHub에는 연결됐지만, 최신 릴리스에 업데이트 파일이 없습니다. 아직 이 배포 경로로 릴리스가 게시되지 않았다는 뜻입니다 — " +
              "관리자가 릴리스에 업데이트 에셋을 첨부하면 여기서 바로 잡힙니다. 그때까지는 아래 수동 방법을 쓰세요."
          : `GitHub이 ${status}로 응답했습니다. 잠시 후 다시 시도하고, 계속되면 관리자에게 알려주세요.`,
        "bad",
      );
      if (status === 404) revealManualPath();
      refreshUpdateButton();
      return;
    }
    payloadBytes = new Uint8Array(await payloadRes.arrayBuffer());
    signatureB64 = (await sigRes.text()).trim();
  } catch (error) {
    // No reply at all: DNS/proxy/TLS. This is the only case where blocked
    // egress is the likely story.
    els.latest.textContent = "확인 실패";
    setStatus(
      els.check,
      `GitHub에 연결하지 못했습니다 (${String(error?.message || error)}). ` +
        "사내망에서 github.com 접근이 막혀 있으면 이 업데이트 경로는 쓸 수 없으니, 아래 수동 방법을 쓰세요.",
      "bad",
    );
    revealManualPath();
    refreshUpdateButton();
    return;
  }
  try {
    const valid = await verifySignature(payloadBytes, signatureB64);
    if (!valid) {
      throw new Error("서명이 이 확장의 키와 일치하지 않습니다");
    }
    latestPayload = validateUpdatePayload(JSON.parse(new TextDecoder().decode(payloadBytes)));
  } catch (error) {
    els.latest.textContent = "검증 실패";
    setStatus(
      els.check,
      `업데이트 서명 검증에 실패해 설치를 차단했습니다 (${String(error?.message || error)}). ` +
        "릴리스가 위조되었거나, 서명 키가 아직 이 설치본의 키와 맞춰지지 않은 상태입니다.",
      "bad",
    );
    refreshUpdateButton();
    return;
  }
  els.latest.textContent = latestPayload.version;
  const cmp = compareDottedVersions(latestPayload.version, manifest.version);
  if (cmp !== null && cmp <= 0) {
    setStatus(els.check, "이미 최신 버전입니다.", "ok");
  } else {
    setStatus(els.check, "새 버전이 있습니다. 아래에서 업데이트하세요.");
  }
  refreshUpdateButton();
}

// -------------------------------------------------------------------- folder

/** True when the picked folder is THIS extension's unpacked folder. */
async function folderIsThisExtension(handle) {
  try {
    const file = await (await handle.getFileHandle("manifest.json")).getFile();
    const parsed = JSON.parse(await file.text());
    return parsed?.key === manifest.key;
  } catch {
    return false;
  }
}

async function ensurePermission(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return true;
  return (await handle.requestPermission(options)) === "granted";
}

async function reflectStoredHandle() {
  try {
    dirHandle = await idbGet("dir");
  } catch {
    dirHandle = null;
  }
  if (dirHandle) {
    els.connect.textContent = "폴더 변경";
    setStatus(els.folder, `연결됨: ${dirHandle.name}`, "ok");
  } else {
    setStatus(els.folder, "아직 연결되지 않았습니다.");
  }
  refreshUpdateButton();
}

/**
 * Reveal the no-file-dialog path. Called whenever the picker proves
 * unavailable — an absent API, but also a DLP agent that intercepts the dialog
 * and answers with its own refusal. The user is stuck otherwise: the failure
 * they see comes from software we do not control and says nothing about what
 * to do next.
 */
function revealManualPath() {
  els.manual.hidden = false;
  const origins = noahOriginsFromMatches(manifest.externally_connectable?.matches);
  if (origins.length) {
    els.manualLinks.textContent = "";
    origins.forEach((origin, index) => {
      if (index) els.manualLinks.append(" · ");
      const link = document.createElement("a");
      link.href = zipUrlForOrigin(origin);
      link.textContent = new URL(origin).host;
      els.manualLinks.append(link);
    });
    els.manualLinks.append(
      document.createTextNode(" (Noah에 로그인된 상태여야 내려받아집니다)"),
    );
  }
  els.manual.scrollIntoView({ block: "nearest" });
}

async function connectFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    setStatus(
      els.folder,
      "이 브라우저에서 폴더 접근 API를 쓸 수 없습니다 (회사 정책 차단 가능성). 아래 수동 방법을 이용하세요.",
      "bad",
    );
    revealManualPath();
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") return; // user cancelled — not an error
    setStatus(
      els.folder,
      `폴더를 열 수 없습니다 (${error?.name || "오류"}). 보안 정책이 파일 선택 창을 막고 있다면 아래 수동 방법만 가능합니다.`,
      "bad",
    );
    revealManualPath();
    return;
  }
  if (!(await folderIsThisExtension(handle))) {
    setStatus(
      els.folder,
      "이 확장의 폴더가 아닙니다. 압축을 풀어 로드한 바로 그 폴더(manifest.json이 들어 있는 폴더)를 선택하세요.",
      "bad",
    );
    return;
  }
  dirHandle = handle;
  try {
    await idbSet("dir", handle);
  } catch {
    // Non-fatal: the update still works this session; reconnect next time.
  }
  els.connect.textContent = "폴더 변경";
  setStatus(els.folder, `연결됨: ${handle.name}`, "ok");
  refreshUpdateButton();
}

// -------------------------------------------------------------------- update

async function runUpdate() {
  if (!latestPayload) return;
  // No folder yet: connect it as the first step of this same click. The picker
  // needs a user gesture, and this click is one.
  if (!dirHandle) {
    setStatus(els.status, "설치 폴더를 먼저 지정해 주세요…");
    await connectFolder();
    if (!dirHandle) {
      // connectFolder already explained why (cancelled, wrong folder, blocked).
      setStatus(els.status, "");
      refreshUpdateButton();
      return;
    }
  }
  els.update.disabled = true;
  els.log.textContent = "";
  setStatus(els.status, "권한 확인 중…");
  try {
    // Permission first, inside the click's user gesture — the fetch already
    // happened at page load, so nothing eats the transient activation.
    if (!(await ensurePermission(dirHandle))) {
      setStatus(els.status, "폴더 쓰기 권한이 거부되어 중단했습니다.", "bad");
      refreshUpdateButton();
      return;
    }
    if (!(await folderIsThisExtension(dirHandle))) {
      setStatus(
        els.folder,
        "연결된 폴더에서 이 확장의 manifest.json을 찾지 못했습니다. 폴더를 다시 연결하세요.",
        "bad",
      );
      setStatus(els.status, "중단했습니다.", "bad");
      refreshUpdateButton();
      return;
    }
    setStatus(els.status, `버전 ${latestPayload.version} 파일을 쓰는 중…`);
    const currentMatches = manifest.externally_connectable?.matches || [];
    for (const file of latestPayload.files) {
      const content =
        file.name === "manifest.json"
          ? mergeManifestPreservingMatches(file.content, currentMatches)
          : file.content;
      const handle = await dirHandle.getFileHandle(file.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      logLine(`✓ ${file.name}`);
    }
    setStatus(els.status, "완료 — 확장을 다시 시작합니다…", "ok");
    const tab = await chrome.tabs.getCurrent();
    // The worker closes this tab and reloads the extension; a reply will never
    // arrive because the reload tears the whole extension down — that's fine.
    chrome.runtime.sendMessage({ type: "noah-updater-apply", tabId: tab?.id ?? null });
  } catch (error) {
    setStatus(
      els.status,
      `실패: ${String(error?.message || error)} — ${EXTENSIONS_PAGE}에서 오류 표시를 확인하거나 수동 zip 교체로 복구할 수 있습니다.`,
      "bad",
    );
    refreshUpdateButton();
  }
}

els.connect.addEventListener("click", connectFolder);
els.update.addEventListener("click", runUpdate);

els.current.textContent = manifest.version;
// An absent API is knowable without a click; a DLP-intercepted dialog is not,
// so the manual path also appears the moment a connect attempt fails.
if (typeof window.showDirectoryPicker !== "function") revealManualPath();
void reflectStoredHandle();
void checkLatest();
