// Auto-split from app.js — module: admin. Behavior-preserving relocation only.
import { buildRevealableInput } from "./auth.js";
import { avatarNode } from "./avatar-image.js";
import { api, dom, el, icon, newId, notify, setFormBusy, state, timeLabel } from "./core.js";
import { loadAdminStats, loadAdminSystem, loadAdminUserDetail, loadAdminUsers, loadAudit } from "./loaders.js";
import { renderView, syncHash, syncHashAfterRoute } from "./nav.js";
import { buildGroupMemberAddForm } from "./settings.js";
import { buildTabBar, openModal, viewHeader, wireSegmentedRadioKeys } from "./shell.js";


/* ============================================================ Admin */
const ADMIN_TABS = [
  { id: "overview", label: "개요", icon: "activity" },
  { id: "users", label: "사용자", icon: "users" },
  { id: "groups", label: "그룹", icon: "users" },
  { id: "access", label: "가입·접근", icon: "key" },
  { id: "system", label: "시스템", icon: "server" },
  { id: "audit", label: "감사 로그", icon: "list" },
];
const ADMIN_TAB_BUILDERS = {
  overview: adminOverviewCards,
  users: adminUsersCards,
  groups: adminGroupsCards,
  access: adminAccessCards,
  system: adminSystemCards,
  audit: adminAuditCards,
};

export async function renderAdmin() {
  const header = viewHeader("관리자", "사용자·접근·시스템을 관리하세요");
  const body = el("div", { class: "view-body scroll-thin" });
  dom.main.append(header, body);
  const requestedAdminTab = state.adminTab;
  if (!ADMIN_TABS.some((t) => t.id === state.adminTab)) state.adminTab = "overview";
  if (state.adminTab !== requestedAdminTab) syncHashAfterRoute();

  const panel = el("div", { class: "admin-panel", role: "tabpanel", id: "admin-panel" });
  let tabRenderSeq = 0;
  const renderTab = async () => {
    const tabId = state.adminTab;
    const seq = ++tabRenderSeq;
    panel.setAttribute("aria-labelledby", `admin-tab-${tabId}`);
    panel.replaceChildren(el("div", { class: "muted pad", text: "불러오는 중…" }));
    try {
      const build = ADMIN_TAB_BUILDERS[tabId] || adminOverviewCards;
      const nodes = await build();
      if (seq !== tabRenderSeq || state.adminTab !== tabId) return;
      panel.replaceChildren(...nodes);
    } catch (e) {
      if (seq !== tabRenderSeq || state.adminTab !== tabId) return;
      panel.replaceChildren(
        el("div", { class: "warn-box" }, [
          `불러오기 실패: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderTab() }),
        ]),
      );
    }
  };

  const { tabBar, syncTabs } = buildTabBar({
    tabs: ADMIN_TABS,
    getTab: () => state.adminTab,
    setTab: (id) => { state.adminTab = id; },
    ariaLabel: "관리자 분류",
    idPrefix: "admin-tab",
    panelId: "admin-panel",
    onActivate: renderTab,
  });
  body.replaceChildren(tabBar, panel);
  syncTabs();
  await renderTab();
}

/* ---- 개요 (dashboard) ---- */
async function adminOverviewCards() {
  await loadAdminStats();
  const s = state.adminStats || {};
  const goAdminOverviewTarget = (tabId, userFilter = "all") => {
    state.adminTab = tabId;
    if (tabId === "users") state.adminUserFilter = userFilter;
    syncHash(true);
    renderView();
  };
  const stat = (label, value, sub, targetTab = "", userFilter = "all") => {
    const children = [
      el("div", { class: "stat-value", text: String(value ?? 0) }),
      el("div", { class: "stat-label", text: label }),
      sub ? el("div", { class: "stat-sub muted", text: sub }) : null,
    ];
    if (!targetTab) return el("div", { class: "stat-card" }, children);
    children.push(el("div", { class: "stat-link muted", text: targetTab === "groups" ? "그룹 관리" : "사용자 관리" }));
    return el("button", {
      class: "stat-card stat-clickable",
      type: "button",
      "aria-label": `${label} ${targetTab === "groups" ? "그룹 관리" : "사용자 관리"}로 이동`,
      onclick: () => goAdminOverviewTarget(targetTab, userFilter),
    }, children);
  };
  const grid = el("div", { class: "stat-grid" }, [
    stat("전체 사용자", s.users, s.suspended ? `정지 ${s.suspended}명 포함` : null, "users"),
    stat("관리자", s.admins, null, "users", "admins"),
    stat("공개 아바타", s.publicAvatars, null, "users", "public"),
    stat("대화", s.conversations),
    stat("메시지", s.messages),
    stat("활성 루틴", s.activeRoutines),
    stat("미응답 질문", s.openRequests),
    stat("활성 세션", s.activeSessions, null, "users", "sessions"),
    stat("그룹", s.groups, null, "groups"),
  ]);
  return [
    el("div", { class: "admin-list" }, [
      el("section", { class: "settings-card" }, [
        el("h3", { text: "현황" }),
        el("p", { class: "muted", text: "이 인스턴스의 전체 사용 현황입니다." }),
        grid,
      ]),
    ]),
  ];
}

/* ---- 사용자 (user management) ---- */
async function adminUsersCards() {
  await loadAdminUsers();
  const list = el("div", { class: "admin-list" });
  const filterBar = el("div", { class: "admin-filter seg-control", role: "radiogroup", "aria-label": "사용자 필터" });
  wireSegmentedRadioKeys(filterBar);
  const search = el("input", {
    type: "search",
    class: "admin-search",
    placeholder: "이름 또는 아이디로 검색",
    value: state.adminUserSearch,
    "aria-label": "사용자 검색",
  });
  const countLabel = el("span", { class: "muted nowrap" });
  const filterDefs = [
    { id: "all", label: "전체", match: () => true },
    { id: "admins", label: "관리자", match: (u) => u.roles?.includes("admin") },
    { id: "suspended", label: "정지", match: (u) => u.suspended },
    { id: "public", label: "공개", match: (u) => u.visibility === "public" },
    { id: "sessions", label: "활성 세션", match: (u) => (u.activeSessions || 0) > 0 },
  ];
  const filterLabel = (id) => filterDefs.find((f) => f.id === id)?.label || "전체";
  const currentFilter = () => filterDefs.find((f) => f.id === state.adminUserFilter) || filterDefs[0];
  const syncFilters = () => {
    if (!filterDefs.some((f) => f.id === state.adminUserFilter)) state.adminUserFilter = "all";
    filterBar.replaceChildren(
      ...filterDefs.map((f) => {
        const active = state.adminUserFilter === f.id;
        const count = state.adminUsers.filter(f.match).length;
        return el("button", {
          class: `seg-btn ${active ? "active" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
          dataset: { value: f.id },
          text: `${f.label} ${count}`,
          onclick: () => {
            state.adminUserFilter = f.id;
            syncFilters();
            renderList();
          },
        });
      }),
    );
  };
  const reload = async () => {
    await loadAdminUsers();
    syncFilters();
    renderList();
  };
  const renderList = () => {
    const q = state.adminUserSearch.trim().toLowerCase();
    const activeFilter = currentFilter();
    const users = state.adminUsers.filter(
      (u) =>
        activeFilter.match(u) &&
        (!q ||
          (u.displayName || "").toLowerCase().includes(q) ||
          (u.username || "").toLowerCase().includes(q)),
    );
    countLabel.textContent = `표시 ${users.length}명 / 전체 ${state.adminUsers.length}명`;
    if (!users.length) {
      const resetUserFilter = () => {
        state.adminUserFilter = "all";
        syncFilters();
        renderList();
        filterBar.querySelector('[data-value="all"]')?.focus();
      };
      if (q) {
        const clearAdminUserSearch = () => {
          state.adminUserSearch = "";
          search.value = "";
          renderList();
          search.focus();
        };
        const children = [
          `"${state.adminUserSearch.trim()}"에 맞는 ${state.adminUserFilter === "all" ? "사용자" : `${filterLabel(state.adminUserFilter)} 사용자`}가 없습니다. `,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearAdminUserSearch }),
        ];
        if (state.adminUserFilter !== "all") {
          children.push(" ", el("button", { class: "linkish small", type: "button", text: "전체 사용자 보기", onclick: resetUserFilter }));
        }
        list.replaceChildren(
          el("div", { class: "muted pad" }, children),
        );
      } else if (state.adminUserFilter !== "all") {
        list.replaceChildren(
          el("div", { class: "muted pad" }, [
            `${filterLabel(state.adminUserFilter)} 사용자가 없습니다. `,
            el("button", { class: "linkish small", type: "button", text: "전체 사용자 보기", onclick: resetUserFilter }),
          ]),
        );
      } else {
        list.replaceChildren(
          el("div", { class: "muted pad", text: "사용자가 없습니다." }),
        );
      }
      return;
    }
    list.replaceChildren(...users.map((u) => adminUserRow(u, reload)));
  };

  search.addEventListener("input", () => {
    state.adminUserSearch = search.value;
    renderList();
  });

  syncFilters();
  renderList();
  const head = el("div", { class: "admin-users-head" }, [
    search,
    countLabel,
  ]);
  return [el("div", { class: "admin-users" }, [head, filterBar, list])];
}

