// Auto-split from app.js — module: settings. Behavior-preserving relocation only.
import { buildRevealableInput } from "./auth.js";
import { avatarNode, resizeImage } from "./avatar-image.js";
import { chatAboutTopic, invalidateSkillsCache } from "./chat.js";
import { api, copyText, dom, el, icon, isSessionExpired, newId, notify, setFormBusy, state, timeLabel, wireExpander } from "./core.js";
import { buildHashtagEditor, startChatWith } from "./explore.js";
import { openOnboarding } from "./lifecycle.js";
import { loadKnowledge, loadPlugins, refreshMe, updateKnowledgeBadge } from "./loaders.js";
import { goView, renderView, syncHash, syncHashAfterRoute } from "./nav.js";
import { buildTabBar, buildToggle, viewHeader, wireSegmentedRadioKeys } from "./shell.js";


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
function attachUserSearch(input, opts = {}) {
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

function buildPluginsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [el("h3", { text: "GitHub 플러그인" }), el("p", { class: "muted", text: "내 아바타가 사용할 플러그인. 다른 사용자와의 대화에서는 읽기 전용으로 실행됩니다." })]),
    ]),
  );
  const list = el("div", { class: "plugin-rows" });
  card.append(list);
  let repoInput;
  const focusPluginForm = () => repoInput?.focus();

  const form = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      // Capture the form node now: event.currentTarget is nulled after the
      // handler's first await, so referencing it later would throw and surface
      // a false "추가 실패" even though the plugin was added.
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const repo = (fd.get("repo") || "").toString().trim();
      const ref = (fd.get("ref") || "").toString().trim();
      const label = (fd.get("label") || "").toString().trim();
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "추가 중…"; // server-side git clone — can take a while
      try {
        await api("/api/me/plugins", { method: "POST", body: JSON.stringify({ repo, ref: ref || undefined, label: label || undefined }) });
        await loadPlugins();
        renderPluginRows(list, focusPluginForm);
        state.user.pluginCount = state.plugins.length;
        invalidateSkillsCache(state.user.id);
        formEl.reset();
        notify(`플러그인 "${label || repo}"을 추가했습니다.`, "ok");
      } catch (err) {
        notify(`플러그인 추가 실패: ${err.message}`);
      } finally {
        btn.textContent = saved;
        setFormBusy(formEl, false);
      }
    },
  }, [
    repoInput = el("input", { name: "repo", placeholder: "owner/repo 또는 git URL", "aria-label": "플러그인 저장소 (owner/repo 또는 git URL)", required: "" }),
    el("input", { name: "ref", placeholder: "브랜치/태그 (선택)", "aria-label": "브랜치/태그 (선택)", class: "narrow" }),
    el("input", { name: "label", placeholder: "라벨 (선택)", "aria-label": "라벨 (선택)", class: "narrow" }),
    el("button", { class: "primary", type: "submit", text: "추가" }),
  ]);
  form.classList.add("rows-3");
  card.append(form);
  renderPluginRows(list, focusPluginForm);
  return card;
}

function pluginSyncLabel(p) {
  if (!p.lastSyncedAt) return "아직 동기화되지 않음";
  const d = new Date(p.lastSyncedAt);
  if (Number.isNaN(d.getTime())) return "";
  return `동기화: ${timeLabel(p.lastSyncedAt)}`;
}

function renderPluginRows(list, focusAddForm = null) {
  list.replaceChildren();
  if (!state.plugins.length) {
    list.append(
      el("div", { class: "empty-note" }, [
        "추가한 플러그인이 없습니다.\n",
        focusAddForm ? el("button", { class: "linkish small", type: "button", text: "플러그인 저장소 입력", onclick: focusAddForm }) : null,
      ]),
    );
    return;
  }
  for (const p of state.plugins) {
    const selSummary = !p.selected
      ? "모든 플러그인 사용"
      : `${p.selected.length}개 선택됨`;
    const sub = el("div", { class: "pr-sub", text: p.ref ? `${p.repo} @ ${p.ref}` : p.repo });
    const meta = el("div", { class: "pr-meta muted" }, [pluginSyncLabel(p), " · ", selSummary]);

    const row = el("div", { class: "plugin-row" }, [
      el("div", { class: "pr-main" }, [
        el("strong", { text: p.label || p.repo }),
        sub,
        meta,
      ]),
      buildToggle(p.enabled, async (val) => {
        setFormBusy(row, true);
        try {
          await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: val }) });
          p.enabled = val;
          invalidateSkillsCache(state.user.id);
          renderPluginRows(list);
          notify(`"${p.label || p.repo}" 플러그인을 ${val ? "사용" : "사용 중지"}했습니다.`, "ok");
        } catch (e) {
          notify(`변경 실패: ${e.message}`);
          throw e;
        } finally {
          if (row.isConnected) setFormBusy(row, false);
        }
      }, `플러그인 사용: ${p.label || p.repo}`),
    ]);

    // Expandable contents area for per-plugin selection within the repo.
    const contents = el("div", { class: "plugin-contents", hidden: "" });

    // "선택" — clone/inspect the repo and show a checkbox per contained plugin.
    const selectBtn = el("button", { class: "msg-act", type: "button", "aria-label": "저장소 내 플러그인 선택", title: "저장소 내 플러그인 선택", "aria-expanded": "false" });
    const reloadPluginContents = wireExpander(selectBtn, contents, async (c) => {
      c.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
      try {
        const { contents: info } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}/contents`);
        renderPluginContents(c, list, p, info);
      } catch (e) {
        c.replaceChildren(el("div", { class: "error-note" }, [
          `조회 실패: ${e.message} `,
          el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => reloadPluginContents() }),
        ]));
      }
    });
    selectBtn.append(icon("menu"));
    row.append(selectBtn);

    // "새로고침" — force git fetch + checkout, bypassing the clone cache.
    const refreshBtn = el("button", { class: "msg-act", type: "button", "aria-label": "최신 버전으로 새로고침", title: "최신 버전으로 새로고침", onclick: async () => {
      setFormBusy(row, true);
      refreshBtn.classList.add("spinning");
      try {
        const { plugin } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}/refresh`, { method: "POST" });
        Object.assign(p, plugin);
        invalidateSkillsCache(state.user.id);
        renderPluginRows(list);
        notify(`"${p.label || p.repo}" 플러그인을 최신 버전으로 새로고침했습니다.`, "ok");
      } catch (e) {
        notify(`새로고침 실패: ${e.message}`);
      } finally {
        refreshBtn.classList.remove("spinning");
        if (row.isConnected) setFormBusy(row, false);
      }
    } });
    refreshBtn.append(icon("refresh"));
    row.append(refreshBtn);

    const del = el("button", { class: "msg-act danger", type: "button", "aria-label": `플러그인 삭제: ${p.label || p.repo}`, title: "삭제", onclick: async () => {
      if (!window.confirm(`플러그인 "${p.label || p.repo}"을(를) 삭제할까요?`)) return;
      setFormBusy(row, true);
      try {
        await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "DELETE" });
        state.plugins = state.plugins.filter((x) => x.id !== p.id);
        state.user.pluginCount = state.plugins.length;
        invalidateSkillsCache(state.user.id);
        renderPluginRows(list);
        notify(`"${p.label || p.repo}" 플러그인을 삭제했습니다.`, "ok");
      } catch (e) {
        if (row.isConnected) setFormBusy(row, false);
        notify(`삭제 실패: ${e.message}`);
      }
    } });
    del.append(icon("trash"));
    row.append(del);

    list.append(row);
    list.append(contents);
  }
}

