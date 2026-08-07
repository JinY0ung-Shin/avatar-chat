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
  validateUpdatePayload,
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
};

const manifest = chrome.runtime.getManifest();

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

function refreshUpdateButton() {
  const ready = Boolean(latestPayload && dirHandle);
  els.update.disabled = !ready;
  if (latestPayload) {
    const cmp = compareDottedVersions(latestPayload.version, manifest.version);
    els.update.textContent = cmp !== null && cmp <= 0 ? "다시 설치" : "업데이트";
  }
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
      throw new Error(`서버 응답 ${payloadRes.ok ? sigRes.status : payloadRes.status}`);
    }
    payloadBytes = new Uint8Array(await payloadRes.arrayBuffer());
    signatureB64 = (await sigRes.text()).trim();
  } catch (error) {
    els.latest.textContent = "확인 실패";
    setStatus(
      els.check,
      `GitHub에서 최신 릴리스를 가져오지 못했습니다 (${String(error?.message || error)}). ` +
        "사내망에서 github.com 접근이 막혀 있으면 이 업데이트 경로는 쓸 수 없습니다.",
      "bad",
    );
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

async function connectFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    setStatus(
      els.folder,
      "이 브라우저에서 폴더 접근 API를 쓸 수 없습니다 (회사 정책 차단 가능성). 수동 zip 교체를 이용하세요.",
      "bad",
    );
    return;
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (error) {
    if (error?.name === "AbortError") return; // user cancelled — not an error
    setStatus(
      els.folder,
      `폴더를 열 수 없습니다 (${error?.name || "오류"}). 회사 정책이 파일 접근을 막고 있다면 수동 zip 교체만 가능합니다.`,
      "bad",
    );
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
  if (!latestPayload || !dirHandle) return;
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
      `실패: ${String(error?.message || error)} — chrome://extensions에서 오류 표시를 확인하거나 수동 zip 교체로 복구할 수 있습니다.`,
      "bad",
    );
    refreshUpdateButton();
  }
}

els.connect.addEventListener("click", connectFolder);
els.update.addEventListener("click", runUpdate);

els.current.textContent = manifest.version;
void reflectStoredHandle();
void checkLatest();
