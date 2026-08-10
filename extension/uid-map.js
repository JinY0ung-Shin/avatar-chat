// Viewer for the uid map: the full-page screenshot the background worker just
// captured, with one green box per uid the last snapshot minted — "which uid
// sits where".
//
// EVERYTHING in the payload is PAGE-DERIVED and therefore untrusted: the title,
// the URL, every tag and uid string, and the screenshot bytes. Text only ever
// lands through textContent (never innerHTML), and the image only after its data
// URL is confirmed to be an image, so a page that puts markup in its own <title>
// gets shown that markup as text instead of having it parsed here.
//
// ONE-SHOT by design: the payload is read from session storage and deleted in
// the same breath, so a reload — or this tab being restored on browser start —
// lands on the empty state. A map that outlives its capture points at uids the
// page no longer has, which is worse than no map at all.

const PAYLOAD_KEY = "uidMapPayload";

const masthead = document.getElementById("masthead");
const pageTitle = document.getElementById("page-title");
const pageUrl = document.getElementById("page-url");
const countShown = document.getElementById("count-shown");
const countSkipped = document.getElementById("count-skipped");
const capturedAt = document.getElementById("captured-at");
const zoomSelect = document.getElementById("zoom");
const stage = document.getElementById("stage");
const sizer = document.getElementById("sizer");
const canvas = document.getElementById("canvas");
const shot = document.getElementById("shot");
const empty = document.getElementById("empty");

/** Size of the captured area in CSS px — the space every box coordinate is in. */
let docSize = null;

function isSize(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCoord(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function countOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * Keep only the entries that can actually be drawn. A box with a missing uid or
 * a non-numeric rect would land at the top-left corner and quietly lie about
 * where that element is, so it is dropped rather than guessed at.
 */
function readBoxes(raw) {
  if (!Array.isArray(raw)) return [];
  const boxes = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.uid !== "string" || !entry.uid) continue;
    const { x, y, w, h } = entry;
    if (!isCoord(x) || !isCoord(y) || !isSize(w) || !isSize(h)) continue;
    boxes.push({ uid: entry.uid, x, y, w, h, tag: typeof entry.tag === "string" ? entry.tag : "" });
  }
  return boxes;
}

function drawBoxes(boxes) {
  // Biggest first, so a small control nested in a big container ends up on top
  // and stays hoverable. Painting order is the only thing this decides — every
  // box keeps the coordinates it came with.
  const ordered = [...boxes].sort((a, b) => b.w * b.h - a.w * a.h);
  const frag = document.createDocumentFragment();
  for (const box of ordered) {
    const el = document.createElement("div");
    el.className = "box";
    el.dataset.uid = box.uid;
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    // Readable at any zoom, since the browser draws the tooltip at its own
    // size while the chip below scales with the map.
    el.title = box.tag ? `${box.uid} · ${box.tag}` : box.uid;

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = box.uid;
    el.appendChild(chip);
    frag.appendChild(el);
  }
  canvas.appendChild(frag);
}

function renderCounts(shownCount, skipped) {
  countShown.textContent = `uid ${shownCount}개 표시`;
  const frames = countOf(skipped?.frames);
  const cropped = countOf(skipped?.cropped);
  const missing = frames + cropped;
  if (!missing) return;
  countSkipped.hidden = false;
  countSkipped.textContent =
    `표시하지 못한 uid ${missing}개 ` +
    `(다른 프레임·사라진 요소 ${frames} / 캡처 높이 초과 ${cropped})`;
}

function renderCapturedAt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return;
  capturedAt.textContent = `${when.toLocaleString("ko-KR")} 캡처`;
}

/** Largest scale that fits the capture's width in the stage, never enlarging. */
function fitScale() {
  if (!docSize) return 1;
  const style = getComputedStyle(stage);
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const available = stage.clientWidth - pad;
  if (!(available > 0)) return 1;
  return Math.min(1, available / docSize.width);
}

function applyZoom() {
  if (!docSize) return;
  const raw = zoomSelect.value;
  const scale = raw === "fit" ? fitScale() : Number(raw) || 1;
  // At 1:1 the transform is dropped entirely so the screenshot is painted
  // pixel-for-pixel with no resampling.
  canvas.style.transform = scale === 1 ? "none" : `scale(${scale})`;
  sizer.style.width = `${docSize.width * scale}px`;
  sizer.style.height = `${docSize.height * scale}px`;
}

function render(payload) {
  if (!payload || typeof payload !== "object") return false;

  const doc = payload.doc;
  if (!doc || typeof doc !== "object" || !isSize(doc.width) || !isSize(doc.height)) return false;

  const dataUrl = payload.image?.dataUrl;
  // The only thing standing between an attacker-controlled string and a
  // navigation from this privileged page: it must be an image data URL.
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return false;

  docSize = { width: doc.width, height: doc.height };
  canvas.style.width = `${doc.width}px`;
  canvas.style.height = `${doc.height}px`;
  shot.src = dataUrl;

  pageTitle.textContent = typeof payload.title === "string" && payload.title
    ? payload.title
    : "(제목 없음)";
  const url = typeof payload.url === "string" ? payload.url : "";
  pageUrl.textContent = url;
  pageUrl.hidden = !url;

  const boxes = readBoxes(payload.boxes);
  drawBoxes(boxes);
  renderCounts(boxes.length, payload.skipped);
  renderCapturedAt(payload.capturedAt);

  masthead.hidden = false;
  stage.hidden = false;
  applyZoom();
  return true;
}

async function load() {
  let payload = null;
  try {
    const stored = await chrome.storage.session.get(PAYLOAD_KEY);
    payload = stored?.[PAYLOAD_KEY] ?? null;
    // Drop it whether or not it turns out to be usable — an unreadable payload
    // left behind would keep failing on every reload.
    await chrome.storage.session.remove(PAYLOAD_KEY);
  } catch {
    payload = null;
  }
  if (!render(payload)) empty.hidden = false;
}

zoomSelect.addEventListener("change", applyZoom);
// Only "너비 맞춤" depends on the window; the fixed steps are absolute.
window.addEventListener("resize", () => {
  if (zoomSelect.value === "fit") applyZoom();
});

void load();