function adminUserRow(u, reload) {
  const isMe = u.id === state.user.id;
  const isAdmin = u.roles?.includes("admin");
  const tags = el("div", { class: "ar-tags" }, [
    el("span", { class: `tag ${isAdmin ? "write" : "read"}`, text: isAdmin ? "관리자" : "멤버" }),
    u.visibility === "public" ? el("span", { class: "tag accent", text: "공개" }) : null,
    u.visibility === "group" ? el("span", { class: "tag", text: "그룹 공개" }) : null,
    u.visibility === "private" ? el("span", { class: "tag", text: "비공개" }) : null,
    u.suspended ? el("span", { class: "tag danger", text: "정지" }) : null,
    u.activeSessions ? el("span", { class: "tag read", text: `세션 ${u.activeSessions}` }) : null,
    isMe ? el("span", { class: "tag", text: "나" }) : null,
  ]);

  const detailId = `admin-user-detail-${newId()}`;
  const detail = el("div", { id: detailId, class: "ar-detail" });
  detail.hidden = true;
  let loaded = false;
  const manageBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    text: "관리",
    "aria-controls": detailId,
    "aria-expanded": "false",
    "aria-label": `${u.displayName} 사용자 관리 열기`,
    title: `${u.displayName} 사용자 관리 열기`,
  });
  const setManageExpanded = (expanded) => {
    detail.hidden = !expanded;
    manageBtn.textContent = expanded ? "접기" : "관리";
    manageBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    manageBtn.setAttribute("aria-label", expanded ? `${u.displayName} 사용자 관리 접기` : `${u.displayName} 사용자 관리 열기`);
    manageBtn.title = expanded ? `${u.displayName} 사용자 관리 접기` : `${u.displayName} 사용자 관리 열기`;
  };
  const loadDetail = async () => {
    setManageExpanded(true);
    if (loaded) return;
    const saved = manageBtn.textContent;
    manageBtn.disabled = true;
    manageBtn.textContent = "불러오는 중…";
    detail.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const d = await loadAdminUserDetail(u.id);
      detail.replaceChildren(buildUserDetailGrid(d), buildUserActions(u, isAdmin, isMe, reload));
      loaded = true;
    } catch (e) {
      detail.replaceChildren(
        el("div", { class: "warn-box" }, [
          `불러오기 실패: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => loadDetail() }),
        ]),
      );
    } finally {
      manageBtn.textContent = saved;
      manageBtn.disabled = false;
    }
  };
  manageBtn.addEventListener("click", async () => {
    if (!detail.hidden) {
      setManageExpanded(false);
      return;
    }
    await loadDetail();
  });

  const lastSeen = u.lastSeenAt ? timeLabel(u.lastSeenAt) : "기록 없음";
  const row = el("div", { class: "admin-row" }, [
    avatarNode(u, 40, { alt: "" }),
    el("div", { class: "ar-main" }, [
      el("strong", { text: u.displayName }),
      el("div", { class: "muted", text: `@${u.username} · 가입 ${timeLabel(u.createdAt)} · 최근 ${lastSeen}` }),
    ]),
    tags,
    el("div", { class: "ar-actions" }, [manageBtn]),
  ]);
  return el("div", { class: "admin-user" + (u.suspended ? " is-suspended" : "") }, [row, detail]);
}

function buildUserDetailGrid(d) {
  const item = (k, v) =>
    el("div", { class: "ud-item" }, [
      el("span", { class: "ud-val", text: String(v ?? 0) }),
      el("span", { class: "ud-key muted", text: k }),
    ]);
  return el("div", { class: "ud-grid" }, [
    item("시작한 대화", d.conversationsStarted),
    item("받은 대화", d.conversationsReceived),
    item("플러그인", d.pluginCount),
    item("루틴", `${d.routinesActive}/${d.routinesTotal}`),
    item("시크릿", d.secretCount),
    item("활성 세션", d.activeSessions),
    item("미응답 질문", d.openRequests),
    item("GIT_TOKEN", d.gitTokenSet ? "있음" : "없음"),
    item("지식 저장소", d.knowledgeRepoSet ? "연결됨" : "없음"),
  ]);
}

function openAdminPasswordResetModal(u, triggerBtn, reload) {
  triggerBtn.disabled = true;
  const uid = encodeURIComponent(u.id);
  openModal({
    cardClass: "password-reset-card",
    ariaLabelledby: "admin-password-reset-title",
    onBeforeClose: () => { triggerBtn.disabled = false; },
    buildCard: (card, close) => {
      const passwordField = buildRevealableInput({
        name: "password",
        autocomplete: "new-password",
        placeholder: "새 비밀번호",
        ariaLabel: `${u.displayName} 새 비밀번호`,
        required: true,
        minlength: 8,
      });
      const confirmField = buildRevealableInput({
        name: "confirmPassword",
        autocomplete: "new-password",
        placeholder: "새 비밀번호 확인",
        ariaLabel: `${u.displayName} 새 비밀번호 확인`,
        required: true,
        minlength: 8,
      });
      const errorBox = el("div", { class: "error", role: "alert", hidden: "" });
      const saveBtn = el("button", { class: "primary", type: "submit", text: "재설정" });
      const cancelBtn = el("button", { class: "ghost-sm", type: "button", text: "취소", onclick: () => close() });
      const setBusy = (busy) => {
        passwordField.input.disabled = busy;
        confirmField.input.disabled = busy;
        saveBtn.disabled = busy;
        cancelBtn.disabled = busy;
        saveBtn.textContent = busy ? "재설정 중…" : "재설정";
      };
      const showError = (message) => {
        errorBox.textContent = message;
        errorBox.hidden = false;
      };
      const form = el("form", {
        class: "routine-modal-form",
        onsubmit: async (e) => {
          e.preventDefault();
          const pw = passwordField.input.value;
          const confirm = confirmField.input.value;
          if (pw.length < 8) {
            showError("비밀번호는 8자 이상이어야 합니다.");
            passwordField.input.focus();
            return;
          }
          if (pw !== confirm) {
            showError("두 비밀번호가 일치하지 않습니다.");
            confirmField.input.focus();
            return;
          }
          errorBox.hidden = true;
          setBusy(true);
          try {
            await api(`/api/admin/users/${uid}/password`, { method: "POST", body: JSON.stringify({ password: pw }) });
            notify("비밀번호를 재설정했습니다.", "ok");
            close();
            try {
              await reload();
            } catch (err) {
              notify(`비밀번호는 재설정했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
            }
          } catch (err) {
            setBusy(false);
            showError(`재설정 실패: ${err.message}`);
          }
        },
      }, [
        el("label", { class: "field" }, [
          el("span", { text: "새 비밀번호" }),
          passwordField.wrap,
        ]),
        el("label", { class: "field" }, [
          el("span", { text: "새 비밀번호 확인" }),
          confirmField.wrap,
        ]),
        errorBox,
        el("div", { class: "routine-modal-actions" }, [
          el("div", { class: "routine-modal-actions-left" }, [
            el("span", { class: "muted", text: `대상: ${u.displayName} (@${u.username})` }),
          ]),
          el("div", { class: "routine-modal-actions-right" }, [cancelBtn, saveBtn]),
        ]),
      ]);
      card.append(
        el("h2", { id: "admin-password-reset-title", text: "비밀번호 재설정" }),
        el("p", { class: "muted", text: "저장하면 이 사용자의 기존 세션이 모두 로그아웃됩니다." }),
        form,
      );
      return { focusTarget: passwordField.input };
    },
  });
}

