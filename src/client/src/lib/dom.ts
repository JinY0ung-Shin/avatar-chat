// DOM helpers ported from the old core.js: clipboard copy with button flash,
// and a Svelte action that enhances rendered markdown (code-block copy buttons +
// horizontally-scrollable tables) the way enhanceCodeBlocks() used to.

import { iconSvg } from "./icons";

// Built from the shared icon map so these imperative copies can't drift from
// what <Icon name="copy" /> renders elsewhere.
const COPY_SVG = iconSvg("copy", 16);
const CHECK_SVG = iconSvg("check", 16);

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Downscale an image file to a `maxDim` long edge via canvas, returning a data URL.
// The Image is loaded from a `data:` URL (FileReader), NOT `URL.createObjectURL`:
// a `blob:` URL is blocked by the production CSP (`img-src 'self' data:`), which
// would make the load fail. Output type defaults to the file's family (jpeg/webp/png
// ternary) unless `outputType` forces it; default quality 0.9.
export async function downscaleImageToDataUrl(
  file: File,
  maxDim: number,
  opts?: { quality?: number; outputType?: string },
): Promise<string> {
  const quality = opts?.quality ?? 0.9;
  const sourceDataUrl = await readFileAsDataUrl(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("no 2d context"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out =
        opts?.outputType ??
        (file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png");
      resolve(canvas.toDataURL(out, quality));
    };
    img.onerror = () => reject(new Error("image load failed"));
    img.src = sourceDataUrl;
  });
}

// First image file in a clipboard: prefer items (covers screenshots/copied
// images), fall back to files (some browsers only populate one of the two for
// a pasted image). Shared by the profile photo and external-avatar photo
// Ctrl+V handlers; ChatView's multi-file composer paste stays separate.
export function pastedImageFile(clipboard: DataTransfer | null): File | null {
  if (!clipboard) return null;
  const fromItems = Array.from(clipboard.items || [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => Boolean(f));
  const fromFiles = Array.from(clipboard.files || []).filter((f) => f.type.startsWith("image/"));
  return fromItems[0] ?? fromFiles[0] ?? null;
}

export async function copyText(text: string, btn?: HTMLButtonElement | null): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    flashCopied(btn);
  } catch {
    flashCopyFailed(btn);
  }
}

function flashCopied(btn?: HTMLButtonElement | null): void {
  if (!btn) return;
  const original = btn.innerHTML;
  const label = btn.getAttribute("aria-label");
  window.clearTimeout((btn as any)._copyTimer);
  btn.classList.remove("copy-failed");
  btn.classList.add("copied");
  btn.setAttribute("aria-label", "복사됨");
  btn.title = "복사됨";
  btn.innerHTML = CHECK_SVG;
  (btn as any)._copyTimer = window.setTimeout(() => {
    btn.classList.remove("copied");
    btn.innerHTML = original;
    if (label) btn.setAttribute("aria-label", label);
    btn.title = label || "";
  }, 1200);
}

function flashCopyFailed(btn?: HTMLButtonElement | null): void {
  if (!btn) return;
  btn.classList.add("copy-failed");
  btn.setAttribute("aria-label", "복사 실패");
  btn.title = "복사 실패";
  window.setTimeout(() => btn.classList.remove("copy-failed"), 1200);
}

// Auto-grow a textarea with its content, capped at min(200px, 30% viewport) —
// mirrors the old composer autoGrow().
// The `_value` param mirrors the textarea's bound value so Svelte calls
// `update()` on programmatic value changes too — e.g. clearing the draft to ""
// after a send must shrink the box back, and no `input` event fires for a
// programmatic value change. CAUTION: Svelte runs an action's `update()` BEFORE
// it flushes the new `value` to the DOM node, so reading `scrollHeight` here
// synchronously sees the OLD content and re-pins the old height. Defer the
// param-driven grow to a microtask so it measures the post-flush value. The
// `input` path stays synchronous (the browser updates `value` before `input`).
export function autosize(node: HTMLTextAreaElement, _value?: string) {
  const grow = () => {
    node.style.height = "auto";
    const cap = Math.min(200, Math.round(window.innerHeight * 0.3));
    node.style.height = `${Math.min(node.scrollHeight, cap)}px`;
  };
  grow();
  node.addEventListener("input", grow);
  return {
    update() {
      queueMicrotask(grow);
    },
    destroy() {
      node.removeEventListener("input", grow);
    },
  };
}

// Close a lightweight popover/panel when the user interacts anywhere outside it.
// `onOutside` fires on a document pointerdown whose target is neither inside the
// node nor matching the `ignore` selector (the toggle button that opened it —
// excluded so its own click handler does the toggle instead of double-firing).
// Used for the composer's group-knowledge / MCP-tool panels. Because the panel
// mounts only once it's open, the opening click's pointerdown has already
// finished before the listener attaches, so it can't immediately self-close.
export function clickOutside(
  node: HTMLElement,
  params: { onOutside: () => void; ignore?: string },
) {
  let { onOutside, ignore } = params;
  const handle = (event: PointerEvent) => {
    const target = event.target as Element | null;
    if (!target || node.contains(target)) return;
    if (ignore && target.closest(ignore)) return;
    onOutside();
  };
  document.addEventListener("pointerdown", handle, true);
  return {
    update(next: { onOutside: () => void; ignore?: string }) {
      onOutside = next.onOutside;
      ignore = next.ignore;
    },
    destroy() {
      document.removeEventListener("pointerdown", handle, true);
    },
  };
}

// Wrap each <pre> in a .code-block with a copy button, and each <table> in a
// .table-wrap scroller. Idempotent. Use as `<div use:enhanceMarkdown={source}>{@html …}</div>`;
// re-runs after the html updates because Svelte calls update() on dependency change.
//
// Pass the SAME source text the sibling {@html} renders, so an unchanged param
// can skip the sweep: Svelte re-runs update() whenever the each-block item is
// re-emitted, and `updateState` re-emits the whole appState on every SSE token.
// Without the identity check, each message already in a long transcript paid two
// querySelectorAll passes per streamed token (see renderMarkdownCached).
export function enhanceMarkdown(node: HTMLElement, param?: unknown) {
  let last = param;
  const run = () => {
    node.querySelectorAll("pre").forEach((pre) => {
      if (pre.parentElement?.classList.contains("code-block")) return;
      const wrapper = document.createElement("div");
      wrapper.className = "code-block";
      pre.replaceWith(wrapper);
      wrapper.append(pre);
      const btn = document.createElement("button");
      btn.className = "code-copy";
      btn.type = "button";
      btn.setAttribute("aria-label", "코드 복사");
      btn.title = "코드 복사";
      btn.innerHTML = COPY_SVG;
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        void copyText((pre.querySelector("code") as HTMLElement)?.innerText ?? pre.innerText, btn);
      });
      wrapper.append(btn);
    });
    node.querySelectorAll("table").forEach((table) => {
      if (table.closest(".table-wrap")) return;
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.replaceWith(wrap);
      wrap.append(table);
    });
  };
  run();
  return {
    update(next?: unknown) {
      if (next === last) return;
      last = next;
      run();
    },
    destroy() {
      /* nothing to tear down */
    },
  };
}
