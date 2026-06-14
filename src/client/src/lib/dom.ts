// DOM helpers ported from the old core.js: clipboard copy with button flash,
// and a Svelte action that enhances rendered markdown (code-block copy buttons +
// horizontally-scrollable tables) the way enhanceCodeBlocks() used to.

const COPY_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

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
export function autosize(node: HTMLTextAreaElement) {
  const grow = () => {
    node.style.height = "auto";
    const cap = Math.min(200, Math.round(window.innerHeight * 0.3));
    node.style.height = `${Math.min(node.scrollHeight, cap)}px`;
  };
  grow();
  node.addEventListener("input", grow);
  return {
    update: grow,
    destroy() {
      node.removeEventListener("input", grow);
    },
  };
}

// Wrap each <pre> in a .code-block with a copy button, and each <table> in a
// .table-wrap scroller. Idempotent. Use as `<div use:enhanceMarkdown>{@html …}</div>`;
// re-runs after the html updates because Svelte calls update() on dependency change.
export function enhanceMarkdown(node: HTMLElement, _param?: unknown) {
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
    update: run,
    destroy() {
      /* nothing to tear down */
    },
  };
}