function buildUserActions(u, isAdmin, isMe, reload) {
  const wrap = el("div", { class: "ud-actions" });
  const run = async (btn, fn, errLabel, successLabel = "") => {
    const saved = btn.textContent;
    setFormBusy(wrap, true);
    btn.textContent = "처리 중…";
    try {
      await fn();
    } catch (e) {
      btn.textContent = saved;
      setFormBusy(wrap, false);
      notify(`${errLabel}: ${e.message}`);
      return;
    }
    try {
      await reload();
      if (successLabel) notify(successLabel, "ok");
    } catch (e) {
      btn.textContent = saved;
      setFormBusy(wrap, false);
      notify(`작업은 완료됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  };
  const uid = encodeURIComponent(u.id);

  const roleBtn = el("button", { class: "ghost-sm", type: "button", text: isAdmin ? "관리자 해제" : "관리자 지정" });
  if (isMe) roleBtn.disabled = true;
  roleBtn.addEventListener("click", () => {
    const verb = isAdmin ? "해제" : "부여";
    if (!window.confirm(`${u.displayName}(@${u.username})님의 관리자 권한을 ${verb}할까요?`)) return;
    run(
      roleBtn,
      () => api(`/api/admin/users/${uid}/roles`, { method: "POST", body: JSON.stringify({ role: "admin", grant: !isAdmin }) }),
      "권한 변경 실패",
      `${u.displayName}님의 관리자 권한을 ${verb}했습니다.`,
    );
  });

  // Moderation: hide an avatar from discovery (force private) or restore it to
  // public. The owner can still re-set their own visibility afterward.
  const willHide = u.visibility !== "private";
  const pubBtn = el("button", { class: "ghost-sm", type: "button", text: willHide ? "비공개로 전환" : "공개로 전환" });
  pubBtn.addEventListener("click", () => {
    run(
      pubBtn,
      () => api(`/api/admin/users/${uid}/visibility`, { method: "PUT", body: JSON.stringify({ visibility: willHide ? "private" : "public" }) }),
      "공개 설정 실패",
      `${u.displayName}님의 공개 범위를 ${willHide ? "비공개" : "공개"}로 전환했습니다.`,
    );
  });

  const susBtn = el("button", { class: "ghost-sm" + (u.suspended ? "" : " danger"), type: "button", text: u.suspended ? "활성화" : "정지" });
  if (isMe) susBtn.disabled = true;
  susBtn.addEventListener("click", () => {
    if (!u.suspended && !window.confirm(`${u.displayName} 계정을 정지할까요?\n로그인과 활성 세션이 즉시 차단됩니다.`)) return;
    run(
      susBtn,
      () => api(`/api/admin/users/${uid}/suspend`, { method: "POST", body: JSON.stringify({ suspended: !u.suspended }) }),
      "상태 변경 실패",
      `${u.displayName} 계정을 ${u.suspended ? "활성화" : "정지"}했습니다.`,
    );
  });

  const pwBtn = el("button", { class: "ghost-sm", type: "button", text: "비밀번호 재설정" });
  pwBtn.addEventListener("click", () => {
    openAdminPasswordResetModal(u, pwBtn, reload);
  });

  const outBtn = el("button", { class: "ghost-sm", type: "button", text: "강제 로그아웃" });
  outBtn.addEventListener("click", () => {
    run(
      outBtn,
      async () => {
        const r = await api(`/api/admin/users/${uid}/logout`, { method: "POST" });
        notify(`세션 ${r.revoked ?? 0}개를 종료했습니다.`, "ok");
      },
      "로그아웃 실패",
    );
  });

  const delBtn = el("button", { class: "ghost-sm danger", type: "button", text: "삭제" });
  if (isMe) delBtn.disabled = true;
  delBtn.addEventListener("click", () => {
    if (!window.confirm(`${u.displayName}(@${u.username}) 계정을 삭제할까요?\n이 사용자의 아바타·대화·설정이 모두 영구 삭제되며 되돌릴 수 없습니다.`)) return;
    run(delBtn, () => api(`/api/admin/users/${uid}`, { method: "DELETE" }), "삭제 실패", `${u.displayName} 계정을 삭제했습니다.`);
  });

  wrap.append(roleBtn, pubBtn, susBtn, pwBtn, outBtn, delBtn);
  if (isMe) {
    wrap.append(el("p", { class: "muted ud-self-note", text: "자기 자신에게는 권한 해제·정지·삭제를 적용할 수 없습니다." }));
  }
  return wrap;
}

/* ---- 그룹 (group management) ---- */
// System admins create/delete groups, add members, and assign group admins here.
// Group members auto-trust each other; the group's shared knowledge repo is
// edited by group admins from their own 내 아바타 ▸ 그룹 tab.
async function adminGroupsCards() {
  const { groups } = await api("/api/admin/groups");
  let currentGroups = groups;
  const list = el("div", { class: "admin-list" });
  const countLabel = el("span", { class: "muted nowrap" });
  const search = el("input", {
    type: "search",
    class: "admin-search",
    placeholder: "그룹 이름·설명 검색",
    value: state.adminGroupSearch,
    "aria-label": "그룹 검색",
    disabled: groups.length ? null : "",
  });
  let groupNameInput;
  const focusGroupForm = () => groupNameInput?.focus();

  const reload = async () => {
    const { groups: next } = await api("/api/admin/groups");
    currentGroups = next;
    renderList(currentGroups);
  };
  const renderList = (gs) => {
    list.replaceChildren();
    search.disabled = gs.length ? false : true;
    const q = state.adminGroupSearch.trim().toLowerCase();
    if (!gs.length) {
      countLabel.textContent = "총 0개";
      list.append(
        el("div", { class: "muted pad" }, [
          "아직 그룹이 없습니다. ",
          el("button", { class: "linkish small", type: "button", text: "그룹 이름 입력", onclick: focusGroupForm }),
        ]),
      );
      return;
    }
    const shown = q
      ? gs.filter((g) =>
          [
            g.name,
            g.description || "",
            g.knowledgeRepo ? "공용 저장소" : "",
            `멤버 ${g.memberCount}`,
            `관리자 ${g.adminCount}`,
          ].join(" ").toLowerCase().includes(q),
        )
      : gs;
    countLabel.textContent = shown.length === gs.length ? `총 ${gs.length}개` : `표시 ${shown.length}개 / 전체 ${gs.length}개`;
    if (!shown.length) {
      const clearAdminGroupSearch = () => {
        state.adminGroupSearch = "";
        search.value = "";
        renderList(gs);
        search.focus();
      };
      list.append(
        el("div", { class: "muted pad" }, [
          `"${state.adminGroupSearch.trim()}"에 맞는 그룹이 없습니다. `,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearAdminGroupSearch }),
        ]),
      );
      return;
    }
    for (const g of shown) list.append(adminGroupRow(g, reload));
  };

  const form = el("form", {
    class: "plugin-add rows-2",
    onsubmit: async (e) => {
      e.preventDefault();
      // Capture the form node now: event.currentTarget is nulled after the
      // handler's first await, so referencing it later (reset) would throw.
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const name = (fd.get("name") || "").toString().trim();
      if (!name) { notify("그룹 이름을 입력하세요.", "warn"); return; }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "생성 중…";
      try {
        await api("/api/admin/groups", {
          method: "POST",
          body: JSON.stringify({ name, description: (fd.get("description") || "").toString().trim() }),
        });
      } catch (err) {
        notify(`그룹 생성 실패: ${err.message}`);
        btn.textContent = saved;
        setFormBusy(formEl, false);
        return;
      }
      formEl.reset();
      state.adminGroupSearch = "";
      search.value = "";
      try {
        await reload();
        notify(`그룹 "${name}"을 만들었습니다.`, "ok");
      } catch (err) {
        notify(`그룹은 만들었지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
      } finally {
        btn.textContent = saved;
        setFormBusy(formEl, false);
      }
    },
  }, [
    groupNameInput = el("input", { name: "name", placeholder: "그룹 이름", "aria-label": "그룹 이름", required: "" }),
    el("input", { name: "description", placeholder: "설명 (선택)", "aria-label": "그룹 설명" }),
    el("button", { class: "primary", type: "submit", text: "그룹 만들기" }),
  ]);

  search.addEventListener("input", () => {
    state.adminGroupSearch = search.value;
    renderList(currentGroups);
  });

  renderList(currentGroups);
  const searchHead = el("div", { class: "admin-users-head" }, [search, countLabel]);
  const card = el("section", { class: "settings-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "그룹" }),
        el("p", {
          class: "muted",
          text: "같은 그룹 멤버끼리는 자동으로 서로 신뢰해 권한을 얻고, 그룹 공용 지식 저장소를 공유합니다. 그룹 생성·삭제와 그룹 관리자 지정은 시스템 관리자만 합니다. 공용 저장소 편집은 각 그룹 관리자가 ‘내 아바타 ▸ 그룹’에서 합니다.",
        }),
      ]),
    ]),
    form,
    searchHead,
    list,
  ]);
  return [card];
}

