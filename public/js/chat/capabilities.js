// Auto-split from chat.js — submodule: capabilities panel + pointer/composer hints. Behavior-preserving relocation only.
import { api, el, newId, renderMarkdown, state } from "../core.js";
import { goView } from "../nav.js";

/**
 * Right-side panel showing what the avatar can do — its plugins (known
 * immediately from the avatar detail) and its skills (lazy-fetched from
 * `/api/avatars/:id/skills`, since resolving them may clone repos). Visible to
 * colleagues and the owner alike, so a teammate can see at a glance what the
 * avatar is equipped with before chatting.
 */
// Persisted UI prefs for the capabilities panel (width + collapsed). The app
// otherwise keeps state in memory, but panel size/visibility are preferences a
// user expects to survive a reload, so these two live in localStorage.
const CAP_WIDTH_MIN = 220;
const CAP_WIDTH_MAX = 720;
const CAP_WIDTH_DEFAULT = 480;
// Clamp so the panel can never squeeze the chat column out: leave room for the
// rail (248px) plus a readable transcript (~380px). Mirrors the CSS max-width.
function capWidthClamp(width) {
  const available = Math.max(CAP_WIDTH_MIN, window.innerWidth - 248 - 380);
  return Math.min(Math.min(CAP_WIDTH_MAX, available), Math.max(CAP_WIDTH_MIN, width));
}
// On phones the stacked panel starts collapsed — expanded it eats ~40% of the
// screen below the composer.
export function isFinePointer() {
  return window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)").matches : true;
}
// Flipped once we observe a hardware keystroke (see the composer keydown handler).
// A tablet reports a coarse primary pointer even with a keyboard attached, so the
// pointer media query alone can't tell — we infer it from KeyboardEvent.code.
let physicalKeyboardSeen = false;
function enterSends() {
  return isFinePointer() || physicalKeyboardSeen;
}
function refreshComposerHints() {
  state.chatPanes.forEach((p) => p.dom?.renderHint?.());
}
// Mutator for the shared physicalKeyboardSeen flag — invoked from the composer's
// keydown handler when a hardware keystroke is observed. Kept here (with the flag
// + enterSends + refreshComposerHints) so the state lives in exactly one module.
export function notePhysicalKeyboard() {
  if (!physicalKeyboardSeen) {
    physicalKeyboardSeen = true;
    refreshComposerHints();
  }
}
export { enterSends };
function isMobileLayout() {
  return window.matchMedia ? window.matchMedia("(max-width: 860px)").matches : false;
}
export function capPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
export function setCapPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode); prefs just won't persist */
  }
}

function openKnowledgeSettings() {
  state.settingsTab = "knowledge";
  goView("settings");
}

export function renderCapabilitiesPanel(av) {
  const skillsBody = el("div", { class: "cap-section-body cap-skills" });
  const plugins = av.plugins || [];
  const canManageCapabilities = state.user?.id === av.id;
  const bodyId = `cap-body-${av.id || newId()}`;
  const pluginEmpty = canManageCapabilities
    ? el("div", { class: "cap-empty cap-empty-action" }, [
        el("span", { text: "연결된 플러그인이 없습니다." }),
        el("button", { class: "linkish small", type: "button", text: "지식·플러그인 설정", onclick: openKnowledgeSettings }),
      ])
    : el("p", { class: "cap-empty", text: "연결된 플러그인이 없습니다." });
  const pluginsBody = el("div", { class: "cap-section-body cap-plugins" },
    plugins.length
      ? plugins.map((p) => el("div", { class: "cap-plugin" }, [
          el("span", { class: "cap-plugin-name", text: p.label || p.repo }),
          p.label ? el("span", { class: "cap-plugin-repo", text: p.repo }) : null,
        ]))
      : [pluginEmpty],
  );

  const collapseBtn = el("button", {
    class: "cap-collapse",
    type: "button",
    title: "패널 접기",
    "aria-label": "패널 접기",
    "aria-controls": bodyId,
    "aria-expanded": "true",
    text: "›",
  });
  // The avatar's self-introduction (markdown), shown atop the panel when present.
  const introText = (av.intro || "").trim();
  const introBlock = introText
    ? el("div", { class: "cap-intro" }, [el("div", { class: "cap-intro-text md", html: renderMarkdown(introText) })])
    : null;
  // Capability hashtags as chips under the intro — a viewer sees at a glance
  // what the avatar is good for.
  const capTags = av.hashtags || [];
  const tagsBlock = capTags.length
    ? el("div", { class: "cap-tags" }, capTags.map((t) => el("span", { class: "tag accent", text: `#${t}` })))
    : null;
  const body = el("div", { id: bodyId, class: "cap-body scroll-thin" }, [
    el("div", { class: "cap-head" }, [
      el("h3", { text: "이 아바타의 역량" }),
      el("p", { class: "cap-sub", text: `${av.displayName}이(가) 사용할 수 있는 도구` }),
    ]),
    introBlock,
    tagsBlock,
    el("div", { class: "cap-section" }, [
      el("div", { class: "cap-section-title", text: "스킬" }),
      skillsBody,
    ]),
    el("div", { class: "cap-section" }, [
      el("div", { class: "cap-section-title", text: "플러그인" }),
      pluginsBody,
    ]),
  ]);
  // Slim strip shown when collapsed: just an expand button. The text label
  // only renders in the stacked mobile bar (hidden on the desktop strip).
  const expandBtn = el("button", {
    class: "cap-expand",
    type: "button",
    title: "역량 패널 펼치기",
    "aria-label": "역량 패널 펼치기",
    "aria-controls": bodyId,
    "aria-expanded": "false",
  }, [
    el("span", { "aria-hidden": "true", text: "‹" }),
    el("span", { class: "cap-expand-label", text: "아바타 역량 보기" }),
  ]);
  // Drag handle on the panel's left edge to resize its width.
  const resizer = el("div", { class: "cap-resize", "aria-hidden": "true" });

  const startWidth = Number(capPref("capPanelWidth", String(CAP_WIDTH_DEFAULT))) || CAP_WIDTH_DEFAULT;
  const panel = el("aside", {
    class: "cap-panel",
    "aria-label": "아바타 역량",
    style: `width:${capWidthClamp(startWidth)}px`,
  }, [resizer, collapseBtn, body, expandBtn]);

  const initialCollapsed = capPref("capPanelCollapsed", isMobileLayout() ? "1" : "0") === "1";
  const setCollapsed = (collapsed) => {
    panel.classList.toggle("collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    expandBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    setCapPref("capPanelCollapsed", collapsed ? "1" : "0");
  };
  setCollapsed(initialCollapsed);
  collapseBtn.addEventListener("click", () => setCollapsed(true));
  expandBtn.addEventListener("click", () => setCollapsed(false));

  wireCapResize(resizer, panel);
  loadCapabilitySkills(av.id, skillsBody);
  return panel;
}

// Pointer-drag resize for the capabilities panel. The panel sits at the right
// edge, so dragging the handle left widens it (width grows as clientX shrinks).
function wireCapResize(handle, panel) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev) => {
      panel.style.width = `${capWidthClamp(startW + (startX - ev.clientX))}px`;
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setCapPref("capPanelWidth", String(Math.round(panel.getBoundingClientRect().width)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    // A cancelled pointer (touch interruption, gesture, context menu) would
    // otherwise never fire pointerup, leaving body stuck in .col-resizing.
    handle.addEventListener("pointercancel", onUp);
  });
}

