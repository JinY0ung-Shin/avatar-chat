// Auto-split from app.js — module: shell. Behavior-preserving relocation only.
import { avatarNode } from "./avatar-image.js";
import { anyChatStreaming, isFinePointer, renderConversations } from "./chat.js";
import { app, dom, el, getThemePref, icon, newId, notify, setThemePref, state } from "./core.js";
import { logout } from "./lifecycle.js";
import { goView, syncHash } from "./nav.js";


/* ============================================================ App shell */
const THEME_LABELS = { system: "시스템", light: "라이트", dark: "다크" };
const THEME_ICONS = { system: "monitor", light: "sun", dark: "moon" };
const THEME_ORDER = ["system", "light", "dark"];

// One icon button that cycles 시스템 → 라이트 → 다크. "시스템" follows the OS;
// the actual light/dark application + persistence lives in core (setThemePref).
function buildThemeToggle() {
  const btn = el("button", { class: "icon-button", type: "button" });
  const sync = () => {
    const pref = getThemePref();
    btn.replaceChildren(icon(THEME_ICONS[pref]));
    const label = `테마: ${THEME_LABELS[pref]}`;
    btn.title = `${label} (클릭하여 변경)`;
    btn.setAttribute("aria-label", label);
  };
  btn.onclick = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(getThemePref()) + 1) % THEME_ORDER.length];
    setThemePref(next);
    sync();
    notify(`테마: ${THEME_LABELS[next]}`, "info");
  };
  sync();
  return btn;
}

export function mountShell() {
  const admin = state.user.roles?.includes("admin");

  dom.navButtons = {};
  const nav = el("nav", { class: "rail-nav", "aria-label": "주 메뉴" });
  const navItem = (view, label, ic) => {
    const btn = el("button", { class: "nav-item", type: "button", dataset: { view }, onclick: () => goView(view) }, [
      icon(ic),
      el("span", { text: label }),
    ]);
    dom.navButtons[view] = btn;
    nav.append(btn);
    return btn;
  };
  navItem("explore", "탐색", "compass");
  navItem("chat", "대화", "chat");
  navItem("inbox", "알림", "bell");
  navItem("routines", "루틴", "clock");
  navItem("settings", "내 아바타", "user");
  if (admin) navItem("admin", "관리자", "shield");

  const newChatBtn = el("button", { class: "new-chat", type: "button", onclick: () => goView("explore") }, [
    icon("plus"),
    el("span", { text: "새 대화" }),
  ]);

  dom.convList = el("div", { class: "conv-list scroll-thin" });
  dom.convList.append(el("div", { class: "conv-empty", text: "불러오는 중…" }));
  dom.convSearch = el("input", {
    class: "conv-search",
    type: "search",
    placeholder: "대화 불러오는 중",
    "aria-label": "대화 검색",
    disabled: "",
    oninput: () => renderConversations(),
  });

  const meRow = el("button", { class: "rail-me", type: "button", title: "내 아바타 설정", onclick: () => goView("settings") }, [
    avatarNode(state.user, 34, { alt: "" }),
    el("div", { class: "meta" }, [
      el("b", { text: state.user.displayName }),
      el("span", { text: `@${state.user.username}` }),
    ]),
  ]);
  const logoutBtn = el("button", { class: "icon-button", type: "button", "aria-label": "로그아웃", title: "로그아웃", onclick: () => logout(logoutBtn) });
  logoutBtn.append(icon("logout"));

  const rail = el("aside", { class: "rail", id: "rail", "aria-label": "대화 목록" }, [
    el("div", { class: "rail-head" }, [
      el("div", { class: "rail-brand" }, [
        el("img", { class: "mark", src: "/icon-192.png", alt: "", "aria-hidden": "true", width: "34", height: "34" }),
        el("div", {}, [el("div", { class: "name", text: "Noah Almighty" }), el("div", { class: "sub", text: "아바타 플랫폼" })]),
      ]),
      nav,
      newChatBtn,
    ]),
    el("div", { class: "rail-history" }, [
      el("div", { class: "rail-section-label", text: "내 대화" }),
      el("div", { class: "conv-list-wrap" }, [dom.convSearch, dom.convList]),
    ]),
    el("div", { class: "rail-footer" }, [el("div", { class: "rail-user-row" }, [meRow, buildThemeToggle(), logoutBtn])]),
  ]);

  const railToggle = el("button", { class: "icon-button rail-toggle", type: "button", "aria-label": "메뉴 열기", title: "메뉴", onclick: () => openRail() });
  railToggle.append(icon("menu"));
  dom.railToggle = railToggle;

  dom.main = el("main", { class: "main", id: "main" });
  dom.railBackdrop = el("div", { class: "rail-backdrop", onclick: () => closeRail() });

  // Polite status line for screen readers (streamed replies are announced once
  // on completion instead of flooding on every token).
  dom.srStatus = el("div", { class: "sr-only", role: "status", "aria-live": "polite" });

  // Interactive prompts (permission / AskUserQuestion) surface as a standalone
  // centered modal — not inside the chat bubble — so the owner can't miss them;
  // it's dismissed once they respond (or when the run ends).
  dom.promptModal = el("div", { class: "prompt-modal-backdrop", hidden: true });
  dom.promptModal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      dom.promptModal.querySelector("[data-prompt-cancel]")?.click();
    } else if (event.key === "Tab") {
      trapTab(event, dom.promptModal);
    }
  });
  // Clicking the scrim (outside the card) dismisses via the card's own
  // cancel/skip — an obvious escape so a prompt never feels like a hard trap.
  dom.promptModal.addEventListener("click", (event) => {
    if (event.target === dom.promptModal) {
      dom.promptModal.querySelector("[data-prompt-cancel]")?.click();
    }
  });

  app.replaceChildren(el("section", { class: "workspace" }, [rail, dom.main]), dom.railBackdrop, dom.promptModal, dom.srStatus);
  dom.rail = rail;
}