function adminGroupRow(g, reload) {
  const detailId = `admin-group-detail-${newId()}`;
  const detail = el("div", { id: detailId, class: "ar-detail" });
  detail.hidden = true;
  let loaded = false;
  const manageBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    text: "관리",
    "aria-controls": detailId,
    "aria-expanded": "false",
    "aria-label": `${g.name} 그룹 관리 열기`,
    title: `${g.name} 그룹 관리 열기`,
  });
  const setManageExpanded = (expanded) => {
    detail.hidden = !expanded;
    manageBtn.textContent = expanded ? "접기" : "관리";
    manageBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    manageBtn.setAttribute("aria-label", expanded ? `${g.name} 그룹 관리 접기` : `${g.name} 그룹 관리 열기`);
    manageBtn.title = expanded ? `${g.name} 그룹 관리 접기` : `${g.name} 그룹 관리 열기`;
  };
  const loadDetail = async () => {
    setManageExpanded(true);
    if (loaded) return;
    const saved = manageBtn.textContent;
    manageBtn.disabled = true;
    manageBtn.textContent = "불러오는 중…";
    detail.replaceChildren(el("div", { class: "muted", text: "불러오는 중…" }));
    try {
      const d = await api(`/api/admin/groups/${encodeURIComponent(g.id)}`);
      detail.replaceChildren(buildAdminGroupDetail(g, d.members, reload));
      loaded = true;
    } catch (e) {
      detail.replaceChildren(
        el("div", { class: "warn-box" }, [
          `불러오기 실패: ${e.message} `,
          el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => loadDetail() }),
        ]),
      );
    } finally {
      manageBtn.textContent = saved;
      manageBtn.disabled = false;
    }
  };
  manageBtn.addEventListener("click", async () => {
    if (!detail.hidden) {
      setManageExpanded(false);
      return;
    }
    await loadDetail();
  });

  const tags = el("div", { class: "ar-tags" }, [
    el("span", { class: "tag", text: `멤버 ${g.memberCount}` }),
    el("span", { class: "tag write", text: `관리자 ${g.adminCount}` }),
    g.knowledgeRepo ? el("span", { class: "tag accent", text: "공용 저장소" }) : null,
  ]);
  const row = el("div", { class: "admin-row" }, [
    el("div", { class: "ar-main" }, [
      el("strong", { text: g.name }),
      el("div", { class: "muted", text: g.description || "(설명 없음)" }),
    ]),
    tags,
    el("div", { class: "ar-actions" }, [manageBtn]),
  ]);
  return el("div", { class: "admin-user" }, [row, detail]);
}