// Shared core for plugin-selection UIs. `getSelected()` returns the current
// selection array-or-null; `onSave(selected)` persists it and returns a promise.
// Used by plugin, personal knowledge repo, and group knowledge repo selectors;
// all three must produce identical DOM/behavior, differing only in selection
// source and save destination.
function renderPluginSelectionContents(container, info, { getSelected, onSave, headText }) {
  container.replaceChildren();
  if (info.kind === "none") {
    container.append(el("div", { class: "error-note", text: "Claude 플러그인 저장소가 아닙니다 (plugin.json / marketplace.json 없음)." }));
    return;
  }
  if (info.kind === "single") {
    container.append(el("div", { class: "muted", text: "단일 플러그인 저장소입니다 — 선택할 항목이 없습니다." }));
    return;
  }
  if (!info.plugins.length) {
    container.append(el("div", { class: "muted", text: "불러올 수 있는 플러그인이 없습니다." }));
    return;
  }

  // null selection = all enabled; otherwise only names in the set.
  const currentSelected = getSelected();
  const selectedSet = currentSelected ? new Set(currentSelected) : null;
  const checks = [];
  const loadableNames = info.plugins.filter((entry) => entry.loadable).map((entry) => entry.name);
  const selectionSummary = el("div", { class: "pc-summary muted", role: "status", "aria-live": "polite" });
  let saving = false;
  container.append(el("div", { class: "pc-head muted", text: headText }));
  const updateSelectionSummary = () => {
    const chosen = checks.filter((c) => c.loadable && c.cb.checked).length;
    if (!loadableNames.length) {
      selectionSummary.textContent = "로드 가능한 플러그인이 없습니다.";
    } else if (chosen === 0) {
      selectionSummary.textContent = `선택된 항목이 없습니다. 저장하면 로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`;
    } else if (chosen === loadableNames.length) {
      selectionSummary.textContent = `로드 가능한 ${loadableNames.length}개 전체가 사용됩니다.`;
    } else {
      selectionSummary.textContent = `${chosen}개만 사용하도록 저장됩니다.`;
    }
  };

  for (const entry of info.plugins) {
    const checked = !selectedSet || selectedSet.has(entry.name);
    const cb = el("input", { type: "checkbox" });
    cb.checked = checked && entry.loadable;
    cb.disabled = !entry.loadable;
    cb.addEventListener("change", updateSelectionSummary);
    checks.push({ cb, name: entry.name, loadable: entry.loadable });
    const labelText = entry.loadable ? entry.name : `${entry.name} (로드 불가)`;
    container.append(el("label", { class: `pc-item ${entry.loadable ? "" : "disabled"}` }, [cb, el("span", { text: labelText })]));
  }
  container.append(selectionSummary);
  updateSelectionSummary();
  if (!loadableNames.length) return;

  const setSaving = (busy) => {
    saving = busy;
    container.setAttribute("aria-busy", busy ? "true" : "false");
    save.disabled = busy;
    checks.forEach(({ cb, loadable }) => {
      cb.disabled = busy || !loadable;
    });
  };
  const save = el("button", { class: "primary small", type: "button", text: "선택 저장", onclick: async () => {
    if (saving) return;
    const saved = save.textContent;
    setSaving(true);
    save.textContent = "저장 중…";
    const chosen = checks.filter((c) => c.loadable && c.cb.checked).map((c) => c.name);
    // If everything (or nothing) is selected, store null = "load all".
    const selected = chosen.length === 0 || chosen.length === loadableNames.length ? null : chosen;
    try {
      await onSave(selected);
      notify("플러그인 선택을 저장했습니다.", "ok");
      if (container.isConnected) {
        save.textContent = "저장됨 ✓";
        setTimeout(() => {
          if (!container.isConnected) return;
          save.textContent = saved;
          setSaving(false);
        }, 1200);
      }
    } catch (e) {
      notify(`저장 실패: ${e.message}`);
      save.textContent = saved;
      setSaving(false);
    }
  } });
  container.append(el("div", { class: "pc-actions" }, [save]));
}