/** Lazy-load and render an avatar's skills into the panel's skills section. */
async function loadCapabilitySkills(avatarId, body) {
  const renderState = (st) => {
    if (st.loading) {
      body.replaceChildren(el("p", { class: "cap-loading", text: "불러오는 중…" }));
    } else if (st.error) {
      body.replaceChildren(
        el("div", { class: "cap-empty cap-error" }, [
          el("span", { text: st.error }),
          el("button", {
            class: "linkish small",
            type: "button",
            text: "다시 시도",
            onclick: () => {
              delete state.skillsByAvatar[avatarId];
              loadCapabilitySkills(avatarId, body);
            },
          }),
        ]),
      );
    } else if (!st.skills.length) {
      const canManageCapabilities = state.user?.id === avatarId;
      body.replaceChildren(
        canManageCapabilities
          ? el("div", { class: "cap-empty cap-empty-action" }, [
              el("span", { text: "사용 가능한 스킬이 없습니다." }),
              el("button", { class: "linkish small", type: "button", text: "지식·플러그인 설정", onclick: openKnowledgeSettings }),
            ])
          : el("p", { class: "cap-empty", text: "사용 가능한 스킬이 없습니다." }),
      );
    } else {
      // Each skill is a collapsed accordion: name only by default, click to
      // reveal its (often long) description. The "default" source is implicit
      // and noisy, so only plugin-provided sources get a badge.
      body.replaceChildren(...st.skills.map((s) => {
        const hasDesc = Boolean(s.description);
        const fromPlugin = s.source && s.source !== "default";
        const head = el("button", {
          class: "cap-skill-head",
          type: "button",
          "aria-expanded": "false",
          disabled: hasDesc ? null : "",
        }, [
          hasDesc ? el("span", { class: "cap-skill-caret", text: "▸", "aria-hidden": "true" }) : null,
          el("span", { class: "cap-skill-name", text: s.name }),
          fromPlugin ? el("span", { class: "cap-skill-src", text: s.source }) : null,
        ]);
        const item = el("div", { class: "cap-skill" }, [head]);
        if (hasDesc) {
          const desc = el("p", { class: "cap-skill-desc", text: s.description });
          item.append(desc);
          head.addEventListener("click", () => {
            const open = item.classList.toggle("open");
            head.setAttribute("aria-expanded", open ? "true" : "false");
          });
        }
        return item;
      }));
    }
  };

  // Reuse a cached result (skills don't change within a session unless plugins
  // do). A still-loading entry means a fetch is already in flight — render its
  // state and bail rather than starting a duplicate request.
  const cached = state.skillsByAvatar[avatarId];
  if (cached && !cached.error) {
    renderState(cached);
    return;
  }
  const loadingState = { loading: true, error: "", skills: [] };
  state.skillsByAvatar[avatarId] = loadingState;
  renderState(loadingState);
  // Capture a generation token so the async completion can detect a stale panel
  // (e.g. the user navigated to a different avatar while the fetch was in flight).
  const targetBody = body;
  try {
    const { skills } = await api(`/api/avatars/${avatarId}/skills`);
    const done = { loading: false, error: "", skills: skills || [] };
    state.skillsByAvatar[avatarId] = done;
    // Bail if the panel element was replaced/detached or the avatar changed.
    if (state.currentAvatar?.id === avatarId && targetBody.isConnected) renderState(done);
  } catch (err) {
    const failed = { loading: false, error: "스킬을 불러오지 못했습니다.", skills: [] };
    state.skillsByAvatar[avatarId] = failed;
    if (state.currentAvatar?.id === avatarId && targetBody.isConnected) renderState(failed);
  }
}

/**
 * Drop the cached skills for an avatar so the capabilities panel re-fetches
 * next time it opens. Called whenever the owner mutates their own plugins —
 * the skill set is derived from those plugins, so the cache would go stale.
 */
export function invalidateSkillsCache(avatarId) {
  if (avatarId) delete state.skillsByAvatar[avatarId];
}