function buildAdminGroupDetail(g, members, reload) {
  const wrap = el("div", { class: "ar-detail-inner" });
  let currentMembers = members;

  const editForm = el("form", {
    class: "plugin-add rows-2",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const nextName = (fd.get("name") || "").toString().trim();
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        await api(`/api/admin/groups/${encodeURIComponent(g.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: nextName,
            description: (fd.get("description") || "").toString(),
          }),
        });
      } catch (err) {
        notify(`수정 실패: ${err.message}`);
        btn.textContent = saved;
        setFormBusy(formEl, false);
        return;
      }
      try {
        await reload();
        notify(`그룹 "${nextName || g.name}" 정보를 수정했습니다.`, "ok");
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`그룹 정보는 수정했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
      }
    },
  }, [
    el("input", { name: "name", value: g.name, "aria-label": "그룹 이름" }),
    el("input", { name: "description", value: g.description || "", placeholder: "설명", "aria-label": "그룹 설명" }),
    el("button", { class: "ghost-sm", type: "submit", text: "수정" }),
  ]);

  const memberList = el("div", { class: "plugin-rows" });
  const memberSearch = el("input", {
    type: "search",
    class: "admin-search",
    placeholder: "멤버 이름·아이디 검색",
    value: "",
    "aria-label": "그룹 멤버 검색",
    disabled: members.length ? null : "",
  });
  const memberCount = el("span", { class: "muted nowrap" });
  const reloadMembers = async () => {
    const d = await api(`/api/admin/groups/${encodeURIComponent(g.id)}`);
    currentMembers = d.members;
    renderMembers(currentMembers);
    reload().catch(() => {});
  };
  const renderMembers = (ms) => {
    memberList.replaceChildren();
    memberSearch.disabled = ms.length ? false : true;
    const q = memberSearch.value.trim().toLowerCase();
    if (!ms.length) {
      memberCount.textContent = "멤버 0명";
      memberList.append(
        el("div", { class: "empty-note" }, [
          "멤버가 없습니다.\n",
          el("button", { class: "linkish small", type: "button", text: "멤버 검색 입력", onclick: () => addRow.focusMemberSearch?.() }),
        ]),
      );
      return;
    }
    const shown = q
      ? ms.filter((m) =>
          [
            m.displayName || "",
            m.username || "",
            m.role === "admin" ? "관리자" : "멤버",
          ].join(" ").toLowerCase().includes(q),
        )
      : ms;
    memberCount.textContent = shown.length === ms.length ? `멤버 ${ms.length}명` : `표시 ${shown.length}명 / 전체 ${ms.length}명`;
    if (!shown.length) {
      const clearMemberSearch = () => {
        memberSearch.value = "";
        renderMembers(ms);
        memberSearch.focus();
      };
      memberList.append(
        el("div", { class: "empty-note" }, [
          `"${memberSearch.value.trim()}"에 맞는 멤버가 없습니다.\n`,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearMemberSearch }),
        ]),
      );
      return;
    }
    for (const m of shown) memberList.append(adminGroupMemberRow(g.id, m, reloadMembers));
  };

  const addRow = buildGroupMemberAddForm({
    members,
    endpoint: `/api/admin/groups/${encodeURIComponent(g.id)}/members`,
    reload: reloadMembers,
    placeholder: "추가할 사용자 아이디(@) 또는 이름",
  });
  memberSearch.addEventListener("input", () => renderMembers(currentMembers));
  renderMembers(members);

  const delBtn = el("button", { class: "ghost-sm danger", type: "button", text: "그룹 삭제" });
  delBtn.addEventListener("click", async () => {
    if (!window.confirm(`'${g.name}' 그룹을 삭제할까요?\n멤버십이 모두 해제되고 멤버 간 자동 신뢰가 사라집니다. (공용 저장소 자체는 GitHub에 남습니다.)`)) return;
    delBtn.disabled = true;
    const saved = delBtn.textContent;
    delBtn.textContent = "삭제 중…";
    try {
      await api(`/api/admin/groups/${encodeURIComponent(g.id)}`, { method: "DELETE" });
    } catch (e) {
      delBtn.textContent = saved;
      delBtn.disabled = false;
      notify(`삭제 실패: ${e.message}`);
      return;
    }
    try {
      await reload();
      notify(`그룹 "${g.name}"을 삭제했습니다.`, "ok");
    } catch (e) {
      delBtn.textContent = saved;
      delBtn.disabled = false;
      notify(`그룹은 삭제했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });

  wrap.append(
    el("h4", { class: "knowledge-sub", text: "그룹 정보" }),
    editForm,
    el("h4", { class: "knowledge-sub", text: "멤버" }),
    el("div", { class: "admin-users-head" }, [memberSearch, memberCount]),
    memberList,
    addRow,
    el("div", { class: "ud-actions" }, [delBtn]),
  );
  return wrap;
}

function adminGroupMemberRow(groupId, m, reload) {
  const isAdmin = m.role === "admin";
  let row;
  const roleBtn = el("button", {
    class: "ghost-sm",
    type: "button",
    title: isAdmin ? "그룹 관리자 해제" : "그룹 관리자 지정",
    text: isAdmin ? "관리자 해제" : "관리자 지정",
  });
  roleBtn.addEventListener("click", async () => {
    const saved = roleBtn.textContent;
    setFormBusy(row, true);
    roleBtn.textContent = "변경 중…";
    try {
      await api(`/api/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(m.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role: isAdmin ? "member" : "admin" }),
      });
    } catch (e) {
      roleBtn.textContent = saved;
      setFormBusy(row, false);
      notify(`역할 변경 실패: ${e.message}`);
      return;
    }
    try {
      await reload();
      notify(`${m.displayName}님의 그룹 관리자 역할을 ${isAdmin ? "해제" : "부여"}했습니다.`, "ok");
    } catch (e) {
      roleBtn.textContent = saved;
      if (row.isConnected) setFormBusy(row, false);
      notify(`역할은 변경됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });
  const del = el("button", { class: "msg-act danger", type: "button", title: "멤버 제거", "aria-label": `${m.displayName} 제거` });
  del.append(icon("trash"));
  del.addEventListener("click", async () => {
    if (!window.confirm(`${m.displayName}님을 그룹에서 제거할까요?`)) return;
    const savedTitle = del.title;
    const savedLabel = del.getAttribute("aria-label");
    setFormBusy(row, true);
    del.title = "제거 중…";
    del.setAttribute("aria-label", `${m.displayName} 제거 중`);
    try {
      await api(`/api/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    } catch (e) {
      del.title = savedTitle;
      del.setAttribute("aria-label", savedLabel || `${m.displayName} 제거`);
      setFormBusy(row, false);
      notify(`제거 실패: ${e.message}`);
      return;
    }
    try {
      await reload();
      notify(`${m.displayName}님을 그룹에서 제거했습니다.`, "ok");
    } catch (e) {
      del.title = savedTitle;
      del.setAttribute("aria-label", savedLabel || `${m.displayName} 제거`);
      if (row.isConnected) setFormBusy(row, false);
      notify(`멤버는 제거됐지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });
  row = el("div", { class: "plugin-row" }, [
    avatarNode({ ...m, id: m.userId }, 32, { alt: "" }),
    el("div", { class: "pr-main" }, [
      el("strong", { text: m.displayName }),
      el("div", { class: "pr-sub", text: `@${m.username}` }),
    ]),
    isAdmin ? el("span", { class: "tag write", text: "관리자" }) : el("span", { class: "tag read", text: "멤버" }),
    el("div", { class: "pr-actions" }, [roleBtn, del]),
  ]);
  return row;
}

/* ---- 가입·접근 (signup policy) ---- */
async function adminAccessCards() {
  await loadAdminSystem();
  return [el("div", { class: "admin-list" }, [buildSignupModeCard(state.adminSystem)])];
}

function buildSignupModeCard(sys) {
  const current = sys?.signupMode || "open";
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "회원가입 정책" }),
        el("p", {
          class: "muted",
          text: "새 사용자가 스스로 가입하는 방식을 정합니다. 첫 관리자 계정은 정책과 무관하게 항상 허용됩니다.",
        }),
      ]),
    ]),
  );
  const modes = [
    { id: "open", label: "개방", desc: "누구나 즉시 가입하고 바로 사용할 수 있습니다." },
    { id: "approval", label: "승인 후 사용", desc: "가입은 가능하지만 관리자가 활성화해야 로그인됩니다. 대기 중인 계정은 사용자 탭에 ‘정지’ 상태로 표시됩니다." },
    { id: "closed", label: "차단", desc: "신규 가입을 받지 않습니다." },
  ];
  const opts = el("div", { class: "radio-cards" });
  for (const m of modes) {
    const input = el("input", { type: "radio", name: "signup-mode", id: `sm-${m.id}` });
    input.value = m.id;
    input.checked = m.id === current;
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      opts.querySelectorAll("input").forEach((i) => (i.disabled = true));
      try {
        await api("/api/admin/signup-mode", { method: "PUT", body: JSON.stringify({ mode: m.id }) });
      } catch (e) {
        notify(`저장 실패: ${e.message}`);
        // Restore the last-saved selection rather than leaving the group blank.
        const prior = opts.querySelector(`#sm-${state.signupMode || current}`);
        if (prior) prior.checked = true;
        else input.checked = false;
        opts.querySelectorAll("input").forEach((i) => (i.disabled = false));
        return;
      }
      state.signupMode = m.id;
      try {
        await loadAdminSystem();
        notify("회원가입 정책을 저장했습니다.", "ok");
      } catch (e) {
        notify(`회원가입 정책은 저장했지만 상태 새로고침에 실패했습니다: ${e.message}`, "warn");
      } finally {
        opts.querySelectorAll("input").forEach((i) => (i.disabled = false));
      }
    });
    opts.append(
      el("label", { class: "radio-card", for: `sm-${m.id}` }, [
        input,
        el("div", { class: "radio-card-body" }, [
          el("strong", { text: m.label }),
          el("div", { class: "muted", text: m.desc }),
        ]),
      ]),
    );
  }
  card.append(opts);
  return card;
}