/* ---- Prompt modal queue ------------------------------------------------
   Split panes can raise prompts concurrently; a single global modal would let
   the second card silently destroy the first (stalling that run forever). We
   queue instead, and a finishing run only dismisses ITS OWN cards. */
export const promptQueue = [];
let promptRestoreFocus = null;

function trapTab(event, container) {
  const focusables = [...container.querySelectorAll(
    "button:not(:disabled), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )].filter((el) => !el.disabled && el.getAttribute("aria-hidden") !== "true");
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    last.focus();
    event.preventDefault();
  } else if (!event.shiftKey && document.activeElement === last) {
    first.focus();
    event.preventDefault();
  }
}

export function showPromptModal(card, runKey = "") {
  if (!dom.promptModal) return;
  card.dataset.run = runKey || "";
  if (!dom.promptModal.hidden && dom.promptModal.firstChild && dom.promptModal.firstChild !== card) {
    promptQueue.push(card);
    return;
  }
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  const titleEl = card.querySelector(".prompt-title") || card.querySelector(".prompt-head-label");
  if (titleEl) {
    if (!titleEl.id) titleEl.id = `prompt-title-${newId()}`;
    card.setAttribute("aria-labelledby", titleEl.id);
  }
  // Capture only at the START of a prompt session — advancing between queued
  // cards passes through here with focus already on <body>.
  if (dom.promptModal.hidden && !promptRestoreFocus) {
    promptRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  dom.promptModal.replaceChildren(card);
  dom.promptModal.hidden = false;
  // Skip the header ✕ for initial focus (it stays Tab-reachable) so focus lands
  // on the first real control — an option to pick, not the dismiss button.
  (card.querySelector("button:not(:disabled):not(.prompt-close), input, select, textarea") || card).focus?.();
}

// Hide the current card and surface the next queued one (or close + restore focus).
export function advancePromptModal() {
  if (!dom.promptModal) return;
  dom.promptModal.replaceChildren();
  const next = promptQueue.shift();
  if (next) {
    dom.promptModal.hidden = true; // force showPromptModal down its "show now" path
    showPromptModal(next, next.dataset.run);
    return;
  }
  dom.promptModal.hidden = true;
  if (promptRestoreFocus?.isConnected) promptRestoreFocus.focus?.();
  promptRestoreFocus = null;
}

// A run ended: drop its queued cards and dismiss its visible card (only its own).
export function dismissRunPrompts(runKey) {
  const key = runKey || "";
  for (let i = promptQueue.length - 1; i >= 0; i--) {
    if ((promptQueue[i].dataset.run || "") === key) promptQueue.splice(i, 1);
  }
  const current = dom.promptModal?.firstChild;
  if (current && (current.dataset.run || "") === key) advancePromptModal();
}

export function hidePromptModal() {
  if (!dom.promptModal) return;
  promptQueue.length = 0;
  dom.promptModal.hidden = true;
  dom.promptModal.replaceChildren();
}

function openRail() {
  dom.rail.classList.add("open");
  dom.railBackdrop.classList.add("open");
  dom.rail.querySelector(".nav-item")?.focus();
}
export function closeRail() {
  const wasOpen = dom.rail?.classList.contains("open");
  dom.rail?.classList.remove("open");
  dom.railBackdrop?.classList.remove("open");
  if (wasOpen && dom.rail?.contains(document.activeElement)) dom.railToggle?.focus();
}

// Escape closes the mobile rail drawer (modals handle their own Escape and
// stop propagation before this fires). Lives here (not core) since shell owns the rail.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (dom.promptModal && !dom.promptModal.hidden) return;
  if (document.querySelector(".modal-overlay")) return;
  if (dom.rail?.classList.contains("open")) closeRail();
});

