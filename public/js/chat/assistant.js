// Auto-split from chat.js — submodule: assistant rendering + scroll. Behavior-preserving relocation only.
import { el, enhanceCodeBlocks, renderMarkdown } from "../core.js";
import { activePane } from "./panes.js";
import { RUNTIME_BADGE_LABELS } from "./composer.js";

export function renderAssistantInto(bubble, message) {
  const response = message.response;
  bubble.classList.toggle("blocked", response?.runtime === "blocked");
  bubble.classList.toggle("errored", response?.runtime === "error" || message.errored === true);
  if (response) {
    const meta = [];
    if (response.runtime && RUNTIME_BADGE_LABELS[response.runtime] !== null) {
      meta.push(["runtime", RUNTIME_BADGE_LABELS[response.runtime] || response.runtime, response.runtime]);
    }
    if (response.skillName) meta.push(["skill", response.skillName, ""]);
    if (meta.length) {
      const metaRow = el("div", { class: "response-meta" });
      for (const [kind, label, raw] of meta) metaRow.append(el("span", { class: `meta-badge ${kind === "runtime" ? `runtime-${raw}` : ""}`, text: label }));
      bubble.append(metaRow);
    }
    if (response.kind === "table" && response.table) {
      bubble.append(buildTable(response));
      if (response.text) {
        const md = el("div", { class: "md", html: renderMarkdown(response.text) });
        enhanceCodeBlocks(md);
        bubble.append(md);
      }
      return;
    }
    const md = el("div", { class: "md", html: renderMarkdown(response.text || response.summary) });
    enhanceCodeBlocks(md);
    bubble.append(md);
    return;
  }
  const md = el("div", { class: "md", html: renderMarkdown(message.content) });
  enhanceCodeBlocks(md);
  bubble.append(md);
}

function buildTable(response) {
  const columns = response.table.columns || [];
  const rows = response.table.rows || [];
  const wrap = el("div", {});
  if (response.title || response.summary) wrap.append(el("div", { class: "response-title", text: response.title || response.summary }));
  const tableWrap = el("div", { class: "table-wrap" });
  const table = el("table");
  const thead = el("tr");
  for (const c of columns) thead.append(el("th", { scope: "col", text: c }));
  table.append(el("thead", {}, [thead]));
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const c of columns) tr.append(el("td", { text: row[c] == null ? "" : String(row[c]) }));
    tbody.append(tr);
  }
  table.append(tbody);
  tableWrap.append(table);
  wrap.append(tableWrap);
  return wrap;
}

export function isNearBottom(pane = activePane()) {
  const t = pane?.dom?.transcript;
  if (!t) return true;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
export function scrollToBottom(pane = activePane(), force) {
  const t = pane?.dom?.transcript;
  if (!t) return;
  // Called from renderTranscript before the pane is appended to the document
  // (e.g. a full re-render when splitting or switching layout). A detached node
  // has scrollHeight 0, so setting scrollTop is a no-op and the transcript would
  // land at the top — defer to after attach so the latest messages stay in view.
  if (!t.isConnected) {
    requestAnimationFrame(() => scrollToBottom(pane, force));
    return;
  }
  // Follow the bottom when forced, or while the viewer hasn't scrolled away.
  // stickBottom is intent-based (set on user scroll); undefined defaults to true
  // for a fresh pane. force also re-pins (e.g. the "맨 아래로" button, send).
  if (force) pane.stickBottom = true;
  if (force || pane.stickBottom !== false) t.scrollTop = t.scrollHeight;
  updateScrollButton(pane);
}
export function updateScrollButton(pane = activePane()) {
  const pdom = pane?.dom;
  if (!pdom?.scrollBtn || !pdom?.transcript) return;
  const t = pdom.transcript;
  const scrollable = t.scrollHeight - t.clientHeight > 40;
  pdom.scrollBtn.hidden = !(scrollable && !isNearBottom(pane));
}