/* ---- 감사 로그 ---- */
async function adminAuditCards() {
  await loadAudit();
  const rows = state.audit || [];
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "감사 로그" }),
        el("p", { class: "muted", text: `최근 활동 ${rows.length}건 (로그인·권한 변경·관리 작업 등).` }),
      ]),
    ]),
  );

  const tableWrap = el("div", { class: "audit-table-wrap" });
  const render = (filterAction) => {
    const shown = filterAction ? rows.filter((r) => r.action === filterAction) : rows;
    if (!shown.length) {
      if (filterAction) {
        const resetAuditFilter = () => {
          filter.value = "";
          render("");
          filter.focus();
        };
        tableWrap.replaceChildren(
          el("div", { class: "muted pad" }, [
            `"${filterAction}" 액션 기록이 없습니다. `,
            el("button", { class: "linkish small", type: "button", text: "전체 액션 보기", onclick: resetAuditFilter }),
          ]),
        );
      } else {
        tableWrap.replaceChildren(el("div", { class: "muted pad", text: "기록이 없습니다." }));
      }
      return;
    }
    const body = shown.map((r) =>
      el("div", { class: "audit-row" }, [
        el("span", { class: "audit-time muted", text: timeLabel(r.createdAt) }),
        el("span", { class: "audit-actor", text: r.actorName || "—" }),
        el("span", { class: "tag mono", text: r.action }),
        el("span", { class: `tag ${r.status === "success" ? "read" : "danger"}`, text: r.status }),
        el("span", { class: "audit-detail muted", text: r.detail || "" }),
      ]),
    );
    tableWrap.replaceChildren(el("div", { class: "audit-table" }, body));
  };

  const actions = [...new Set(rows.map((r) => r.action))].sort();
  const filter = el("select", { class: "admin-search", "aria-label": "액션 필터", disabled: actions.length ? null : "" });
  filter.append(el("option", { value: "", text: actions.length ? "전체 액션" : "필터할 액션 없음" }));
  for (const a of actions) filter.append(el("option", { value: a, text: a }));
  filter.addEventListener("change", () => render(filter.value));

  card.append(el("div", { class: "admin-users-head" }, [filter]), tableWrap);
  render("");
  return [el("div", { class: "admin-list" }, [card])];
}