// View changes do not stop an in-flight chat. The fetch keeps running in the
// background, and the live bubble is reattached if the user returns to Chat.
export function noteStreamingContinues() {
  if (!anyChatStreaming()) return;
  notify("응답은 백그라운드에서 계속 생성됩니다. 대화 화면으로 돌아오면 이어서 볼 수 있습니다.", "info");
}

export function viewHeader(title, sub, extra) {
  const left = el("div", { class: "header-left" }, [
    dom.railToggle,
    el("div", { class: "title" }, [el("h1", { text: title }), sub ? el("p", { text: sub }) : null]),
  ]);
  return el("header", { class: "view-header" }, [left, extra || el("div", {})]);
}

/* ============================================================ Settings (my avatar) */
// Shared tablist builder used by renderSettings and renderAdmin.
// tabs: array of { id, label, icon? }
// getTab: () => current tab id
// setTab: (id) => void — updates state
// ariaLabel: string for the nav element
// idPrefix: string prepended to "tab-<id>" for each button id
// panelId: aria-controls value
// onActivate: () => void — called after setTab when a tab is clicked
// Returns { tabBar, syncTabs } — caller appends tabBar and calls syncTabs() once.
export function buildTabBar({ tabs, getTab, setTab, ariaLabel, idPrefix, panelId, onActivate }) {
  const tabBar = el("nav", { class: "settings-tabs", role: "tablist", "aria-label": ariaLabel });
  const scrollActiveTabIntoView = () => {
    const active = tabBar.querySelector(".settings-tab.active");
    if (!active || !tabBar.isConnected) return;
    requestAnimationFrame(() => active.scrollIntoView({ block: "nearest", inline: "nearest" }));
  };
  const syncTabs = () => {
    for (const b of tabBar.children) {
      const active = b.dataset.tab === getTab();
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      b.tabIndex = active ? 0 : -1;
    }
    scrollActiveTabIntoView();
  };
  for (const t of tabs) {
    const btn = el("button", {
      class: "settings-tab" + (t.id === getTab() ? " active" : ""),
      type: "button",
      role: "tab",
      id: `${idPrefix}-${t.id}`,
      "aria-controls": panelId,
      dataset: { tab: t.id },
      onclick: () => {
        if (getTab() === t.id) return;
        setTab(t.id);
        syncHash(true);
        syncTabs();
        onActivate();
      },
    });
    if (t.icon) btn.append(icon(t.icon));
    btn.append(el("span", { text: t.label }));
    tabBar.append(btn);
  }
  // Standard tablist keyboard interaction: arrows/Home/End move + activate.
  tabBar.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = [...tabBar.children];
    if (!items.length) return;
    const idx = items.findIndex((b) => b.dataset.tab === getTab());
    const current = idx >= 0 ? idx : 0;
    const nextIndex =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : (current + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
    const next = items[nextIndex];
    next.focus();
    next.click();
  });
  return { tabBar, syncTabs };
}