// Render the repo's plugin list with per-plugin checkboxes. For a single-plugin
// repo there's nothing to select; for a marketplace repo the owner picks a
// subset (or "all"). `selected === null` means "load all".
function renderPluginContents(container, list, p, info) {
  renderPluginSelectionContents(container, info, {
    getSelected: () => p.selected,
    headText: "사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다.",
    onSave: async (selected) => {
      const { plugin } = await api(`/api/me/plugins/${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ selected }) });
      Object.assign(p, plugin);
      invalidateSkillsCache(state.user.id);
      renderPluginRows(list);
    },
  });
}

const INTERNAL_GIT_TOKEN_SECRET_NAME = "GIT_TOKEN";
const EXTERNAL_GIT_TOKEN_SECRET_NAME = "GITHUB_TOKEN";

export function hasSecret(name) {
  return (state.user.secretNames || []).includes(name);
}

export function buildSshPublicKeyField(publicKey) {
  const copyBtn = el("button", { class: "msg-act", type: "button", "aria-label": "SSH 공개키 복사", title: "SSH 공개키 복사" });
  copyBtn.append(icon("copy"));
  copyBtn.addEventListener("click", () => copyText(publicKey, copyBtn));
  return el("label", { class: "field ssh-public-key-field" }, [
    el("span", { text: "SSH 공개키" }),
    el("div", { class: "ssh-public-key-row" }, [
      el("textarea", { rows: "3", readonly: "", text: publicKey }),
      copyBtn,
    ]),
  ]);
}

// Git 자격증명: write-only internal/external tokens + commit identity. Token
// values are never returned by the server; only set/unset state is exposed.
function buildGitCredentialsCard() {
  const u = state.user;
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "Git 자격증명" }),
        el("p", { class: "muted", text: "사내 GitHub와 외부 github.com 토큰을 분리해 저장합니다. 값은 암호화되어 저장되며 다시 표시되지 않습니다." }),
      ]),
    ]),
  );

  const status = el("div", { class: "git-token-status muted" });
  const renderStatus = () => {
    const externalSet = hasSecret(EXTERNAL_GIT_TOKEN_SECRET_NAME);
    status.replaceChildren(
      state.user.gitTokenSet
        ? el("span", { class: "token-set", text: "● 사내 Git (GIT_TOKEN) 설정됨" })
        : el("span", { text: "사내 Git (GIT_TOKEN) 미설정" }),
      " · ",
      externalSet
        ? el("span", { class: "token-set", text: "외부 GitHub (GITHUB_TOKEN) 설정됨" })
        : el("span", { text: "외부 GitHub (GITHUB_TOKEN) 미설정" }),
    );
  };
  renderStatus();

  const buildTokenForm = ({ label, secretName, description, placeholder, ariaLabel, saveToken, clearToken, isSet }) => {
    let form;
    const tokenField = buildRevealableInput({ name: "token", placeholder, ariaLabel, revealLabel: "토큰", required: true });
    const input = tokenField.input;
    const saveBtn = el("button", { class: "primary", type: "submit", text: isSet() ? "교체" : "저장" });
    const clearBtn = el("button", {
      class: "linkish small",
      type: "button",
      text: "삭제",
      disabled: isSet() ? null : "",
      onclick: async () => {
        if (!window.confirm(`${label}을 삭제할까요?`)) return;
        const saved = clearBtn.textContent;
        setFormBusy(form, true);
        clearBtn.textContent = "삭제 중…";
        try {
          await clearToken();
          notify(`${label}을 삭제했습니다.`, "ok");
          renderStatus();
          clearBtn.textContent = saved;
          setFormBusy(form, false);
          refreshRow();
        } catch (e) {
          notify(`삭제 실패: ${e.message}`);
          clearBtn.textContent = saved;
          setFormBusy(form, false);
          refreshRow();
        }
      },
    });
    const rowStatus = el("span", {
      class: isSet() ? "muted token-set" : "muted",
      text: isSet() ? "● 설정됨" : "미설정",
    });
    const refreshRow = () => {
      const set = isSet();
      rowStatus.className = set ? "muted token-set" : "muted";
      rowStatus.textContent = set ? "● 설정됨" : "미설정";
      saveBtn.textContent = set ? "교체" : "저장";
      clearBtn.disabled = set ? false : true;
    };
    form = el("form", {
      class: "secret-preset-row",
      onsubmit: async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const token = input.value.trim();
        if (!token) return;
        const saved = saveBtn.textContent;
        setFormBusy(formEl, true);
        saveBtn.textContent = "저장 중…";
        try {
          await saveToken(token);
          input.value = "";
          renderStatus();
          refreshRow();
          setFormBusy(formEl, true);
          saveBtn.textContent = "저장됨 ✓";
          notify(`${label}을 저장했습니다.`, "ok");
          setTimeout(() => { setFormBusy(formEl, false); refreshRow(); }, 1200);
        } catch (err) {
          saveBtn.textContent = saved;
          setFormBusy(formEl, false);
          refreshRow();
          notify(`저장 실패: ${err.message}`);
        }
      },
    }, [
      el("div", { class: "secret-preset-meta" }, [
        el("div", { class: "secret-preset-title" }, [
          el("strong", { text: label }),
          el("code", { text: secretName }),
          rowStatus,
        ]),
        el("p", { class: "muted", text: description }),
      ]),
      tokenField.wrap,
      el("div", { class: "secret-preset-actions" }, [saveBtn, clearBtn]),
    ]);
    return form;
  };

  const internalTokenForm = buildTokenForm({
    label: "사내 Git 토큰",
    secretName: INTERNAL_GIT_TOKEN_SECRET_NAME,
    description: `사내 GitHub(${state.githubHost || "GITHUB_HOST"}) 전용입니다. 지식 저장소 생성·푸시와 사내 비공개 저장소 접근에 사용됩니다.`,
    placeholder: "사내 GitHub PAT (GIT_TOKEN)",
    ariaLabel: "사내 Git 토큰 GIT_TOKEN",
    isSet: () => Boolean(state.user.gitTokenSet),
    saveToken: async (token) => {
      const { user } = await api("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      state.user = user;
    },
    clearToken: async () => {
      const { user } = await api("/api/me/git-token", { method: "DELETE" });
      state.user = user;
    },
  });

  const externalTokenForm = buildTokenForm({
    label: "외부 GitHub 토큰",
    secretName: EXTERNAL_GIT_TOKEN_SECRET_NAME,
    description: "github.com HTTPS 저장소 접근 전용입니다. 지식 저장소 생성·푸시에는 사용되지 않습니다.",
    placeholder: "github.com PAT (GITHUB_TOKEN)",
    ariaLabel: "외부 GitHub 토큰 GITHUB_TOKEN",
    isSet: () => hasSecret(EXTERNAL_GIT_TOKEN_SECRET_NAME),
    saveToken: async (token) => {
      const { user } = await api(`/api/me/secrets/${EXTERNAL_GIT_TOKEN_SECRET_NAME}`, {
        method: "PUT",
        body: JSON.stringify({ value: token }),
      });
      state.user = user;
    },
    clearToken: async () => {
      const { user } = await api(`/api/me/secrets/${EXTERNAL_GIT_TOKEN_SECRET_NAME}`, { method: "DELETE" });
      state.user = user;
    },
  });

  // Commit identity used for knowledge-repo pushes.
  const identityForm = el("form", {
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
        const { user } = await api("/api/me/git-identity", {
          method: "PUT",
          body: JSON.stringify({ name: fd.get("name") || null, email: fd.get("email") || null }),
        });
        state.user = user;
        btn.textContent = "저장됨 ✓";
        notify("커밋 정보를 저장했습니다.", "ok");
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`저장 실패: ${err.message}`);
      }
    },
  }, [
    el("div", { class: "field-row-2col" }, [
      el("label", { class: "field" }, [el("span", { text: "커밋 이름" }), el("input", { name: "name", value: u.gitIdentityName || "", placeholder: u.alias || u.displayName || "" })]),
      el("label", { class: "field" }, [el("span", { text: "커밋 이메일" }), el("input", { name: "email", type: "email", value: u.gitIdentityEmail || "", placeholder: `${u.username}@example.com` })]),
    ]),
    el("button", { class: "primary", type: "submit", text: "커밋 정보 저장" }),
  ]);

  card.append(status, internalTokenForm, externalTokenForm, identityForm);
  return card;
}

// 시크릿: write-only named secrets (e.g. SSH_PRIVATE_KEY) encrypted at rest.
// Values are injected ONLY into the avatar's MCP tool subprocesses as env, so
// the avatar can use them (e.g. ssh into your servers) without ever seeing the
// raw value, and they're never returned to the client. We only know the NAMES
// that are set (u.secretNames). The avatar uses ITS OWNER's secrets regardless
// of who is chatting with it.
const SECRET_PRESETS = [
  {
    name: "SSH_PRIVATE_KEY",
    label: "SSH 개인키",
    description: "원격 SSH 도구가 사용할 OpenSSH/PEM 개인키입니다. 앱에서 키를 생성하면 자동으로 채워집니다.",
    placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    rows: 4,
  },
  {
    name: "CONFLUENCE_PAT",
    label: "Confluence PAT",
    description: "사내 Confluence 공용 도구가 Bearer 인증에 사용할 Personal Access Token입니다.",
    placeholder: "Confluence personal access token",
    rows: 2,
  },
];

function buildSecretsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "시크릿" }),
        el("p", { class: "muted", text: "내 아바타가 도구를 쓸 때만 주입되는 비밀값입니다. 암호화되어 저장되고 아바타에게도 값 자체는 보이지 않으며, 다시 표시되지 않습니다." }),
      ]),
    ]),
  );

  const presetList = el("div", { class: "secret-preset-list" });

  const saveSecret = async (name, value) => {
    const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    state.user = user;
    renderPresetList();
    renderList();
    renderPublicKey();
  };

  const deleteSecret = async (name) => {
    const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.user = user;
    renderPresetList();
    renderList();
    renderPublicKey();
  };

  const renderPresetList = () => {
    const names = new Set(state.user.secretNames || []);
    presetList.replaceChildren(
      ...SECRET_PRESETS.map((preset) => {
        const isSet = names.has(preset.name);
        const valueField = el("textarea", {
          name: "value",
          rows: String(preset.rows),
          placeholder: preset.placeholder,
          autocomplete: "off",
          required: "",
        });
        const saveBtn = el("button", { class: "primary", type: "submit", text: isSet ? "교체" : "저장" });
        const clearBtn = el("button", {
          class: "linkish small",
          type: "button",
          text: "삭제",
          disabled: isSet ? null : "",
          onclick: async () => {
            if (!window.confirm(`${preset.label} 시크릿을 삭제할까요?`)) return;
            const formEl = clearBtn.closest("form");
            const saved = clearBtn.textContent;
            setFormBusy(formEl, true);
            clearBtn.textContent = "삭제 중…";
            try {
              await deleteSecret(preset.name);
              notify(`${preset.label} 시크릿을 삭제했습니다.`, "ok");
            } catch (err) {
              notify(`삭제 실패: ${err.message}`);
              clearBtn.textContent = saved;
              setFormBusy(formEl, false);
            }
          },
        });
        const form = el("form", {
          class: "secret-preset-row",
          onsubmit: async (e) => {
            e.preventDefault();
            const formEl = e.currentTarget;
            const value = valueField.value;
            if (!value) {
              notify(`${preset.label} 값을 입력해 주세요.`, "warn");
              return;
            }
            const saved = saveBtn.textContent;
            setFormBusy(formEl, true);
            saveBtn.textContent = "저장 중…";
            try {
              await saveSecret(preset.name, value);
              notify(`${preset.label} 시크릿을 저장했습니다.`, "ok");
            } catch (err) {
              notify(`저장 실패: ${err.message}`);
              saveBtn.textContent = saved;
              setFormBusy(formEl, false);
            }
          },
        }, [
          el("div", { class: "secret-preset-meta" }, [
            el("div", { class: "secret-preset-title" }, [
              el("strong", { text: preset.label }),
              el("code", { text: preset.name }),
              isSet ? el("span", { class: "muted token-set", text: "● 설정됨" }) : el("span", { class: "muted", text: "미설정" }),
            ]),
            el("p", { class: "muted", text: preset.description }),
          ]),
          valueField,
          el("div", { class: "secret-preset-actions" }, [saveBtn, clearBtn]),
        ]);
        return form;
      }),
    );
  };
  renderPresetList();

  // List of currently-set secret names, each with a delete button.
  const list = el("div", { class: "secret-list" });
  let extraSecretNameInput;
  const focusExtraSecretForm = () => extraSecretNameInput?.focus();
  const renderList = () => {
    const presetNames = new Set(SECRET_PRESETS.map((preset) => preset.name));
    const names = (state.user.secretNames || []).filter((name) => !presetNames.has(name));
    if (!names.length) {
      list.replaceChildren(
        el("div", { class: "empty-note" }, [
          "추가 시크릿이 없습니다.\n",
          el("button", { class: "linkish small", type: "button", text: "시크릿 이름 입력", onclick: focusExtraSecretForm }),
        ]),
      );
      return;
    }
    list.replaceChildren(
      ...names.map((name) => {
        const delBtn = el("button", {
          class: "linkish small",
          type: "button",
          text: "삭제",
          "aria-label": `시크릿 삭제: ${name}`,
        });
        delBtn.addEventListener("click", async () => {
          if (!window.confirm(`시크릿 "${name}"을(를) 삭제할까요?`)) return;
          const saved = delBtn.textContent;
          delBtn.disabled = true;
          delBtn.textContent = "삭제 중…";
          try {
            await deleteSecret(name);
            notify(`시크릿 "${name}"을(를) 삭제했습니다.`, "ok");
          } catch (err) {
            notify(`삭제 실패: ${err.message}`);
            delBtn.disabled = false;
            delBtn.textContent = saved;
          }
        });
        return el("div", { class: "secret-row" }, [
          el("code", { text: name }),
          el("span", { class: "muted token-set", text: "● 설정됨" }),
          delBtn,
        ]);
      }),
    );
  };
  renderList();

  const publicKeyBox = el("div", { class: "ssh-public-key-box" });
  const renderPublicKey = () => {
    const publicKey = (state.user.sshPublicKey || "").trim();
    if (!publicKey) {
      publicKeyBox.replaceChildren();
      publicKeyBox.hidden = true;
      return;
    }
    publicKeyBox.hidden = false;
    publicKeyBox.replaceChildren(buildSshPublicKeyField(publicKey));
  };
  renderPublicKey();

  // Add/update form: an env-style NAME plus a (multiline-capable) value.
  const form = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const name = (fd.get("name") || "").toString().trim();
      const value = (fd.get("value") || "").toString();
      if (!name || !value) {
        notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
        return;
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        notify("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다. 예: SSH_PRIVATE_KEY", "warn");
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        });
        state.user = user;
        formEl.reset();
        renderPresetList();
        renderList();
        renderPublicKey();
        btn.textContent = "저장됨 ✓";
        notify(`시크릿 "${name}"을(를) 저장했습니다.`, "ok");
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
      } catch (err) {
        notify(`저장 실패: ${err.message}`);
        btn.textContent = saved;
        setFormBusy(formEl, false);
      }
    },
  }, [
    el("label", { class: "field" }, [
      el("span", { text: "이름" }),
      extraSecretNameInput = el("input", { name: "name", placeholder: "SSH_PRIVATE_KEY", autocomplete: "off", required: "" }),
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "값" }),
      el("textarea", { name: "value", rows: "4", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----…", autocomplete: "off", required: "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "추가 시크릿 저장" }),
  ]);

  card.append(
    presetList,
    publicKeyBox,
    el("div", { class: "secret-extra-head" }, [
      el("strong", { text: "기타 시크릿" }),
      el("p", { class: "muted", text: "도구가 추가로 요구하는 환경변수 이름이 있으면 직접 등록하세요." }),
    ]),
    list,
    form,
  );
  return card;
}

// Convert an `owner/repo` or git/https URL into a browsable https GitHub link,
// or null if we can't (e.g. ssh `git@` remote). Strips a trailing `.git`.
function repoToHref(repo) {
  if (!repo) return null;
  const r = repo.trim();
  if (/^https?:\/\//.test(r)) return r.replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) {
    const host = (state.githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/g, "");
    return `https://${host}/${r.replace(/\.git$/, "")}`;
  }
  return null;
}

// 지식 저장소: configure the personal internal GitHub repo.
// The avatar itself browses/edits/commits the repo via chat (the owner-only
// mcp__repo__* tools), so this card only points at the repo + shows its status.
function buildKnowledgeRepoCard() {
  const u = state.user;
  const card = el("section", { class: "settings-card" });
  // When a repo is connected, offer a refresh button that re-fetches it from the
  // remote (ensureClone does git fetch + checkout). Useful after the owner pushes
  // changes from elsewhere and wants the avatar to pick them up without waiting
  // for a process restart.
  const headerActions = [];
  if (u.knowledgeRepo) {
    const refreshBtn = el("button", {
      class: "linkish small",
      type: "button",
      text: "새로고침",
      title: "저장소를 원격에서 다시 가져옵니다",
      onclick: async () => {
        const saved = refreshBtn.textContent;
        setFormBusy(card, true);
        refreshBtn.textContent = "새로고침 중…";
        try {
          await api("/api/me/knowledge-repo/refresh", { method: "POST" });
          invalidateSkillsCache(state.user.id);
          refreshBtn.textContent = "새로고침됨 ✓";
          notify("지식 저장소를 최신 상태로 새로고침했습니다.", "ok");
          setTimeout(() => { refreshBtn.textContent = saved; setFormBusy(card, false); }, 1200);
        } catch (e) {
          refreshBtn.textContent = saved;
          setFormBusy(card, false);
          notify(`새로고침 실패: ${e.message}`);
        }
      },
    });
    headerActions.push(refreshBtn);
    const disconnectBtn = el("button", {
      class: "linkish small danger",
      type: "button",
      text: "연결 해제",
      title: "이 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)",
      onclick: async () => {
        if (!window.confirm("지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 아바타가 더 이상 그 스킬을 불러오지 않습니다.")) return;
        setFormBusy(card, true);
        try {
          const { user } = await api("/api/me/knowledge-repo", { method: "PUT", body: JSON.stringify({ repo: null }) });
          state.user = user;
          invalidateSkillsCache(state.user.id);
          renderView();
          notify("지식 저장소 연결을 해제했습니다.", "ok");
        } catch (e) {
          setFormBusy(card, false);
          notify(`연결 해제 실패: ${e.message}`);
        }
      },
    });
    headerActions.push(disconnectBtn);
  }
  headerActions.push(el("button", { class: "linkish small", type: "button", text: "설정 안내 다시 보기", onclick: () => openOnboarding() }));
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "지식 저장소" }),
        el("p", { class: "muted", text: `내 아바타가 일하며 쌓는 지식·스킬을 담는 사내 GitHub(${state.githubHost || "github.com"}) 저장소입니다.` }),
      ]),
      el("div", { class: "head-actions" }, headerActions),
    ]),
  );

  // Repo configuration form.
  const knowledgeRepoInput = el("input", {
    name: "repo",
    placeholder: "owner/repo 또는 사내 git URL",
    "aria-label": "지식 저장소 (owner/repo 또는 사내 git URL)",
    value: u.knowledgeRepo || "",
  });
  knowledgeRepoInput.addEventListener("input", () => {
    if (knowledgeRepoInput.value.trim()) knowledgeRepoInput.removeAttribute("aria-invalid");
  });
  const repoForm = el("form", {
    class: "plugin-add",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const repo = (fd.get("repo") || "").toString().trim();
      const branch = (fd.get("branch") || "").toString().trim();
      if (!repo) {
        notify(
          u.knowledgeRepo ? "저장소 연결을 해제하려면 오른쪽의 ‘연결 해제’ 버튼을 사용해 주세요." : "지식 저장소 주소를 입력해 주세요.",
          "warn",
        );
        knowledgeRepoInput.setAttribute("aria-invalid", "true");
        knowledgeRepoInput.focus();
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(card, true);
      btn.textContent = "저장 중…";
      try {
        const { user } = await api("/api/me/knowledge-repo", {
          method: "PUT",
          body: JSON.stringify({ repo, branch: branch || null }),
        });
        state.user = user;
        renderView();
        notify(`지식 저장소 "${repo}"을 연결했습니다.`, "ok");
      } catch (err) {
        btn.textContent = saved;
        notify(`저장 실패: ${err.message}`);
        setFormBusy(card, false);
      }
    },
  }, [
    knowledgeRepoInput,
    el("input", { name: "branch", placeholder: "브랜치 (선택)", "aria-label": "브랜치 (선택)", class: "narrow", value: u.knowledgeBranch || "" }),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);
  repoForm.classList.add("rows-2");
  card.append(repoForm);

  if (!u.knowledgeRepo) {
    card.append(
      el("div", { class: "empty-note" }, [
        "지식 저장소를 연결하면 아바타가 그 저장소의 지식·스킬을 사용하고, 대화로 직접 관리할 수 있어요.\n",
        el("button", {
          class: "linkish small",
          type: "button",
          text: "아바타에게 저장소 만들기 요청",
          onclick: () => chatAboutTopic("내 지식 저장소를 만들어서 연결해줘. 사내 GitHub에 저장소를 만들고, 앞으로 쓸 기본 지식/스킬 구조까지 준비해줘."),
        }),
      ]),
    );
    return card;
  }

  // Connected: show a clickable link + token status.
  const href = repoToHref(u.knowledgeRepo);
  const link = href
    ? el("a", { href, target: "_blank", rel: "noreferrer noopener", text: u.knowledgeRepo + (u.knowledgeBranch ? ` @ ${u.knowledgeBranch}` : "") })
    : el("code", { text: u.knowledgeRepo + (u.knowledgeBranch ? ` @ ${u.knowledgeBranch}` : "") });
  card.append(el("div", { class: "kr-link" }, [icon("globe"), link]));
  card.append(
    el("div", { class: "git-token-status muted" }, [
      u.gitTokenSet
        ? el("span", { class: "token-set", text: "● GIT_TOKEN 연결됨 · 아바타가 커밋·푸시할 수 있어요" })
        : el("span", {}, [
            // The git-credentials card lives in a DIFFERENT tab — link there
            // instead of pointing at a card that isn't on this screen.
            "GIT_TOKEN이 없어 읽기만 가능합니다. ",
            el("button", {
              class: "linkish",
              type: "button",
              text: "권한·연결 탭의 Git 자격증명",
              onclick: () => {
                state.settingsTab = "access";
                syncHash(true);
                renderView();
              },
            }),
            "에서 사내 Git 토큰을 설정하면 아바타가 커밋·푸시할 수 있어요.",
          ]),
    ]),
  );

  // Plugin selection: the repo's plugins are all loaded by default; the owner
  // can deselect some here. Mirrors the marketplace-plugin selection UI.
  const selSummary = !u.knowledgeSelected
    ? "저장소의 모든 플러그인을 사용 중"
    : `${u.knowledgeSelected.length}개 플러그인만 사용 중`;
  const contents = el("div", { class: "plugin-contents", hidden: "" });
  const pickBtn = el("button", { class: "linkish small", type: "button", text: "사용할 플러그인 선택", "aria-expanded": "false" });
  const reloadKnowledgeContents = wireExpander(pickBtn, contents, async (c) => {
    c.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const { contents: info } = await api("/api/me/knowledge-repo/contents");
      renderKnowledgeRepoContents(c, info);
    } catch (e) {
      c.replaceChildren(el("div", { class: "error-note" }, [
        `조회 실패: ${e.message} `,
        el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => reloadKnowledgeContents() }),
      ]));
    }
  });
  card.append(
    el("div", { class: "kr-plugins" }, [
      el("span", { class: "muted", text: selSummary }),
      pickBtn,
    ]),
  );
  card.append(contents);
  return card;
}