/* Admin "시스템" tab: runtime/model info + subscription + model override + SSH policy. */
async function adminSystemCards() {
  await loadAdminSystem();
  const sys = state.adminSystem;
  if (!sys) {
    return [
      el("div", { class: "warn-box" }, [
        "시스템 정보를 불러올 수 없습니다. ",
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    ];
  }
  const runtimeLabel = sys.agentRuntime === "claude" ? "Claude Agent SDK" : "로컬 스텁";
  const authLabel = sys.authMode === "api_key" ? "API 키" : "구독 로그인";
  const rows = [
    sysRow("런타임", el("span", { class: "tag mono", text: runtimeLabel })),
    sysRow(
      "설정된 모델",
      sys.configuredModel
        ? el("span", { class: "tag mono", text: sys.configuredModel })
        : el("span", { class: "muted", text: "미설정 (SDK 기본값)" }),
    ),
    sysRow(
      "실제 사용 모델",
      sys.observedModel
        ? el("span", { class: "tag mono accent", text: sys.observedModel })
        : el("span", { class: "muted", text: "아직 확인되지 않음 (첫 대화 후 표시)" }),
    ),
    sysRow("인증 방식", el("span", { class: "tag", text: authLabel })),
    sysRow(
      "읽기 전용 도구",
      el("span", { class: "muted", text: (sys.readOnlyTools || []).join(", ") || "없음" }),
    ),
    sysRow(
      "Confluence",
      sys.confluenceConfigured
        ? el("span", { class: "tag", text: "host 설정됨" })
        : el("span", { class: "muted", text: "CONFLUENCE_URL 미설정" }),
    ),
  ];
  return [
    el("div", { class: "admin-list" }, [
      el("div", { class: "settings-card sys-card" }, [
        el("h3", { text: "시스템 정보" }),
        el("div", { class: "sys-grid" }, rows),
      ]),
      buildSubscriptionCard(sys),
      buildModelOverrideCard(sys),
      buildHexSshPolicyCard(sys),
    ]),
  ];
}

/* Admin model-override card: pick the agent model from the UI. An env
   ANTHROPIC_MODEL wins at runtime — surfaced here so the choice isn't silent. */
function buildModelOverrideCard(sys) {
  const override = sys.modelOverride || "";
  const envLocked = Boolean(sys.modelEnvLocked);
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "에이전트 모델" }),
        el("p", {
          class: "muted",
          text: "아바타 대화에 사용할 모델을 지정합니다. 비워 두면 SDK 기본값을 사용합니다. 예: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001.",
        }),
      ]),
    ]),
  );
  if (envLocked) {
    card.append(
      el("p", {
        class: "muted",
        text: ".env의 ANTHROPIC_MODEL이 설정되어 있어 환경 변수가 우선합니다. 아래 설정은 환경 변수가 없을 때만 적용됩니다.",
      }),
    );
  }
  const form = el(
    "form",
    {
      class: "settings-form",
      onsubmit: async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const value = (new FormData(formEl).get("model") || "").toString().trim();
        const btn = formEl.querySelector("button[type=submit]");
        const saved = btn.textContent;
        setFormBusy(formEl, true);
        btn.textContent = "저장 중…";
        const successMessage = value ? "모델을 저장했습니다." : "모델 지정을 해제했습니다. SDK 기본값을 사용합니다.";
        try {
          if (value) {
            await api("/api/admin/model", { method: "PUT", body: JSON.stringify({ model: value }) });
          } else {
            await api("/api/admin/model", { method: "DELETE" });
          }
        } catch (err) {
          btn.textContent = saved;
          setFormBusy(formEl, false);
          notify(`저장 실패: ${err.message}`);
          return;
        }
        try {
          await loadAdminSystem();
          renderView();
        } catch (err) {
          btn.textContent = saved;
          setFormBusy(formEl, false);
          notify(`모델 설정은 저장했지만 상태 새로고침에 실패했습니다: ${err.message}`, "warn");
          return;
        }
        notify(successMessage, "ok");
      },
    },
    [
      el("label", { class: "field" }, [
        el("span", { text: "모델 이름" }),
        el("input", { name: "model", value: override, placeholder: "claude-opus-4-8 (비우면 기본값)", autocomplete: "off" }),
      ]),
      el("button", { class: "primary", type: "submit", text: "저장" }),
    ],
  );
  card.append(form);
  return card;
}

/* Admin 구독 로그인 card: paste a `claude setup-token` token so the agent runs
   on a Claude subscription instead of an API key. Write-only — the stored token
   is never sent back, only whether one is present (sys.subscriptionConnected). */
