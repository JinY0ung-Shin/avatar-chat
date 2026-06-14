// Auto-split from app.js — module: inbox. Behavior-preserving relocation only.
import { capPref, chatAboutTopic, consumeSse, setCapPref } from "./chat.js";
import { api, dom, el, icon, isSessionExpired, newId, notify, setFormBusy, state, timeLabel, triggerSessionExpired } from "./core.js";
import { loadKnowledge, loadNotifications, loadRoutineConversations, updateInboxBadge, updateKnowledgeBadge, updateNotificationBadge } from "./loaders.js";
import { renderView } from "./nav.js";
import { openRoutineResult } from "./routines.js";
import { viewHeader, wireSegmentedRadioKeys } from "./shell.js";


// One notification row (avatar → owner). `refresh` re-renders the inbox in place
// after a read/read-all so we don't blow away the whole view.
function buildNotificationRow(n, refresh) {
  // Messenger-style: the whole card is clickable — it opens a fresh chat with my
  // own avatar seeded with this notification's topic (and marks it read). A delete
  // (X) dismisses it; the routine ones keep a "결과 보기" shortcut.
  const row = el("div", {
    class: `notification-row clickable ${n.readAt ? "" : "unread"}`,
    role: "button",
    tabindex: "0",
    "aria-label": `알림 열기: ${n.title}`,
    title: "알림 주제로 대화 열기",
    onclick: (e) => {
      if (row.getAttribute("aria-busy") === "true") return;
      if (e.target.closest("button")) return; // inner actions handle themselves
      openNotificationChat(n);
    },
    onkeydown: (e) => {
      if (row.getAttribute("aria-busy") === "true") return;
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openNotificationChat(n);
      }
    },
  }, [
    el("div", { class: "pr-main" }, [
      el("div", { class: "inbox-row-head" }, [
        el("span", { class: "inbox-chip note", text: "알림" }),
        el("strong", { text: n.title }),
      ]),
      el("div", { class: "pr-sub", text: `${n.avatarDisplayName} · ${timeLabel(n.createdAt)}` }),
      el("p", { text: n.message }),
    ]),
  ]);
  const actions = el("div", { class: "kr-actions" });
  if (n.conversationId && state.routineConversations.some((c) => c.id === n.conversationId)) {
    actions.append(el("button", {
      class: "ghost-sm",
      type: "button",
      text: "결과 보기",
      onclick: () => {
        markNotificationRead(n);
        openRoutineResult(n.conversationId);
      },
    }));
  }
  const delBtn = el("button", { class: "msg-act danger", type: "button", "aria-label": "알림 삭제", title: "알림 삭제" });
  delBtn.append(icon("trash"));
  delBtn.addEventListener("click", async () => {
    setFormBusy(row, true);
    const savedTitle = delBtn.title;
    const savedLabel = delBtn.getAttribute("aria-label");
    delBtn.title = "삭제 중…";
    delBtn.setAttribute("aria-label", "알림 삭제 중");
    try {
      await api(`/api/me/notifications/${encodeURIComponent(n.id)}`, { method: "DELETE" });
      try {
        await refresh?.({ surfaceErrors: true });
        notify("알림을 삭제했습니다.", "ok");
      } catch (err) {
        setFormBusy(row, false);
        delBtn.title = savedTitle;
        delBtn.setAttribute("aria-label", savedLabel || "알림 삭제");
        notify(`알림은 삭제했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
      }
    } catch (e) {
      setFormBusy(row, false);
      delBtn.title = savedTitle;
      delBtn.setAttribute("aria-label", savedLabel || "알림 삭제");
      notify(`삭제 실패: ${e.message}`);
    }
  });
  actions.append(delBtn);
  row.append(actions);
  return row;
}

function markNotificationRead(n) {
  if (!n || n.readAt) return;
  n.readAt = new Date().toISOString();
  updateInboxBadge();
  // Fire-and-forget; the navigation target should not wait on this bookkeeping.
  api(`/api/me/notifications/${encodeURIComponent(n.id)}/read`, { method: "PATCH" }).catch(() => {});
}

// Open a new chat with my own avatar, composer pre-filled with the notification's
// topic (the owner can edit before sending). Marks the notification read in passing.
function openNotificationChat(n) {
  markNotificationRead(n);
  const seed = `다음은 네가 남긴 알림이야. 이 주제로 이어서 이야기하자.\n\n[${n.title}]\n${n.message}`;
  chatAboutTopic(seed);
}

/* ============================================================ Inbox (알림) */
// Notification hub: avatar notifications + colleague info-requests in one
// chronological list. Notifications are messenger-style (click → chat about the
// topic, X → delete); info-requests keep their answer/dismiss flow. Two backends
// (avatar_notifications / knowledge_requests) stay distinct — this merges only the UI.
let inboxViewSeq = 0;

export async function renderInboxView() {
  const renderSeq = ++inboxViewSeq;
  const header = viewHeader("알림", "아바타가 남긴 알림과 동료의 정보 요청을 한곳에서 확인하세요");
  const body = el("div", { class: "view-body scroll-thin inbox-body" }, [
    el("div", { class: "muted pad", text: "불러오는 중…" }),
  ]);
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === inboxViewSeq && state.view === "inbox" && body.isConnected;

  // routineConversations only gates the notification "결과 보기" link — its failure
  // shouldn't blank the whole list, so it's tolerated separately.
  const results = await Promise.allSettled([loadKnowledge(), loadNotifications(), loadRoutineConversations()]);
  if (isSessionExpired()) return;
  if (!isCurrent()) return;
  if (results[0].status === "rejected" && results[1].status === "rejected") {
    body.replaceChildren(
      el("div", { class: "warn-box" }, [
        `알림을 불러오지 못했습니다: ${results[0].reason?.message || "네트워크 오류"} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }
  const loadWarnings = [];
  if (results[0].status === "rejected") loadWarnings.push("정보 요청");
  if (results[1].status === "rejected") loadWarnings.push("아바타 알림");
  if (results[2].status === "rejected") loadWarnings.push("루틴 결과 링크");
  const loadWarning = loadWarnings.length
    ? el("div", { class: "warn-box inbox-load-warning" }, [
        `일부 항목(${loadWarnings.join(" · ")})을 불러오지 못했습니다. 표시된 목록은 일부만 최신일 수 있습니다. `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ])
    : null;
  updateKnowledgeBadge();
  updateNotificationBadge();

  const list = el("div", { class: "inbox-list" });
  const headerActions = el("div", { class: "head-actions" });
  const filterBar = el("div", { class: "inbox-filter seg-control", role: "radiogroup", "aria-label": "알림 필터" });
  wireSegmentedRadioKeys(filterBar);
  const card = el("section", { class: "settings-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "알림" }),
        el("p", { class: "muted", text: "알림을 누르면 그 주제로 내 아바타와 대화할 수 있고, 휴지통으로 삭제합니다. ‘정보 요청’은 답을 적어 보내면 아바타가 지식 저장소에 기록합니다." }),
      ]),
      headerActions,
    ]),
    loadWarning,
    filterBar,
    list,
  ]);
  let resetInboxFilter = null;
  const syncFilters = () => {
    const openRequests = state.knowledgeRequests.filter((r) => r.status === "open").length;
    const totalNotifications = state.notifications.length;
    const unreadNotifications = state.notifications.filter((n) => !n.readAt).length;
    const filters = [
      { id: "all", label: `전체 ${openRequests + totalNotifications}` },
      { id: "requests", label: `정보 요청 ${openRequests}` },
      { id: "unread", label: `읽지 않은 알림 ${unreadNotifications}` },
      { id: "notifications", label: `알림 ${totalNotifications}` },
    ];
    if (!filters.some((f) => f.id === state.inboxFilter)) state.inboxFilter = "all";
    filterBar.replaceChildren(
      ...filters.map((f) => {
        const active = state.inboxFilter === f.id;
        return el("button", {
          class: `seg-btn ${active ? "active" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
          dataset: { value: f.id },
          text: f.label,
          onclick: () => {
            state.inboxFilter = f.id;
            syncFilters();
            renderInboxItems(list, refresh, resetInboxFilter);
          },
        });
      }),
    );
  };

  const refresh = async ({ surfaceErrors = false } = {}) => {
    let refreshError = null;
    try {
      await Promise.all([loadKnowledge(), loadNotifications()]);
    } catch (err) {
      refreshError = err;
      /* keep current state on transient failure */
    }
    if (!isCurrent()) return;
    updateKnowledgeBadge();
    updateNotificationBadge();
    syncHeaderActions();
    syncFilters();
    renderInboxItems(list, refresh, resetInboxFilter);
    if (refreshError && surfaceErrors) throw refreshError;
  };

  const syncHeaderActions = () => {
    headerActions.replaceChildren();
    const unread = state.notifications.filter((n) => !n.readAt).length;
    const total = state.notifications.length;
    if (unread) {
      headerActions.append(
        el("button", {
          class: "ghost-sm",
          type: "button",
          text: "알림 모두 읽음",
          onclick: async (event) => {
            const btn = event.currentTarget;
            const saved = btn.textContent;
            setFormBusy(card, true);
            btn.textContent = "처리 중…";
            try {
              await api("/api/me/notifications/read-all", { method: "POST" });
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`처리 실패: ${e.message}`);
              return;
            }
            try {
              await refresh({ surfaceErrors: true });
              setFormBusy(card, false);
              notify(`알림 ${unread}개를 읽음 처리했습니다.`, "ok");
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`알림은 읽음 처리했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
            }
          },
        }),
      );
    }
    if (total) {
      headerActions.append(
        el("button", {
          class: "ghost-sm danger",
          type: "button",
          text: "알림 비우기",
          onclick: async (event) => {
            if (!window.confirm(`알림 ${total}개를 모두 삭제할까요? 정보 요청은 삭제되지 않습니다.`)) return;
            const btn = event.currentTarget;
            const saved = btn.textContent;
            setFormBusy(card, true);
            btn.textContent = "삭제 중…";
            try {
              await api("/api/me/notifications", { method: "DELETE" });
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`삭제 실패: ${e.message}`);
              return;
            }
            try {
              await refresh({ surfaceErrors: true });
              setFormBusy(card, false);
              notify(`알림 ${total}개를 삭제했습니다.`, "ok");
            } catch (e) {
              setFormBusy(card, false);
              btn.textContent = saved;
              notify(`알림은 삭제했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
            }
          },
        }),
      );
    }
  };

  resetInboxFilter = () => {
    state.inboxFilter = "all";
    syncFilters();
    renderInboxItems(list, refresh, resetInboxFilter);
    filterBar.querySelector('[data-value="all"]')?.focus();
  };
  syncHeaderActions();
  syncFilters();
  renderInboxItems(list, refresh, resetInboxFilter);
  if (!isCurrent()) return;
  body.replaceChildren(el("div", { class: "inbox-wrap" }, [card]));
}

function renderInboxItems(list, refresh, resetFilter = null) {
  list.replaceChildren();
  const items = [
    ...state.knowledgeRequests
      .filter((r) => r.status === "open")
      .map((r) => ({ kind: "request", at: r.createdAt || "", data: r })),
    ...state.notifications.map((n) => ({ kind: "notification", at: n.createdAt || "", data: n })),
  ].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  const filtered =
    state.inboxFilter === "requests"
      ? items.filter((item) => item.kind === "request")
      : state.inboxFilter === "unread"
        ? items.filter((item) => item.kind === "notification" && !item.data.readAt)
        : state.inboxFilter === "notifications"
          ? items.filter((item) => item.kind === "notification")
          : items;

  if (!filtered.length) {
    const emptyTexts = {
      all: "새 알림이나 정보 요청이 없습니다.",
      requests: "열린 정보 요청이 없습니다.",
      unread: "읽지 않은 알림이 없습니다.",
      notifications: "아바타 알림이 없습니다.",
    };
    const emptyText = items.length
      ? `이 필터에 해당하는 항목이 없습니다. ${emptyTexts[state.inboxFilter] || ""}`.trim()
      : emptyTexts[state.inboxFilter] || emptyTexts.all;
    const emptyChildren = [emptyText];
    if (items.length && state.inboxFilter !== "all") {
      emptyChildren.push("\n", el("button", { class: "linkish small", type: "button", text: "전체 보기", onclick: () => resetFilter?.() }));
    }
    list.append(el("div", { class: "empty-note" }, emptyChildren));
    return;
  }
  for (const item of filtered) {
    list.append(
      item.kind === "request"
        ? buildKnowledgeRequestRow(item.data, refresh)
        : buildNotificationRow(item.data, refresh),
    );
  }
}

// One info-request row (colleague → owner). `refresh` re-renders the inbox after
// a record/ignore so the resolved row drops out in place.
function buildKnowledgeRequestRow(r, refresh) {
  // Inline "record" composer — hidden until the owner chooses to teach the
  // avatar an answer. Keeping it in the row means the question stays in view
  // while typing, and the whole flow happens without leaving the inbox.
  const composeId = `knowledge-compose-${r.id || newId()}`;
  const textarea = el("textarea", {
    class: "kr-answer",
    rows: "3",
    placeholder: "이 질문에 대한 답·정보를 적어주세요. 아바타가 지식 저장소에 기록하고 이 요청을 닫습니다.",
    "aria-label": "정보 요청 답변",
  });
  const sendBtn = el("button", { class: "primary small", type: "button", text: "기록 요청" });
  const cancelBtn = el("button", { class: "ghost-sm", type: "button", text: "취소" });
  const compose = el("div", { id: composeId, class: "kr-compose", hidden: "" }, [
    textarea,
    el("div", { class: "kr-compose-actions" }, [sendBtn, cancelBtn]),
  ]);

  // Two intents, made explicit: "정보 추가" teaches the avatar (records the
  // answer into the knowledge repo); "무시" only clears the notification — the
  // old DELETE resolve, which never taught the avatar anything.
  const addBtn = el("button", {
    class: "primary small",
    type: "button",
    text: "정보 추가",
    "aria-controls": composeId,
    "aria-expanded": "false",
    title: "답변 입력창 열기",
  });
  const ignoreBtn = el("button", { class: "ghost-sm", type: "button", text: "무시" });

  addBtn.addEventListener("click", () => {
    const willShow = compose.hidden;
    compose.hidden = !willShow;
    addBtn.classList.toggle("active", willShow);
    addBtn.setAttribute("aria-expanded", willShow ? "true" : "false");
    if (willShow) textarea.focus();
  });
  cancelBtn.addEventListener("click", () => {
    compose.hidden = true;
    addBtn.classList.remove("active");
    addBtn.setAttribute("aria-expanded", "false");
  });
  ignoreBtn.addEventListener("click", async () => {
    const controls = [textarea, sendBtn, cancelBtn, addBtn, ignoreBtn];
    controls.forEach((c) => (c.disabled = true));
    const saved = ignoreBtn.textContent;
    ignoreBtn.textContent = "무시 중…";
    try {
      await api(`/api/me/knowledge/requests/${encodeURIComponent(r.id)}`, { method: "DELETE" });
    } catch (e) {
      ignoreBtn.textContent = saved;
      controls.forEach((c) => (c.disabled = false));
      notify(`무시 처리 실패: ${e.message}`);
      return;
    }
    try {
      await refresh?.({ surfaceErrors: true });
      notify("정보 요청을 무시했습니다.", "ok");
    } catch (e) {
      ignoreBtn.textContent = saved;
      controls.forEach((c) => (c.disabled = false));
      notify(`정보 요청은 무시했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
    }
  });
  sendBtn.addEventListener("click", async () => {
    const answer = textarea.value.trim();
    if (!answer) {
      textarea.focus();
      notify("기록할 답변을 입력해 주세요.", "warn");
      return;
    }
    const controls = [textarea, sendBtn, cancelBtn, addBtn, ignoreBtn];
    controls.forEach((c) => (c.disabled = true));
    const sendLabel = sendBtn.textContent;
    sendBtn.textContent = "기록 중…";
    const result = await recordKnowledgeViaAvatar(r, answer);
    if (!result.ok) {
      controls.forEach((c) => (c.disabled = false));
      sendBtn.textContent = sendLabel;
      notify(`기록 요청 실패: ${result.error}`);
      return;
    }
    // The avatar resolves the request itself after committing; a refresh then
    // drops this row out (the list re-renders). If it's still open afterward
    // the recording didn't complete — say so honestly instead of claiming success.
    try {
      await refresh?.();
    } catch (e) {
      controls.forEach((c) => (c.disabled = false));
      sendBtn.textContent = sendLabel;
      notify(`기록은 요청했지만 목록 새로고침에 실패했어요: ${e.message}`, "warn");
      return;
    }
    const stillOpen = state.knowledgeRequests.some((x) => x.id === r.id && x.status === "open");
    notify(
      stillOpen
        ? "아바타가 기록을 완료하지 못한 것 같아요. ‘대화’의 ‘지식 기록’ 스레드를 확인해 주세요."
        : "아바타가 답을 지식 저장소에 기록했어요.",
      stillOpen ? "warn" : "info",
    );
  });

  return el("div", { class: "knowledge-row" }, [
    el("div", { class: "inbox-row-head" }, [
      el("span", { class: "inbox-chip req", text: "정보 요청" }),
    ]),
    el("div", { class: "kr-q", text: r.question }),
    r.askerName
      ? el("div", { class: "muted kr-meta", text: `질문자: ${r.askerName} · ${timeLabel(r.createdAt)}` })
      : el("div", { class: "muted kr-meta", text: timeLabel(r.createdAt) }),
    el("div", { class: "kr-actions" }, [addBtn, ignoreBtn]),
    compose,
  ]);
}

// Per-user localStorage key for the reused "지식 기록" conversation (below).
function knowledgeRecConvKey() {
  return `noah.knowledgeRecordConv.${state.user?.id || "anon"}`;
}

// Recordings share one reused conversation, so two in flight would collide on
// the same SDK session — a module-level guard serializes them.
let knowledgeRecordInFlight = false;

// Teach the avatar an answer WITHOUT leaving the settings view: post a normal
// owner turn to the chat stream and silently drain the SSE. The avatar (the
// owner's own, so it carries elevated repo + knowledge tools) writes the answer
// into its knowledge repo, commits, and then calls resolve_request — so the gap
// clears itself only once the knowledge is actually saved, not optimistically on
// click. Reuses one hidden "지식 기록" conversation per user so these turns don't
// litter the sidebar with a fresh conversation every time.
async function recordKnowledgeViaAvatar(request, answer) {
  const avatarId = state.user?.id;
  if (!avatarId) return { ok: false, error: "로그인이 필요합니다." };
  if (knowledgeRecordInFlight) {
    return { ok: false, error: "다른 기록 요청을 처리하는 중이에요. 잠시 후 다시 시도해 주세요." };
  }
  knowledgeRecordInFlight = true;
  try {
    const askerBit = request.askerName ? `동료 "${request.askerName}"가` : "한 동료가";
    const message =
      `${askerBit} 다음을 물었는데 내가 답하지 못했어:\n` +
      `"${request.question}"\n\n` +
      "아래 정보를 내 지식 저장소(knowledge repo)에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘. " +
      "적절한 스킬이나 문서에 반영하고 commit까지 해줘. 기록을 커밋한 뒤에는 이 정보 요청을 " +
      `resolve_request 도구로 닫아줘 (request_id: ${request.id}).\n\n` +
      `--- 기록할 내용 ---\n${answer}`;

    const prevConv = capPref(knowledgeRecConvKey(), "") || undefined;
    let response;
    try {
      response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ avatarId, message, conversationId: prevConv }),
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    if (response.status === 401) {
      triggerSessionExpired();
      return { ok: false, error: "세션이 만료되었습니다." };
    }
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }

    let convId = null;
    let runId = null;
    let errText = null;
    try {
      await consumeSse(response.body, (event, data) => {
        if (event === "open") {
          if (data?.conversationId) convId = data.conversationId;
          if (data?.runId) runId = data.runId;
        } else if (event === "error") {
          errText = data?.error || "오류가 발생했습니다.";
        } else if (event === "permission" && runId && data?.requestId) {
          // No prompt UI in settings. The avatar's repo/knowledge tools are
          // auto-approved server-side, so a prompt here means an unexpected
          // action — deny it rather than run something the owner can't see.
          api("/api/chat/respond", { method: "POST", body: JSON.stringify({ runId, requestId: data.requestId, value: { behavior: "deny" } }) }).catch(() => {});
        } else if (event === "question" && runId && data?.requestId) {
          api("/api/chat/respond", { method: "POST", body: JSON.stringify({ runId, requestId: data.requestId, value: { cancelled: true } }) }).catch(() => {});
        }
      });
    } catch (e) {
      // Network drop / aborted stream mid-run — surface it instead of leaving the
      // row stuck on "기록 중…".
      return { ok: false, error: e.message || "스트림 연결이 끊어졌습니다." };
    }

    // Remember (and name) the conversation so later recordings reuse one thread.
    if (convId && convId !== prevConv) {
      setCapPref(knowledgeRecConvKey(), convId);
      api(`/api/conversations/${encodeURIComponent(convId)}`, { method: "PATCH", body: JSON.stringify({ title: "지식 기록" }) }).catch(() => {});
    }
    if (errText) return { ok: false, error: errText };
    return { ok: true };
  } finally {
    knowledgeRecordInFlight = false;
  }
}