// Render the knowledge repo's plugin list with per-plugin checkboxes. The repo
// is the avatar's by default, so all plugins load unless the owner deselects
// some; `knowledgeSelected === null` means "load all". Mirrors
// `renderPluginContents`.
function renderKnowledgeRepoContents(container, info) {
  renderPluginSelectionContents(container, info, {
    getSelected: () => state.user.knowledgeSelected,
    headText: "아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다.",
    onSave: async (selected) => {
      const { user } = await api("/api/me/knowledge-repo/selected", { method: "PUT", body: JSON.stringify({ selected }) });
      state.user = user;
      invalidateSkillsCache(state.user.id);
      renderView();
    },
  });
}

/* ---- 그룹 (member roster + group-admin self-service) ---- */
// The member's view of the groups they belong to: teammate roster (with a chat
// shortcut — teammates auto-trust each other), and for group admins, member
// management + the shared knowledge repo (mirrors the personal knowledge repo).
export function buildGroupMemberAddForm({
  members = [],
  endpoint,
  reload,
  placeholder = "추가할 동료 아이디(@) 또는 이름",
  ariaLabel = "멤버 추가",
}) {
  const selected = new Map();
  const existingIds = new Set(members.map((m) => m.userId).filter(Boolean));
  const existingNames = new Set(members.map((m) => (m.username || "").toLowerCase()).filter(Boolean));
  const input = el("input", { type: "search", placeholder, "aria-label": ariaLabel });
  const adminCb = el("input", { type: "checkbox" });
  const addTypedBtn = el("button", {
    class: "icon-button group-add-pick",
    type: "button",
    title: "입력한 사용자를 선택 목록에 추가",
    "aria-label": "입력한 사용자를 선택 목록에 추가",
  }, [icon("plus")]);
  const submitBtn = el("button", { class: "primary small", type: "button", text: "선택한 멤버 추가" });
  const selectedList = el("div", { class: "group-add-selected", hidden: "" });
  const panel = el("div", { class: "group-add-panel" });
  let addingMembers = false;

  const excludeSelectedIds = () => new Set([
    ...existingIds,
    ...[...selected.values()].map((u) => u.id).filter(Boolean),
  ]);
  const excludeSelectedNames = () => new Set([...existingNames, ...selected.keys()]);
  const renderSelected = () => {
    selectedList.replaceChildren();
    if (!selected.size) {
      selectedList.hidden = true;
      submitBtn.textContent = "선택한 멤버 추가";
      return;
    }
    selectedList.hidden = false;
    for (const [key, user] of selected) {
      const remove = el("button", {
        class: "msg-act",
        type: "button",
        title: "선택 해제",
        "aria-label": `${user.displayName || user.username} 선택 해제`,
        disabled: addingMembers ? "" : null,
      }, [icon("close")]);
      remove.addEventListener("click", () => {
        if (addingMembers) return;
        selected.delete(key);
        renderSelected();
      });
      selectedList.append(
        el("span", { class: "group-add-chip" }, [
          el("span", { text: `${user.displayName || user.username} · @${user.username}` }),
          remove,
        ]),
      );
    }
    submitBtn.textContent = `${selected.size}명 추가`;
  };
  const setAddingMembers = (busy) => {
    addingMembers = busy;
    panel.setAttribute("aria-busy", busy ? "true" : "false");
    input.disabled = busy;
    adminCb.disabled = busy;
    addTypedBtn.disabled = busy;
    submitBtn.disabled = busy;
    selectedList.querySelectorAll("button").forEach((btn) => {
      btn.disabled = busy;
    });
    if (busy) {
      search.querySelector(".trusted-results")?.setAttribute("hidden", "");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
  };
  const selectUser = (user) => {
    if (addingMembers) return false;
    const username = (user.username || "").trim().replace(/^@/, "");
    const key = username.toLowerCase();
    if (!username) return false;
    if (existingNames.has(key) || (user.id && existingIds.has(user.id))) {
      notify("이미 그룹에 있는 사용자입니다.", "info");
      input.value = "";
      return false;
    }
    if (selected.has(key)) {
      notify("이미 선택한 사용자입니다.", "info");
      input.value = "";
      return false;
    }
    selected.set(key, { ...user, username, displayName: user.displayName || username });
    input.value = "";
    renderSelected();
    return true;
  };
  const addTyped = () => {
    if (addingMembers) return false;
    const username = input.value.trim().replace(/^@/, "");
    if (!username) {
      input.focus();
      return false;
    }
    return selectUser({ username, displayName: username });
  };
  const search = attachUserSearch(input, {
    onSelect: selectUser,
    excludeUserIds: excludeSelectedIds,
    excludeUsernames: excludeSelectedNames,
  });
  addTypedBtn.addEventListener("click", addTyped);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTyped();
    }
  });
  submitBtn.addEventListener("click", async () => {
    if (addingMembers) return;
    if (!selected.size && input.value.trim()) addTyped();
    if (!selected.size) {
      input.focus();
      return;
    }
    const queued = [...selected.entries()];
    const role = adminCb.checked ? "admin" : "member";
    const saved = submitBtn.textContent;
    setAddingMembers(true);
    submitBtn.textContent = "추가 중…";
    try {
      const failures = [];
      const successes = [];
      for (const [key, user] of queued) {
        try {
          const res = await api(endpoint, {
            method: "POST",
            body: JSON.stringify({ username: user.username, role }),
          });
          const member = res.member || {};
          existingNames.add((member.username || user.username).toLowerCase());
          if (member.userId) existingIds.add(member.userId);
          successes.push(key);
        } catch (e) {
          failures.push(`@${user.username}: ${e.message}`);
        }
      }
      for (const key of successes) selected.delete(key);
      let reloadError = null;
      if (successes.length) {
        adminCb.checked = false;
        input.value = "";
        try {
          await reload?.();
        } catch (e) {
          reloadError = e;
        }
      }
      if (failures.length) {
        const added = successes.length ? `${successes.length}명은 추가했습니다. ` : "";
        const refresh = reloadError ? ` 목록 새로고침 실패: ${reloadError.message}` : "";
        notify(`${added}일부 멤버를 추가하지 못했습니다. ${failures.join(" / ")}${refresh}`, "warn");
      } else if (reloadError) {
        notify(`${successes.length}명은 그룹에 추가했지만 목록 새로고침에 실패했습니다: ${reloadError.message}`, "warn");
      } else {
        notify(`${successes.length}명을 그룹에 추가했습니다.`, "ok");
      }
    } finally {
      submitBtn.textContent = saved;
      setAddingMembers(false);
      renderSelected();
    }
  });

  renderSelected();
  panel.append(
    el("div", { class: "group-add" }, [
      search,
      addTypedBtn,
      el("label", { class: "group-add-admin" }, [adminCb, el("span", { text: "그룹 관리자로" })]),
      submitBtn,
    ]),
    selectedList,
  );
  panel.focusMemberSearch = () => input.focus();
  return panel;
}

function buildGroupsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "그룹" }),
        el("p", {
          class: "muted",
          text: "내가 속한 그룹과 동료입니다. 같은 그룹 동료끼리는 자동으로 서로 신뢰해 아바타에 권한이 부여됩니다. 그룹 관리자는 멤버와 공용 지식 저장소를 관리할 수 있어요. 그룹 생성·삭제는 시스템 관리자가 합니다.",
        }),
      ]),
    ]),
  );
  const body = el("div", { class: "groups-body" });
  card.append(body);
  body.append(el("div", { class: "muted", text: "불러오는 중…" }));

  const loadGroups = async () => {
    body.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    let groups;
    try {
      ({ groups } = await api("/api/me/groups"));
    } catch (e) {
      body.replaceChildren(
        el("div", { class: "warn-box" }, [
          `그룹을 불러오지 못했습니다: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => loadGroups() }),
        ]),
      );
      return;
    }
    const reload = async () => {
      try {
        const { groups: next } = await api("/api/me/groups");
        render(next);
      } catch (e) {
        notify(`새로고침 실패: ${e.message}`);
      }
    };
    const render = (gs) => {
      if (!gs.length) {
        const emptyChildren = ["아직 속한 그룹이 없습니다. 그룹은 시스템 관리자가 만들고 멤버를 추가합니다."];
        if (state.user?.roles?.includes("admin")) {
          emptyChildren.push(
            "\n",
            el("button", {
              class: "linkish small",
              type: "button",
              text: "관리자에서 그룹 만들기",
              onclick: () => {
                state.adminTab = "groups";
                goView("admin");
              },
            }),
          );
        }
        body.replaceChildren(
          el("div", { class: "empty-note" }, emptyChildren),
        );
        return;
      }
      body.replaceChildren(...gs.map((g) => buildGroupBlock(g, reload)));
    };
    render(groups);
  };
  loadGroups();
  return card;
}

function buildGroupBlock(g, reload) {
  const amAdmin = g.role === "admin";
  const block = el("div", { class: "group-block" });
  block.append(
    el("div", { class: "group-block-head" }, [
      el("strong", { text: g.name }),
      amAdmin
        ? el("span", { class: "tag write", text: "내가 관리자" })
        : el("span", { class: "tag read", text: "멤버" }),
    ]),
  );

  const roster = el("div", { class: "plugin-rows" });
  const members = g.members || [];
  let addRow = null;
  if (amAdmin) {
    addRow = buildGroupMemberAddForm({
      members,
      endpoint: `/api/me/groups/${encodeURIComponent(g.id)}/members`,
      reload,
    });
  }
  if (!members.length) {
    roster.append(
      el("div", { class: "empty-note" }, [
        "멤버가 없습니다.\n",
        amAdmin ? el("button", { class: "linkish small", type: "button", text: "멤버 검색 입력", onclick: () => addRow?.focusMemberSearch?.() }) : null,
      ]),
    );
  } else {
    const memberSearch = el("input", {
      type: "search",
      class: "admin-search",
      placeholder: "멤버 이름·아이디 검색",
      "aria-label": `${g.name} 멤버 검색`,
    });
    const memberCount = el("span", { class: "muted nowrap" });
    const renderRoster = () => {
      roster.replaceChildren();
      const q = memberSearch.value.trim().toLowerCase();
      const shown = q
        ? members.filter((m) =>
            [
              m.displayName || "",
              m.username || "",
              m.role === "admin" ? "관리자" : "멤버",
            ].join(" ").toLowerCase().includes(q),
          )
        : members;
      memberCount.textContent = shown.length === members.length ? `멤버 ${members.length}명` : `표시 ${shown.length}명 / 전체 ${members.length}명`;
      if (!shown.length) {
        const clearRosterSearch = () => {
          memberSearch.value = "";
          renderRoster();
          memberSearch.focus();
        };
        roster.append(
          el("div", { class: "empty-note" }, [
            `"${memberSearch.value.trim()}"에 맞는 멤버가 없습니다.\n`,
            el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearRosterSearch }),
          ]),
        );
        return;
      }
      for (const m of shown) roster.append(buildGroupRosterRow(g, m, amAdmin, reload));
    };
    memberSearch.addEventListener("input", renderRoster);
    block.append(el("div", { class: "admin-users-head group-roster-head" }, [memberSearch, memberCount]));
    renderRoster();
  }
  block.append(roster);

  if (amAdmin) {
    block.append(addRow);
    block.append(buildGroupRepoCard(g));
  } else {
    block.append(
      el("p", {
        class: "muted small",
        text: g.knowledgeRepoConfigured
          ? "이 그룹에는 공용 지식 저장소가 연결되어 동료들의 아바타와 공유됩니다."
          : "이 그룹에는 아직 공용 지식 저장소가 없습니다.",
      }),
    );
  }
  return block;
}

function buildGroupRosterRow(g, m, amAdmin, reload) {
  const isMe = m.userId === state.user.id;
  const actions = [];
  let row;
  if (!isMe) {
    const chatBtn = el("button", { class: "ghost-sm", type: "button", text: "대화", title: `${m.displayName}의 아바타와 대화` });
    chatBtn.addEventListener("click", () => {
      const av =
        (state.avatars || []).find((a) => a.id === m.userId) || {
          id: m.userId,
          username: m.username,
          displayName: m.displayName,
          hasImage: m.hasImage,
          visibility: m.visibility,
          alias: "",
          bio: "",
          hashtags: [],
          pluginCount: 0,
        };
      startChatWith(av);
    });
    actions.push(chatBtn);
  }
  if (amAdmin && !isMe) {
    const roleBtn = el("button", { class: "ghost-sm", type: "button", text: m.role === "admin" ? "관리자 해제" : "관리자 지정" });
    roleBtn.addEventListener("click", async () => {
      const saved = roleBtn.textContent;
      setFormBusy(row, true);
      roleBtn.textContent = "변경 중…";
      try {
        await api(`/api/me/groups/${encodeURIComponent(g.id)}/members/${encodeURIComponent(m.userId)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: m.role === "admin" ? "member" : "admin" }),
        });
      } catch (e) {
        roleBtn.textContent = saved;
        setFormBusy(row, false);
        notify(`역할 변경 실패: ${e.message}`);
        return;
      }
      try {
        await reload();
        notify(`${m.displayName}님의 그룹 관리자 역할을 ${m.role === "admin" ? "해제" : "부여"}했습니다.`, "ok");
      } catch (e) {
        roleBtn.textContent = saved;
        if (row.isConnected) setFormBusy(row, false);
        notify(`역할은 변경됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
      }
    });
    const del = el("button", { class: "ghost-sm danger", type: "button", text: "제거" });
    del.addEventListener("click", async () => {
      if (!window.confirm(`${m.displayName}님을 그룹에서 제거할까요?`)) return;
      const saved = del.textContent;
      setFormBusy(row, true);
      del.textContent = "제거 중…";
      try {
        await api(`/api/me/groups/${encodeURIComponent(g.id)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
      } catch (e) {
        del.textContent = saved;
        setFormBusy(row, false);
        notify(`제거 실패: ${e.message}`);
        return;
      }
      try {
        await reload();
        notify(`${m.displayName}님을 그룹에서 제거했습니다.`, "ok");
      } catch (e) {
        del.textContent = saved;
        if (row.isConnected) setFormBusy(row, false);
        notify(`멤버는 제거됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
      }
    });
    actions.push(roleBtn, del);
  }
  row = el("div", { class: "plugin-row" }, [
    avatarNode({ ...m, id: m.userId }, 32, { alt: "" }),
    el("div", { class: "pr-main" }, [
      el("strong", { text: m.displayName + (isMe ? " (나)" : "") }),
      el("div", { class: "pr-sub", text: `@${m.username}${m.role === "admin" ? " · 관리자" : ""}` }),
    ]),
    el("div", { class: "pr-actions" }, actions),
  ]);
  return row;
}

// Group admin's view of the shared knowledge repo — mirrors buildKnowledgeRepoCard
// but group-scoped (/api/me/groups/:id/knowledge-repo*).
function buildGroupRepoCard(g) {
  const wrap = el("div", { class: "group-repo" });
  wrap.append(el("h4", { class: "knowledge-sub", text: "공용 지식 저장소" }));
  const gid = encodeURIComponent(g.id);

  if (g.knowledgeRepo) {
    const refreshBtn = el("button", {
      class: "linkish small",
      type: "button",
      text: "새로고침",
      onclick: async () => {
        const saved = refreshBtn.textContent;
        setFormBusy(wrap, true);
        refreshBtn.textContent = "새로고침 중…";
        try {
          await api(`/api/me/groups/${gid}/knowledge-repo/refresh`, { method: "POST" });
          invalidateSkillsCache(state.user.id);
          refreshBtn.textContent = "새로고침됨 ✓";
          notify(`"${g.name}" 공용 지식 저장소를 최신 상태로 새로고침했습니다.`, "ok");
          setTimeout(() => { refreshBtn.textContent = saved; setFormBusy(wrap, false); }, 1200);
        } catch (e) {
          refreshBtn.textContent = saved;
          setFormBusy(wrap, false);
          notify(`새로고침 실패: ${e.message}`);
        }
      },
    });
    const disconnectBtn = el("button", {
      class: "linkish small danger",
      type: "button",
      text: "연결 해제",
      title: "이 그룹의 공용 저장소 연결을 해제합니다 (GitHub의 저장소 자체는 삭제되지 않습니다)",
      onclick: async () => {
        if (!window.confirm("이 그룹의 공용 지식 저장소 연결을 해제할까요?\nGitHub의 저장소는 삭제되지 않고, 멤버 아바타들이 더 이상 그 스킬을 불러오지 않습니다.")) return;
        setFormBusy(wrap, true);
        try {
          await api(`/api/me/groups/${gid}/knowledge-repo`, { method: "PUT", body: JSON.stringify({ repo: null }) });
          invalidateSkillsCache(state.user.id);
          renderView();
          notify(`"${g.name}" 공용 지식 저장소 연결을 해제했습니다.`, "ok");
        } catch (e) {
          setFormBusy(wrap, false);
          notify(`연결 해제 실패: ${e.message}`);
        }
      },
    });
    wrap.append(el("div", { class: "head-actions" }, [refreshBtn, disconnectBtn]));
  }

  const groupRepoInput = el("input", {
    name: "repo",
    placeholder: "owner/repo 또는 사내 git URL",
    "aria-label": "그룹 지식 저장소",
    value: g.knowledgeRepo || "",
  });
  groupRepoInput.addEventListener("input", () => {
    if (groupRepoInput.value.trim()) groupRepoInput.removeAttribute("aria-invalid");
  });
  const form = el("form", {
    class: "plugin-add rows-2",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const repo = (fd.get("repo") || "").toString().trim();
      const branch = (fd.get("branch") || "").toString().trim();
      if (!repo) {
        notify(
          g.knowledgeRepo ? "공용 저장소 연결을 해제하려면 위의 ‘연결 해제’ 버튼을 사용해 주세요." : "공용 지식 저장소 주소를 입력해 주세요.",
          "warn",
        );
        groupRepoInput.setAttribute("aria-invalid", "true");
        groupRepoInput.focus();
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(wrap, true);
      btn.textContent = "저장 중…";
      try {
        await api(`/api/me/groups/${gid}/knowledge-repo`, {
          method: "PUT",
          body: JSON.stringify({
            repo,
            branch: branch || null,
          }),
        });
        invalidateSkillsCache(state.user.id);
        renderView();
        notify(`"${g.name}" 공용 지식 저장소 "${repo}"을 연결했습니다.`, "ok");
      } catch (err) {
        btn.textContent = saved;
        notify(`저장 실패: ${err.message}`);
        setFormBusy(wrap, false);
      }
    },
  }, [
    groupRepoInput,
    el("input", { name: "branch", placeholder: "브랜치 (선택)", "aria-label": "브랜치", class: "narrow", value: g.knowledgeBranch || "" }),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);
  wrap.append(form);

  if (!g.knowledgeRepo) {
    wrap.append(
      el("div", { class: "empty-note" }, [
        "공용 저장소를 연결하면 그룹 멤버 전원의 아바타가 그 저장소의 스킬을 사용합니다.\n",
        el("button", {
          class: "linkish small",
          type: "button",
          text: "아바타에게 공용 저장소 만들기 요청",
          onclick: () => chatAboutTopic(`"${g.name}" 그룹의 공용 지식 저장소를 만들어서 연결해줘. 그룹 멤버들이 함께 사용할 기본 지식/스킬 구조까지 준비해줘.`),
        }),
      ]),
    );
    return wrap;
  }

  const href = repoToHref(g.knowledgeRepo);
  const linkText = g.knowledgeRepo + (g.knowledgeBranch ? ` @ ${g.knowledgeBranch}` : "");
  const link = href
    ? el("a", { href, target: "_blank", rel: "noreferrer noopener", text: linkText })
    : el("code", { text: linkText });
  wrap.append(el("div", { class: "kr-link" }, [icon("globe"), link]));

  // Plugin subset picker (mirrors the personal repo card).
  const selSummary = !g.knowledgeSelected
    ? "저장소의 모든 플러그인을 사용 중"
    : `${g.knowledgeSelected.length}개 플러그인만 사용 중`;
  const contents = el("div", { class: "plugin-contents", hidden: "" });
  const pickBtn = el("button", { class: "linkish small", type: "button", text: "사용할 플러그인 선택", "aria-expanded": "false" });
  const reloadGroupContents = wireExpander(pickBtn, contents, async (c) => {
    c.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const { contents: info } = await api(`/api/me/groups/${gid}/knowledge-repo/contents`);
      renderGroupRepoContents(c, info, g);
    } catch (e) {
      c.replaceChildren(el("div", { class: "error-note" }, [
        `조회 실패: ${e.message} `,
        el("button", { class: "linkish small", type: "button", text: "다시 시도", onclick: () => reloadGroupContents() }),
      ]));
    }
  });
  wrap.append(el("div", { class: "kr-plugins" }, [el("span", { class: "muted", text: selSummary }), pickBtn]));
  wrap.append(contents);
  return wrap;
}

// Per-plugin selection for a group repo. Mirrors renderKnowledgeRepoContents but
// posts to the group endpoint and reads the group's current selection.
function renderGroupRepoContents(container, info, g) {
  renderPluginSelectionContents(container, info, {
    getSelected: () => g.knowledgeSelected,
    headText: "그룹 멤버 아바타가 사용할 플러그인을 선택하세요. 모두 선택하거나 모두 해제하면 전체가 사용됩니다.",
    onSave: async (selected) => {
      const { group } = await api(`/api/me/groups/${encodeURIComponent(g.id)}/knowledge-repo/selected`, { method: "PUT", body: JSON.stringify({ selected }) });
      Object.assign(g, group);
      invalidateSkillsCache(state.user.id);
      renderView();
    },
  });
}