function buildSubscriptionCard(sys) {
  const connected = Boolean(sys.subscriptionConnected);
  const tokenField = buildRevealableInput({
    name: "token",
    placeholder: "sk-ant-oat01-...",
    autocomplete: "off",
    ariaLabel: connected ? "Claude 구독 토큰 교체" : "Claude 구독 토큰",
    revealLabel: "토큰",
    required: true,
  });
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "구독 로그인" }),
        el("p", {
          class: "muted",
          text: "Claude 구독으로 에이전트를 구동합니다. ① 내 PC에서 claude setup-token 실행 → ② 출력된 sk-ant-oat… 토큰을 아래에 붙여넣고 저장하세요. 토큰은 암호화되어 저장되며 다시 표시되지 않습니다.",
        }),
      ]),
    ]),
  );

  // Connection status (+ a note when an env API key overrides the token).
  const statusRow = el("div", { class: "sys-row" }, [
    el("span", { class: "sys-key muted", text: "구독 연결" }),
    el("span", { class: "sys-val" }, [
      el("span", {
        class: connected ? "tag accent" : "muted",
        text: connected ? "● 연결됨" : "○ 미연결",
      }),
    ]),
  ]);
  card.append(el("div", { class: "sys-grid" }, [statusRow]));
  if (sys.apiKeyOverride) {
    card.append(
      el("p", {
        class: "muted",
        text: ".env의 ANTHROPIC_API_KEY가 설정되어 있어 API 키가 구독 토큰보다 우선합니다. 구독 토큰을 사용하려면 API 키를 비우세요.",
      }),
    );
  }

  // Disconnect button when a token is stored.
  if (connected) {
    const disBtn = el("button", { class: "ghost-sm danger", type: "button", text: "연결 해제" });
    disBtn.addEventListener("click", async () => {
      if (!window.confirm("저장된 구독 토큰을 삭제할까요?")) return;
      disBtn.disabled = true;
      const saved = disBtn.textContent;
      disBtn.textContent = "해제 중…";
      try {
        await api("/api/admin/claude-token", { method: "DELETE" });
      } catch (e) {
        disBtn.textContent = saved;
        disBtn.disabled = false;
        notify(`해제 실패: ${e.message}`);
        return;
      }
      try {
        await loadAdminSystem();
        renderView();
      } catch (e) {
        disBtn.textContent = saved;
        disBtn.disabled = false;
        notify(`구독 토큰은 삭제했지만 상태 새로고침에 실패했습니다: ${e.message}`, "warn");
        return;
      }
      notify("구독 토큰 연결을 해제했습니다.", "ok");
    });
    card.append(el("div", { class: "ar-actions" }, [disBtn]));
  }

  // Paste/replace form.
  const form = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const token = (new FormData(formEl).get("token") || "").toString().trim();
      if (!token) {
        notify("토큰을 붙여넣어 주세요.", "warn");
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        await api("/api/admin/claude-token", { method: "PUT", body: JSON.stringify({ token }) });
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`저장 실패: ${err.message}`);
        return;
      }
      try {
        await loadAdminSystem();
        renderView();
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`구독 토큰은 저장했지만 상태 새로고침에 실패했습니다: ${err.message}`, "warn");
        return;
      }
      notify("구독 토큰을 저장했습니다.", "ok");
    },
  }, [
    el("label", { class: "field" }, [
      el("span", { text: connected ? "토큰 교체" : "Claude 구독 토큰" }),
      tokenField.wrap,
    ]),
    el("button", { class: "primary", type: "submit", text: "저장" }),
  ]);
  card.append(form);
  return card;
}

function buildHexSshPolicyCard(sys) {
  const tools = Array.isArray(sys.hexSshTools) ? sys.hexSshTools : [];
  const policy = sys.hexSshToolPolicy || {};
  const roles = [
    { key: "owner", label: "소유자" },
    { key: "trusted", label: "신뢰 동료" },
    { key: "colleague", label: "일반 동료" },
  ];
  const categoryLabels = {
    read: "조회",
    execute: "실행",
    write: "수정·전송",
    session: "세션",
  };
  const children = [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "SSH 도구 정책" }),
        el("p", { class: "muted", text: "역할별로 hex-ssh MCP 도구 노출과 실행을 제한합니다." }),
      ]),
    ]),
  ];
  if (!tools.length) {
    children.push(
      el("div", { class: "empty-note" }, [
        "현재 설정할 SSH 도구가 없습니다. hex-ssh 도구 목록이 서버에서 제공되면 역할별 정책 표가 여기에 표시됩니다.",
      ]),
    );
    return el("section", { class: "settings-card" }, children);
  }
  const form = el("form", {
    class: "hex-policy-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const nextPolicy = Object.fromEntries(roles.map((role) => [role.key, []]));
      formEl.querySelectorAll("input[data-role][data-tool]").forEach((input) => {
        if (input.checked) nextPolicy[input.dataset.role].push(input.dataset.tool);
      });
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        await api("/api/admin/hex-ssh-policy", { method: "PUT", body: JSON.stringify({ policy: nextPolicy }) });
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`저장 실패: ${err.message}`);
        return;
      }
      try {
        await loadAdminSystem();
        renderView();
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`SSH 도구 정책은 저장했지만 상태 새로고침에 실패했습니다: ${err.message}`, "warn");
        return;
      }
      notify("SSH 도구 정책을 저장했습니다.", "ok");
    },
  });

  const grid = el("div", { class: "hex-policy-grid" });
  grid.append(
    el("div", { class: "hex-policy-head muted", text: "도구" }),
    ...roles.map((role) => el("div", { class: "hex-policy-head", text: role.label })),
  );
  for (const tool of tools) {
    grid.append(
      el("div", { class: "hex-policy-tool" }, [
        el("strong", { text: tool.label || tool.name }),
        el("span", { class: "muted mono", text: tool.name }),
        el("span", { class: `tag ${tool.category === "read" ? "read" : "write"}`, text: categoryLabels[tool.category] || tool.category }),
      ]),
    );
    for (const role of roles) {
      const checked = Array.isArray(policy[role.key]) && policy[role.key].includes(tool.name);
      const label = el("label", { class: "hex-policy-check" }, [
        el("input", {
          type: "checkbox",
          checked,
          dataset: { role: role.key, tool: tool.name },
          "aria-label": `${role.label} ${tool.label || tool.name}`,
        }),
      ]);
      grid.append(label);
    }
  }

  form.append(
    grid,
    el("div", { class: "form-actions" }, [
      el("button", { class: "primary", type: "submit", text: "정책 저장" }),
    ]),
  );

  children.push(form);
  return el("section", { class: "settings-card" }, children);
}

function sysRow(label, valueNode) {
  return el("div", { class: "sys-row" }, [
    el("span", { class: "sys-key muted", text: label }),
    el("span", { class: "sys-val" }, [valueNode]),
  ]);
}