export function wireSegmentedRadioKeys(group) {
  group.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const buttons = [...group.querySelectorAll('button[role="radio"]:not(:disabled)')];
    if (!buttons.length) return;
    e.preventDefault();
    const activeIndex = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
    const focusIndex = buttons.indexOf(document.activeElement);
    const current = activeIndex >= 0 ? activeIndex : Math.max(0, focusIndex);
    const nextIndex =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (current + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : buttons.length - 1)) % buttons.length;
    const next = buttons[nextIndex];
    const nextValue = next.dataset.value || "";
    next.focus();
    next.click();
    requestAnimationFrame(() => {
      const currentButtons = [...group.querySelectorAll('button[role="radio"]:not(:disabled)')];
      const target = currentButtons.find((b) => nextValue && b.dataset.value === nextValue) ||
        currentButtons.find((b) => b.getAttribute("aria-checked") === "true");
      target?.focus();
    });
  });
}

// Generic modal builder used by openRoutineModal and openOnboarding.
// Handles: restoreFocus, overlay + card creation, backdrop click, document-level
// Escape/Tab (capture, cleaned up on close). Returns { overlay, close }.
// buildCard(card, close) populates the card element and returns { focusTarget }
// where focusTarget is the element to focus on fine-pointer devices.
// onBeforeClose() is called before overlay.remove() (e.g. bookkeeping).
export function openModal({ cardClass, ariaLabelledby, buildCard, onBeforeClose, canClose } = {}) {
  const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const card = el("div", { class: `modal-card ${cardClass}`, tabindex: "-1" });
  const overlay = el("div", { class: "modal-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": ariaLabelledby }, [card]);
  const close = () => {
    if (canClose && !canClose()) return false;
    onBeforeClose?.();
    overlay.remove();
    document.removeEventListener("keydown", onKeydown, true);
    restoreFocus?.focus?.();
    return true;
  };
  const { focusTarget } = buildCard(card, close);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  const onKeydown = (e) => {
    if (!overlay.isConnected) return;
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    else if (e.key === "Tab") { trapTab(e, overlay); }
  };
  document.addEventListener("keydown", onKeydown, true);
  document.body.append(overlay);
  if (isFinePointer()) focusTarget?.focus();
  else card.focus();
  return { overlay, close };
}

// Accessible switch. `label` names it for screen readers (a bare "switch"
// announcing nothing is a WCAG hard-fail). The button disables while onChange
// is in flight and only flips visually when it resolves — callers should
// re-throw on failure so a failed save doesn't render as "on".
export function buildToggle(on, onChange, label) {
  const btn = el("button", {
    class: `toggle ${on ? "on" : ""}`,
    type: "button",
    role: "switch",
    "aria-checked": on ? "true" : "false",
    "aria-label": label || "사용",
    title: label || null,
  }, [el("span", { class: "knob" })]);
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    const next = !btn.classList.contains("on");
    btn.disabled = true;
    try {
      await onChange(next);
      btn.classList.toggle("on", next);
      btn.setAttribute("aria-checked", next ? "true" : "false");
    } catch {
      /* caller already surfaced the error; keep previous visual state */
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
