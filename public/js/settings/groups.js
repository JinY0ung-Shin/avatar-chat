// Auto-split from settings.js — submodule: groups. Behavior-preserving relocation only.
import { avatarNode } from "../avatar-image.js";
import { chatAboutTopic, invalidateSkillsCache } from "../chat.js";
import { api, el, icon, notify, setFormBusy, state, wireExpander } from "../core.js";
import { startChatWith } from "../explore.js";
import { goView, renderView } from "../nav.js";
import { attachUserSearch } from "./index.js";
import { repoToHref } from "./knowledgeRepo.js";
import { renderPluginSelectionContents } from "./plugins.js";

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

export function buildGroupsCard() {
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
