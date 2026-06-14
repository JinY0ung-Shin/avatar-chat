// Auto-split from settings.js — submodule: index (shell + profile + visibility + user search).
// Behavior-preserving relocation only.
import { avatarNode, resizeImage } from "../avatar-image.js";
import { api, dom, el, icon, isSessionExpired, newId, notify, setFormBusy, state } from "../core.js";
import { buildHashtagEditor } from "../explore.js";
import { loadKnowledge, loadPlugins, refreshMe, updateKnowledgeBadge } from "../loaders.js";
import { renderView, syncHashAfterRoute } from "../nav.js";
import { buildTabBar, viewHeader, wireSegmentedRadioKeys } from "../shell.js";
import { buildGitCredentialsCard, buildSecretsCard } from "./secrets.js";
import { buildKnowledgeRepoCard } from "./knowledgeRepo.js";
import { buildPluginsCard } from "./plugins.js";
import { buildGroupsCard } from "./groups.js";

let settingsViewSeq = 0;

export async function renderSettings() {
  const renderSeq = ++settingsViewSeq;
  const header = viewHeader("내 아바타", "프로필과 플러그인을 관리하고 공개하세요");
  const body = el("div", { class: "view-body scroll-thin settings-body" });
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === settingsViewSeq && state.view === "settings" && body.isConnected;

  body.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  // One failed loader must NOT render every card as its empty state ("플러그인이
  // 없습니다" 등) — that reads as data loss and invites duplicate re-adds.
  const results = await Promise.allSettled([refreshMe(), loadPlugins(), loadKnowledge()]);
  if (isSessionExpired()) return;
  if (!isCurrent()) return;
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    body.replaceChildren(
      el("div", { class: "warn-box" }, [
        `설정 정보를 불러오지 못했습니다: ${failed.reason?.message || "네트워크 오류"} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }
  updateKnowledgeBadge();
  const u = state.user;

  // Profile card — picture edits update in place so typed-but-unsaved form
  // text in the rest of the card survives.
  const picWrap = el("div", { class: "pic-edit" });
  const fileInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: "" });
  const camBtn = el("button", { class: "pic-cam", type: "button", "aria-label": "사진 변경", title: "사진 변경", onclick: () => fileInput.click() });
  camBtn.append(icon("camera"));
  const delPicBtn = el("button", {
    class: "linkish small",
    type: "button",
    text: "사진 삭제",
    onclick: async () => {
      if (!window.confirm("아바타 사진을 삭제할까요?")) return;
      const saved = delPicBtn.textContent;
      delPicBtn.disabled = true;
      delPicBtn.textContent = "삭제 중…";
      camBtn.disabled = true;
      try {
        await api("/api/me/avatar-image", { method: "DELETE" });
        state.user.hasImage = false;
        delPicBtn.textContent = saved;
        delPicBtn.disabled = false;
        camBtn.disabled = false;
        renderPic();
        renderRailUser();
        notify("아바타 사진을 삭제했습니다.", "ok");
      } catch (e) {
        delPicBtn.textContent = saved;
        delPicBtn.disabled = false;
        camBtn.disabled = false;
        notify(`사진 삭제 실패: ${e.message}`);
      }
    },
  });
  const renderPic = () => {
    picWrap.replaceChildren(avatarNode(state.user, 96, { alt: "내 아바타 사진" }), camBtn, fileInput);
    if (state.user.hasImage) picWrap.append(delPicBtn);
  };
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const savedTitle = camBtn.title;
    camBtn.disabled = true;
    camBtn.title = "업로드 중…";
    camBtn.setAttribute("aria-label", "사진 업로드 중");
    delPicBtn.disabled = true;
    try {
      const dataUrl = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image: dataUrl }) });
      state.user.hasImage = true;
      camBtn.disabled = false;
      camBtn.title = savedTitle;
      camBtn.setAttribute("aria-label", "사진 변경");
      delPicBtn.disabled = false;
      renderPic();
      renderRailUser();
      notify("아바타 사진을 변경했습니다.", "ok");
    } catch (e) {
      camBtn.disabled = false;
      camBtn.title = savedTitle;
      camBtn.setAttribute("aria-label", "사진 변경");
      delPicBtn.disabled = false;
      notify(`업로드 실패: ${e.message}`);
    } finally {
      fileInput.value = "";
    }
  });
  renderPic();

  const profileForm = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        const res = await api("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ displayName: fd.get("displayName"), alias: fd.get("alias"), bio: fd.get("bio"), persona: fd.get("persona"), intro: fd.get("intro"), hashtags: hashtagEditor.getTags() }),
        });
        state.user = res.user;
        btn.textContent = "저장됨 ✓";
        notify("프로필을 저장했습니다.", "ok");
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
        if (dom.navButtons) renderRailUser();
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`저장 실패: ${err.message}`);
      }
    },
  });

  // Self-introduction field with an "auto-generate" button: the avatar writes a
  // first-person blurb from its persona + skills, dropped into this textarea for
  // the owner to review/edit before saving (it isn't persisted until 프로필 저장).
  const introField = el("textarea", {
    name: "intro",
    rows: "4",
    placeholder: "대화 상대에게 보여줄 자기소개. 직접 쓰거나 위의 '아바타가 자동 생성' 버튼으로 만들 수 있어요.",
    text: u.intro || "",
  });
  const introGenBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    text: "아바타가 자동 생성",
    onclick: async () => {
      introGenBtn.disabled = true;
      const label = introGenBtn.textContent;
      introGenBtn.textContent = "생성 중…";
      try {
        const { intro } = await api("/api/me/intro/generate", { method: "POST" });
        if (intro) {
          introField.value = intro;
          notify("자기소개 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
        } else {
          notify("생성된 자기소개가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
        }
      } catch (err) {
        notify(`자기소개 생성 실패: ${err.message}`);
      } finally {
        introGenBtn.textContent = label;
        introGenBtn.disabled = false;
      }
    },
  });

  // Capability hashtags with an "auto-generate" button: the avatar proposes a set
  // of searchable tags from its skills/persona, dropped into the chip editor for
  // the owner to tweak before saving (not persisted until 프로필 저장).
  const hashtagEditor = buildHashtagEditor(u.hashtags || []);
  const tagGenBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    text: "아바타가 자동 생성",
    onclick: async () => {
      tagGenBtn.disabled = true;
      const label = tagGenBtn.textContent;
      tagGenBtn.textContent = "생성 중…";
      try {
        const { hashtags } = await api("/api/me/hashtags/generate", { method: "POST" });
        if (hashtags && hashtags.length) {
          hashtagEditor.setTags(hashtags);
          notify("해시태그 초안이 채워졌습니다. 저장하려면 프로필 저장을 누르세요.", "info");
        } else {
          notify("생성된 해시태그가 없습니다. 스킬이나 플러그인을 먼저 연결해 보세요.", "info");
        }
      } catch (err) {
        notify(`해시태그 생성 실패: ${err.message}`);
      } finally {
        tagGenBtn.textContent = label;
        tagGenBtn.disabled = false;
      }
    },
  });

  profileForm.append(
    el("label", { class: "field" }, [el("span", { text: "표시 이름" }), el("input", { name: "displayName", value: u.displayName || "", required: "" })]),
    el("label", { class: "field" }, [
      el("span", { text: "별칭 (아바타가 스스로를 부르는 이름)" }),
      el("input", { name: "alias", value: u.alias || "", placeholder: "비우면 표시 이름을 사용합니다" }),
    ]),
    el("label", { class: "field" }, [el("span", { text: "소개 (한 줄)" }), el("input", { name: "bio", value: u.bio || "", placeholder: "어떤 아바타인지 소개하세요" })]),
    el("div", { class: "field" }, [
      el("div", { class: "field-row" }, [
        el("span", { text: "자기소개 (대화 패널 상단에 표시)" }),
        introGenBtn,
      ]),
      introField,
    ]),
    el("div", { class: "field" }, [
      el("div", { class: "field-row" }, [
        el("span", { text: "역량 해시태그 (탐색에서 검색됨)" }),
        tagGenBtn,
      ]),
      hashtagEditor.wrap,
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "페르소나 (행동 지침)" }),
      el("textarea", { name: "persona", rows: "4", placeholder: "이 아바타가 어떻게 행동해야 하는지 (선택)", text: u.persona || "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "프로필 저장" }),
  );

  // Visibility selector (모두 공개 / 그룹 공개 / 비공개) — updates in place: a full
  // renderView here would wipe whatever the user typed (but hasn't saved) above.
  const publishRow = buildVisibilitySelect(u.visibility || "group", async (val) => {
    const res = await api("/api/me", { method: "PATCH", body: JSON.stringify({ visibility: val }) });
    state.user = res.user;
    return res.user.visibility;
  });

  // Group the (many) settings cards into tabs so a single screen no longer
  // dumps everything into one long scroll. Each tab lazily builds its cards.
  const profileCard = el("section", { class: "settings-card" }, [
    el("div", { class: "settings-head" }, [picWrap, el("div", { class: "settings-id" }, [el("h3", { text: u.displayName }), el("div", { class: "muted", text: `@${u.username}` })])]),
    profileForm,
  ]);
  const publishCard = el("section", { class: "settings-card" }, [el("h3", { text: "공개 설정" }), publishRow]);

  const tabs = [
    { id: "profile", label: "프로필", icon: "user", cards: () => [profileCard, publishCard] },
    { id: "access", label: "권한·연결", icon: "shield", cards: () => [buildGitCredentialsCard(), buildSecretsCard()] },
    { id: "knowledge", label: "지식·플러그인", icon: "book", cards: () => [buildKnowledgeRepoCard(), buildPluginsCard()] },
    { id: "groups", label: "그룹", icon: "users", cards: () => [buildGroupsCard()] },
  ];
  const requestedSettingsTab = state.settingsTab;
  if (!tabs.some((t) => t.id === state.settingsTab)) state.settingsTab = "profile";
  if (state.settingsTab !== requestedSettingsTab) syncHashAfterRoute();

  const panel = el("div", { class: "settings-panel", role: "tabpanel", id: "settings-panel" });
  const renderTab = () => {
    const active = tabs.find((t) => t.id === state.settingsTab) || tabs[0];
    body.classList.toggle("settings-body-access", active.id === "access");
    panel.classList.toggle("settings-panel-access", active.id === "access");
    panel.setAttribute("aria-labelledby", `settings-tab-${active.id}`);
    panel.replaceChildren(...active.cards());
  };

  const { tabBar, syncTabs } = buildTabBar({
    tabs,
    getTab: () => state.settingsTab,
    setTab: (id) => { state.settingsTab = id; },
    ariaLabel: "설정 분류",
    idPrefix: "settings-tab",
    panelId: "settings-panel",
    onActivate: renderTab,
  });
  renderTab();
  if (!isCurrent()) return;
  body.replaceChildren(tabBar, panel);
  syncTabs();
}

function renderRailUser() {
  // refresh the rail "me" row (name + picture) after profile edits
  const meRow = dom.rail?.querySelector(".rail-me");
  if (!meRow) return;
  const nameEl = meRow.querySelector(".meta b");
  if (nameEl) nameEl.textContent = state.user.displayName;
  const oldAvatar = meRow.querySelector(".avatar-img");
  if (oldAvatar) oldAvatar.replaceWith(avatarNode(state.user, 34, { alt: "" }));
}

// The three avatar-visibility choices, in display order. `value` matches the
// server's AvatarVisibility enum; `desc` is the explanatory line under the picker.
const VISIBILITY_OPTIONS = [
  { value: "public", label: "모두 공개", desc: "모든 사용자가 탐색에서 찾아 대화할 수 있어요." },
  { value: "group", label: "그룹 공개", desc: "같은 그룹 멤버만 탐색에서 찾아 대화할 수 있어요." },
  { value: "private", label: "비공개", desc: "나만 볼 수 있어요." },
];

// Segmented radio control for avatar visibility. `onChange(value)` should
// persist and resolve to the saved value (the server is authoritative); on
// rejection the selection reverts and a toast shows. Optimistically highlights
// the chosen option while the save is in flight.
function buildVisibilitySelect(current, onChange) {
  let value = VISIBILITY_OPTIONS.some((o) => o.value === current) ? current : "group";
  let saving = false;
  const desc = el("p", { class: "muted" });
  const seg = el("div", { class: "seg-control", role: "radiogroup", "aria-label": "아바타 공개 범위" });
  const buttons = new Map();
  const sync = () => {
    seg.setAttribute("aria-busy", saving ? "true" : "false");
    for (const [val, btn] of buttons) {
      const active = val === value;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
      btn.disabled = saving;
    }
    const baseDesc = VISIBILITY_OPTIONS.find((o) => o.value === value)?.desc || "";
    desc.textContent = saving ? `${baseDesc} 저장 중…` : baseDesc;
  };
  const choose = async (val) => {
    if (saving || val === value) return;
    const prev = value;
    value = val;
    saving = true;
    sync();
    try {
      const saved = await onChange(val);
      if (saved && saved !== value) {
        value = saved;
        sync();
        const savedLabel = VISIBILITY_OPTIONS.find((o) => o.value === saved)?.label || saved;
        notify(`공개 범위가 서버에서 ${savedLabel}(으)로 저장되었습니다.`, "warn");
      } else {
        const savedLabel = VISIBILITY_OPTIONS.find((o) => o.value === value)?.label || value;
        notify(`공개 범위를 ${savedLabel}(으)로 변경했습니다.`, "ok");
      }
    } catch (e) {
      value = prev;
      notify(`공개 범위 변경 실패: ${e.message}`);
    } finally {
      saving = false;
      sync();
    }
  };
  for (const opt of VISIBILITY_OPTIONS) {
    const btn = el("button", { type: "button", class: "seg-btn", role: "radio", dataset: { value: opt.value }, text: opt.label, onclick: () => choose(opt.value) });
    buttons.set(opt.value, btn);
    seg.append(btn);
  }
  wireSegmentedRadioKeys(seg);
  sync();
  return el("div", { class: "visibility-row" }, [seg, desc]);
}

// Turn a text input into a user typeahead: searches /api/me/users/search and
// shows a dropdown of matches; picking one fills the input with that @username.
// Returns a wrapper element (input + results) to place in the layout. Used by
// the group member-add forms — group membership is how trust/elevation is
// granted, so finding people by name (not just exact username) matters.
export function attachUserSearch(input, opts = {}) {
  const {
    onSelect = null,
    excludeUserIds = () => new Set(),
    excludeUsernames = () => new Set(),
  } = opts;
  const resultsId = `user-search-${newId()}`;
  const results = el("div", { id: resultsId, class: "trusted-results", role: "listbox", hidden: "" });
  const wrap = el("div", { class: "trusted-search" }, [input, results]);
  let seq = 0;
  let timer = null;
  let activeIndex = -1;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", resultsId);
  input.setAttribute("aria-expanded", "false");

  const optionButtons = () => [...results.querySelectorAll(".trusted-result")];
  const hideResults = () => {
    activeIndex = -1;
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const syncActive = () => {
    const buttons = optionButtons();
    buttons.forEach((btn, idx) => {
      const active = idx === activeIndex;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      if (active) input.setAttribute("aria-activedescendant", btn.id);
    });
    if (!buttons.length || activeIndex < 0) input.removeAttribute("aria-activedescendant");
  };
  const chooseUser = (user) => {
    if (onSelect) {
      const accepted = onSelect(user);
      if (accepted !== false) input.value = "";
    } else {
      input.value = user.username;
    }
    hideResults();
    input.focus();
  };
  const render = (users) => {
    results.replaceChildren();
    const excludedIds = excludeUserIds();
    const excludedNames = excludeUsernames();
    const visibleUsers = users.filter((u) => {
      const key = (u.username || "").toLowerCase();
      return !(excludedIds.has(u.id) || excludedNames.has(key));
    });
    if (!visibleUsers.length) {
      activeIndex = -1;
      results.append(el("div", { class: "empty-note", text: "일치하는 사용자가 없습니다." }));
    } else {
      activeIndex = 0;
      visibleUsers.forEach((u, idx) => {
        results.append(
          el("button", {
            id: `${resultsId}-${idx}`,
            type: "button",
            class: "trusted-result",
            role: "option",
            "aria-selected": idx === activeIndex ? "true" : "false",
            onclick: () => chooseUser(u),
          }, [
            el("div", { class: "pr-main" }, [
              el("strong", { text: u.displayName }),
              el("div", { class: "pr-sub", text: `@${u.username}` }),
            ]),
          ]),
        );
      });
    }
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
    syncActive();
  };
  const run = async (q) => {
    const s = ++seq;
    try {
      const { users } = await api(`/api/me/users/search?q=${encodeURIComponent(q)}`);
      if (s === seq) render(users);
    } catch {
      if (s === seq) hideResults();
    }
  };
  input.addEventListener("input", () => {
    const q = input.value.trim().replace(/^@/, "");
    clearTimeout(timer);
    if (!q) { seq++; results.replaceChildren(); hideResults(); return; }
    timer = setTimeout(() => run(q), 200);
  });
  input.addEventListener("keydown", (e) => {
    const buttons = optionButtons();
    if (e.key === "Escape" && !results.hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hideResults();
      return;
    }
    if (results.hidden || !buttons.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + step + buttons.length) % buttons.length;
      syncActive();
      buttons[activeIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation();
      buttons[activeIndex].click();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => { if (!wrap.contains(document.activeElement)) hideResults(); }, 150);
  });
  return wrap;
}
