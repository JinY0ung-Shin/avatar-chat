// Auto-split from app.js — module: routines. Behavior-preserving relocation only.
import { renderAssistantInto, selectConversation } from "./chat.js";
import { api, dom, el, icon, isSessionExpired, notify, renderMarkdown, setFormBusy, state, timeLabel } from "./core.js";
import { loadNotifications, loadRoutineConversations, loadRoutines, updateNotificationBadge } from "./loaders.js";
import { renderView, syncHash } from "./nav.js";
import { buildToggle, openModal, viewHeader, wireSegmentedRadioKeys } from "./shell.js";


/* ============================================================ Routines view */
const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

// Korean schedule formatter (user-facing). Mirrors the RoutineSchedule contract.
function formatRoutineSchedule(r) {
  const kind = r.scheduleKind || "daily";
  if (kind === "weekly") {
    const days = Array.isArray(r.daysOfWeek) ? r.daysOfWeek : [];
    const labels = days.map((d) => WEEKDAY_NAMES[d] ?? "?").join("·");
    return `매주 ${labels} ${r.time} (KST)`;
  }
  if (kind === "interval") {
    const n = Number(r.intervalMinutes) || 0;
    if (n % 60 === 0) return `${n / 60}시간마다`;
    return `${n}분마다`;
  }
  return `매일 ${r.time} (KST)`;
}

// Short title for a routine row: explicit name, else a one-line prompt preview.
function routineTitle(r) {
  const name = (r.name || "").trim();
  if (name) return name;
  const oneLine = (r.prompt || "").replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine || "(이름 없는 루틴)";
}

// Builds the schedule-form section (daily/weekly/interval) for the routine modal.
// Mirrors the server's routineSchedule.ts semantics on the client.
// `routine` is the existing routine object (or null for create).
// Returns { element, getSchedulePayload, validateSchedule, applyKindVisibility }.
function buildScheduleForm(routine) {
  const initialKind = routine?.scheduleKind || "daily";
  const kindSelect = el("select", { name: "scheduleKind", "aria-label": "주기" }, [
    el("option", { value: "daily", text: "매일" }),
    el("option", { value: "weekly", text: "매주" }),
    el("option", { value: "interval", text: "간격" }),
  ]);
  kindSelect.value = initialKind;

  const timeInput = el("input", {
    name: "time",
    type: "time",
    "aria-label": "실행 시각",
    value: routine?.time || "09:00",
  });
  const timeRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "시각" }),
    timeInput,
  ]);

  // Weekday chips (매주).
  const selectedDays = new Set(Array.isArray(routine?.daysOfWeek) ? routine.daysOfWeek : []);
  const dayChipWrap = el("div", { class: "weekday-chips", role: "group", "aria-label": "반복 요일" });
  const dayChips = WEEKDAY_NAMES.map((label, idx) => {
    const chip = el("button", {
      type: "button",
      class: `weekday-chip ${selectedDays.has(idx) ? "selected" : ""}`,
      "aria-pressed": selectedDays.has(idx) ? "true" : "false",
      text: label,
    });
    chip.addEventListener("click", () => {
      if (selectedDays.has(idx)) selectedDays.delete(idx);
      else selectedDays.add(idx);
      const on = selectedDays.has(idx);
      chip.classList.toggle("selected", on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      dayChipWrap.removeAttribute("aria-invalid");
    });
    return chip;
  });
  dayChipWrap.append(...dayChips);
  const daysRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "요일" }),
    dayChipWrap,
  ]);

  // Interval (간격): number + unit.
  const intervalMin = Number(routine?.intervalMinutes) || 0;
  const intervalUnit = el("select", { class: "narrow", "aria-label": "반복 간격 단위" }, [
    el("option", { value: "hour", text: "시간" }),
    el("option", { value: "minute", text: "분" }),
  ]);
  let intervalValue = 1;
  if (intervalMin > 0 && intervalMin % 60 === 0) {
    intervalUnit.value = "hour";
    intervalValue = intervalMin / 60;
  } else if (intervalMin > 0) {
    intervalUnit.value = "minute";
    intervalValue = intervalMin;
  } else {
    intervalUnit.value = "hour";
    intervalValue = 1;
  }
  const intervalInput = el("input", {
    type: "number",
    min: "1",
    step: "1",
    class: "narrow",
    "aria-label": "반복 간격 값",
    value: String(intervalValue),
  });
  intervalInput.addEventListener("input", () => intervalInput.removeAttribute("aria-invalid"));
  intervalUnit.addEventListener("change", () => intervalInput.removeAttribute("aria-invalid"));
  const intervalRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "반복 간격" }),
    el("div", { class: "interval-inputs" }, [intervalInput, intervalUnit]),
  ]);

  const intervalMinutesFromInputs = () => {
    const n = Math.floor(Number(intervalInput.value) || 0);
    return intervalUnit.value === "hour" ? n * 60 : n;
  };

  const applyKindVisibility = () => {
    const kind = kindSelect.value;
    dayChipWrap.removeAttribute("aria-invalid");
    intervalInput.removeAttribute("aria-invalid");
    timeRow.hidden = kind === "interval";
    daysRow.hidden = kind !== "weekly";
    intervalRow.hidden = kind !== "interval";
  };
  kindSelect.addEventListener("change", applyKindVisibility);

  const kindRow = el("div", { class: "schedule-row" }, [
    el("label", { class: "schedule-label", text: "주기" }),
    kindSelect,
  ]);

  const element = el("div", { class: "schedule-builder" }, [kindRow, timeRow, daysRow, intervalRow]);

  const getSchedulePayload = () => {
    const kind = kindSelect.value;
    const payload = { scheduleKind: kind };
    if (kind === "daily" || kind === "weekly") payload.time = timeInput.value;
    if (kind === "weekly") payload.daysOfWeek = [...selectedDays].sort((a, b) => a - b);
    if (kind === "interval") payload.intervalMinutes = intervalMinutesFromInputs();
    return payload;
  };

  // Returns null if valid, or an error string if invalid.
  const validateSchedule = () => {
    const kind = kindSelect.value;
    dayChipWrap.removeAttribute("aria-invalid");
    intervalInput.removeAttribute("aria-invalid");
    if (kind === "weekly" && selectedDays.size === 0) {
      dayChipWrap.setAttribute("aria-invalid", "true");
      return "매주 반복은 요일을 1개 이상 선택해 주세요.";
    }
    if (kind === "interval" && intervalMinutesFromInputs() < 15) {
      intervalInput.setAttribute("aria-invalid", "true");
      return "반복 간격은 15분 이상이어야 합니다.";
    }
    return null;
  };

  const focusInvalid = () => {
    const kind = kindSelect.value;
    if (kind === "weekly" && selectedDays.size === 0) dayChips[0]?.focus();
    else if (kind === "interval" && intervalMinutesFromInputs() < 15) intervalInput.focus();
  };

  return { element, getSchedulePayload, validateSchedule, focusInvalid, applyKindVisibility };
}

// Centered create/edit modal for a routine. `routine === null` = create mode.
function openRoutineModal(routine) {
  const isEdit = Boolean(routine);

  // ---- Fields ----
  const nameInput = el("input", {
    name: "name",
    type: "text",
    placeholder: "예: 아침 서비스 점검",
    "aria-label": "루틴 이름",
    value: routine?.name || "",
  });

  const promptInput = el("textarea", {
    name: "prompt",
    rows: "4",
    placeholder: "예: 오늘의 서비스 상태를 요약해줘",
    "aria-label": "작업 프롬프트",
    required: "",
  });
  promptInput.value = routine?.prompt || "";

  const preview = el("div", { class: "routine-prompt-preview md" });
  const updatePreview = () => {
    const text = promptInput.value.trim();
    if (text) preview.innerHTML = renderMarkdown(text);
    else preview.replaceChildren(el("span", { class: "muted", text: "프롬프트 미리보기가 여기에 표시됩니다." }));
  };
  promptInput.addEventListener("input", () => {
    updatePreview();
    if (promptInput.value.trim()) promptInput.removeAttribute("aria-invalid");
  });

  const schedule = buildScheduleForm(routine);

  const errorBox = el("div", { class: "error", role: "alert", hidden: "" });
  const saveBtn = el("button", { class: "primary", type: "submit", text: "저장" });
  let routineModalBusy = false;

  openModal({
    cardClass: "routine-modal-card",
    ariaLabelledby: "routine-modal-title",
    canClose: () => !routineModalBusy,
    buildCard: (card, close) => {
      const afterSave = async (successMessage) => {
        try {
          await Promise.all([loadRoutines(), loadRoutineConversations()]);
        } catch (err) {
          routineModalBusy = false;
          close();
          renderView();
          notify(`루틴은 저장했지만 목록 새로고침에 실패했습니다: ${err.message}`, "warn");
          return;
        }
        routineModalBusy = false;
        close();
        renderView();
        notify(successMessage, "ok");
      };
      const setRoutineModalBusy = (busy) => {
        routineModalBusy = busy;
        card.setAttribute("aria-busy", busy ? "true" : "false");
        nameInput.disabled = busy;
        promptInput.disabled = busy;
        schedule.element.querySelectorAll("input, select, button").forEach((control) => {
          control.disabled = busy;
        });
        card.querySelectorAll(".routine-modal-actions button").forEach((control) => {
          control.disabled = busy;
        });
      };

      const form = el("form", {
        class: "routine-modal-form",
        onsubmit: async (e) => {
          e.preventDefault();
          if (!promptInput.value.trim()) {
            errorBox.textContent = "작업 프롬프트를 입력해 주세요.";
            errorBox.hidden = false;
            promptInput.setAttribute("aria-invalid", "true");
            promptInput.focus();
            return;
          }
          promptInput.removeAttribute("aria-invalid");
          const schedErr = schedule.validateSchedule();
          if (schedErr) {
            errorBox.textContent = schedErr;
            errorBox.hidden = false;
            schedule.focusInvalid();
            return;
          }
          errorBox.hidden = true;
          const savedLabel = saveBtn.textContent;
          setRoutineModalBusy(true);
          saveBtn.textContent = "저장 중…";
          try {
            const payload = {
              name: (nameInput.value || "").trim() || null,
              prompt: promptInput.value,
              ...schedule.getSchedulePayload(),
            };
            if (isEdit) {
              await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
            } else {
              await api("/api/me/routines", { method: "POST", body: JSON.stringify(payload) });
            }
            await afterSave(isEdit ? "루틴을 수정했습니다." : "루틴을 추가했습니다.");
          } catch (err) {
            errorBox.textContent = err.message || "저장에 실패했습니다.";
            errorBox.hidden = false;
            saveBtn.textContent = savedLabel;
            setRoutineModalBusy(false);
          }
        },
      }, [
        el("label", { class: "field" }, [
          el("span", { text: "이름 (선택)" }),
          nameInput,
        ]),
        el("label", { class: "field" }, [
          el("span", { text: "작업 프롬프트" }),
          promptInput,
        ]),
        el("div", { class: "routine-preview-wrap" }, [
          el("span", { class: "field-hint muted", text: "미리보기" }),
          preview,
        ]),
        schedule.element,
        errorBox,
      ]);

      // Action buttons.
      const actions = el("div", { class: "routine-modal-actions" });
      const leftActions = el("div", { class: "routine-modal-actions-left" });
      if (isEdit) {
        const runBtn = el("button", { class: "ghost-sm", type: "button", text: "지금 실행" });
        runBtn.addEventListener("click", async () => {
          const saved = runBtn.textContent;
          setRoutineModalBusy(true);
          runBtn.textContent = "실행 중…";
          try {
            await runRoutineNow(routine);
            routineModalBusy = false;
            close();
          } catch (err) {
            notify(`루틴 실행 실패: ${err.message}`);
            runBtn.textContent = saved;
            setRoutineModalBusy(false);
          }
        });
        leftActions.append(runBtn);

        const delBtn = el("button", { class: "ghost-sm danger", type: "button", text: "삭제" });
        delBtn.addEventListener("click", async () => {
          if (!window.confirm("이 루틴을 삭제할까요? 지난 실행 결과 기록은 더 이상 표시되지 않습니다.")) return;
          const saved = delBtn.textContent;
          setRoutineModalBusy(true);
          delBtn.textContent = "삭제 중…";
          try {
            await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
            state.routines = state.routines.filter((x) => x.id !== routine.id);
            state.routineConversations = state.routineConversations.filter((x) => x.routineId !== routine.id);
            if (state.routineConversationId === routine.conversationId) state.routineConversationId = "";
            routineModalBusy = false;
            close();
            renderView();
            notify("루틴을 삭제했습니다.", "ok");
          } catch (err) {
            notify(`삭제 실패: ${err.message}`);
            delBtn.textContent = saved;
            setRoutineModalBusy(false);
          }
        });
        leftActions.append(delBtn);
      }
      const rightActions = el("div", { class: "routine-modal-actions-right" }, [
        el("button", { class: "ghost-sm", type: "button", text: "닫기", onclick: () => close() }),
        saveBtn,
      ]);
      actions.append(leftActions, rightActions);
      form.append(actions);

      card.append(
        el("h2", { id: "routine-modal-title", text: isEdit ? "루틴 편집" : "루틴 추가" }),
        form,
      );
      return { focusTarget: isEdit ? promptInput : nameInput };
    },
  });
  schedule.applyKindVisibility();
  updatePreview();
}

let routinesViewSeq = 0;

export async function renderRoutinesView() {
  const renderSeq = ++routinesViewSeq;
  const header = viewHeader("루틴", "아바타가 스스로 실행하는 예약 작업과 그 결과를 관리하세요");
  const body = el("div", { class: "view-body routines-body" }, [
    el("div", { class: "muted pad", text: "불러오는 중…" }),
  ]);
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === routinesViewSeq && state.view === "routines" && body.isConnected;

  const results = await Promise.allSettled([loadRoutines(), loadRoutineConversations()]);
  if (isSessionExpired()) return;
  if (!isCurrent()) return;
  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    body.replaceChildren(
      el("div", { class: "warn-box" }, [
        `루틴 정보를 불러오지 못했습니다: ${failed.reason?.message || "네트워크 오류"} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }

  if (state.routineConversationId && !state.routineConversations.some((c) => c.id === state.routineConversationId)) {
    state.routineConversationId = state.routineConversations[0]?.id || "";
  } else if (!state.routineConversationId && state.routineConversations.length) {
    state.routineConversationId = state.routineConversations[0].id;
  }
  let messageLoadError = "";
  if (state.routineConversationId) {
    const conversationId = state.routineConversationId;
    try {
      const msgRes = await api(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
      if (!isCurrent() || state.routineConversationId !== conversationId) return;
      state.routineMessages = msgRes.messages || [];
    } catch (e) {
      if (!isCurrent() || state.routineConversationId !== conversationId) return;
      state.routineMessages = [];
      messageLoadError = e.message || "네트워크 오류";
    }
  } else {
    state.routineMessages = [];
  }

  if (!isCurrent()) return;
  body.replaceChildren(
    el("div", { class: "routine-workspace" }, [
      el("div", { class: "routine-side scroll-thin" }, [
        buildRoutineManagePanel(),
      ]),
      buildRoutineResultPanel(messageLoadError),
    ]),
  );
}

// The routines tab is now the single home for routines: this panel both MANAGES
// them (add/edit/toggle/run/delete) and selects which result transcript shows on
// the right. The old settings ▸ 루틴 tab is gone — this replaces it.
function buildRoutineManagePanel() {
  const list = el("div", { class: "routine-manage-list" });
  const filterBar = el("div", { class: "routine-filter seg-control", role: "radiogroup", "aria-label": "루틴 필터" });
  wireSegmentedRadioKeys(filterBar);
  const countLabel = el("span", { class: "muted nowrap" });
  const search = el("input", {
    class: "routine-search",
    type: "search",
    placeholder: "루틴 검색",
    value: state.routineSearch,
    "aria-label": "루틴 검색",
    disabled: state.routines.length ? null : "",
    oninput: () => {
      state.routineSearch = search.value;
      renderRoutineManageRows(list, { searchInput: search, filterBar, countLabel });
    },
  });
  const addBtn = el("button", { class: "primary small routine-add-btn", type: "button", onclick: () => openRoutineModal(null) });
  addBtn.append(icon("plus"), el("span", { text: "루틴 추가" }));
  const tools = el("div", { class: "routine-tools" }, [search, countLabel]);
  const card = el("section", { class: "settings-card routine-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "내 루틴" }),
        el("p", { class: "muted", text: "매일·매주 또는 일정 간격(KST)으로 아바타가 스스로 실행합니다. 카드를 누르면 결과가 오른쪽에 표시돼요." }),
      ]),
      addBtn,
    ]),
    tools,
    filterBar,
    list,
  ]);
  renderRoutineManageRows(list, { searchInput: search, filterBar, countLabel });
  return card;
}

function renderRoutineManageRows(list, { searchInput = null, filterBar = null, countLabel = null } = {}) {
  list.replaceChildren();
  const filterDefs = [
    { id: "all", label: "전체", match: () => true },
    { id: "enabled", label: "사용 중", match: (r) => r.enabled },
    { id: "paused", label: "일시 정지", match: (r) => !r.enabled },
    { id: "error", label: "실패", match: (r) => r.lastStatus === "error" },
  ];
  const filterLabel = (id) => filterDefs.find((f) => f.id === id)?.label || "전체";
  if (!filterDefs.some((f) => f.id === state.routineFilter)) state.routineFilter = "all";
  const syncFilters = () => {
    if (!filterBar) return;
    filterBar.replaceChildren(
      ...filterDefs.map((f) => {
        const active = state.routineFilter === f.id;
        const count = state.routines.filter(f.match).length;
        return el("button", {
          class: `seg-btn ${active ? "active" : ""}`,
          type: "button",
          role: "radio",
          "aria-checked": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
          dataset: { value: f.id },
          text: `${f.label} ${count}`,
          onclick: () => {
            state.routineFilter = f.id;
            renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
          },
        });
      }),
    );
  };
  syncFilters();
  if (!state.routines.length) {
    if (countLabel) countLabel.textContent = "총 0개";
    if (filterBar) filterBar.hidden = true;
    list.append(
      el("div", { class: "empty-note" }, [
        "아직 등록한 루틴이 없습니다.\n",
        el("button", { class: "linkish small", type: "button", text: "첫 루틴 추가", onclick: () => openRoutineModal(null) }),
      ]),
    );
    return;
  }
  if (filterBar) filterBar.hidden = false;
  const q = state.routineSearch.trim().toLowerCase();
  const activeFilter = filterDefs.find((f) => f.id === state.routineFilter) || filterDefs[0];
  const filtered = state.routines.filter(activeFilter.match);
  const routines = q
    ? filtered.filter((r) => {
        const haystack = [
          routineTitle(r),
          r.prompt || "",
          formatRoutineSchedule(r),
          r.enabled ? "사용 중" : "일시 정지",
          r.lastStatus === "error" ? "실패" : "완료",
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      })
    : filtered;
  if (countLabel) countLabel.textContent = routines.length === state.routines.length ? `총 ${state.routines.length}개` : `표시 ${routines.length}개 / 전체 ${state.routines.length}개`;
  if (!routines.length) {
    const resetRoutineFilter = () => {
      state.routineFilter = "all";
      renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
      filterBar?.querySelector('[data-value="all"]')?.focus();
    };
    const clearRoutineSearch = () => {
      state.routineSearch = "";
      if (searchInput) searchInput.value = "";
      renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
      searchInput?.focus();
    };
    const children = [
      q
        ? `"${state.routineSearch.trim()}"에 맞는 ${state.routineFilter === "all" ? "루틴" : `${filterLabel(state.routineFilter)} 루틴`}이 없습니다.\n`
        : `${filterLabel(state.routineFilter)} 루틴이 없습니다.\n`,
    ];
    if (q) children.push(el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearRoutineSearch }));
    if (state.routineFilter !== "all") children.push(q ? " " : "", el("button", { class: "linkish small", type: "button", text: "전체 루틴 보기", onclick: resetRoutineFilter }));
    list.append(
      el("div", { class: "empty-note" }, children),
    );
    return;
  }
  for (const r of routines) {
    const active = state.routineConversationId === r.conversationId;
    const errored = r.lastStatus === "error";

    // Status dot: green=enabled+ok, red=enabled+last error, grey=disabled.
    const dotClass = !r.enabled ? "off" : errored ? "err" : "on";
    const dot = el("span", { class: `routine-dot ${dotClass}`, "aria-hidden": "true" });

    const title = routineTitle(r);
    const toggle = buildToggle(r.enabled, async (val) => {
      try {
        await api(`/api/me/routines/${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: val }) });
      } catch (e) {
        notify(`변경 실패: ${e.message}`);
        throw e;
      }
      r.enabled = val;
      try {
        await loadRoutines();
        renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
        notify(`"${title}" 루틴을 ${val ? "사용" : "일시 정지"}했습니다.`, "ok");
      } catch (e) {
        renderRoutineManageRows(list, { searchInput, filterBar, countLabel });
        notify(`루틴 상태는 변경했지만 목록 새로고침에 실패했습니다: ${e.message}`, "warn");
      }
    }, `루틴 사용: ${title}`);
    // Don't let the toggle's click bubble to the row (which would change selection).
    toggle.addEventListener("click", (e) => e.stopPropagation());

    const meta = [formatRoutineSchedule(r)];
    if (r.lastRunAt) meta.push(`최근 실행 ${timeLabel(r.lastRunAt)} · ${errored ? "실패" : "완료"}`);
    else meta.push("아직 실행되지 않음");

    const editBtn = el("button", { class: "ghost-sm", type: "button" });
    editBtn.append(icon("edit"), el("span", { text: "편집" }));
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openRoutineModal(r);
    });

    let row;
    const runBtn = el("button", { class: "ghost-sm", type: "button", text: "지금 실행" });
    runBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runRoutineFromButton(r, runBtn, row);
    });
    const selectResult = () => {
      openRoutineResult(r.conversationId);
      notify(active ? `"${title}" 루틴 결과를 보고 있습니다.` : `"${title}" 루틴 결과를 표시했습니다.`, "info");
    };
    const rowLabel = active ? `선택된 루틴 결과: ${title}` : `루틴 결과 보기: ${title}`;

    row = el("div", {
      class: `routine-manage-row ${active ? "active" : ""} ${r.enabled ? "" : "paused"}`,
      role: "button",
      tabindex: "0",
      "aria-pressed": active ? "true" : "false",
      "aria-label": rowLabel,
      title: rowLabel,
      onclick: () => {
        if (row.getAttribute("aria-busy") === "true") return;
        selectResult();
      },
      onkeydown: (e) => {
        if (row.getAttribute("aria-busy") === "true") return;
        // Only act on keys aimed at the row itself, not its inner buttons.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectResult();
        }
      },
    }, [
      el("div", { class: "routine-manage-head" }, [
        dot,
        el("strong", { class: "routine-manage-title", text: routineTitle(r) }),
        toggle,
      ]),
      el("div", { class: "routine-manage-meta", text: meta.join(" · ") }),
      errored && r.lastError ? el("div", { class: "error-note", text: r.lastError }) : null,
      el("div", { class: "routine-manage-actions" }, [editBtn, runBtn]),
    ]);
    list.append(row);
  }
}

async function runRoutineNow(routine) {
  const res = await api(`/api/me/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" });
  let refreshError = null;
  try {
    await Promise.all([loadRoutines(), loadRoutineConversations(), loadNotifications()]);
    updateNotificationBadge();
  } catch (e) {
    refreshError = e;
  }
  if (res && res.ok === false) {
    notify(`루틴 실행 실패: ${res.error || "알 수 없는 오류"}`);
  } else if (refreshError) {
    notify(`루틴은 실행했지만 상태 새로고침에 실패했습니다: ${refreshError.message}`, "warn");
  } else {
    notify(`"${routineTitle(routine)}" 루틴을 실행했습니다.`, "ok");
  }
  // Jump straight to the result this run just produced.
  openRoutineResult(routine.conversationId);
}

async function runRoutineFromButton(routine, button, busyRoot = null) {
  if (!routine || !button) return;
  const saved = button.textContent;
  if (busyRoot) setFormBusy(busyRoot, true);
  else button.disabled = true;
  button.textContent = "실행 중…";
  try {
    await runRoutineNow(routine);
  } catch (err) {
    if (busyRoot) setFormBusy(busyRoot, false);
    else button.disabled = false;
    button.textContent = saved;
    notify(`루틴 실행 실패: ${err.message}`);
  }
}

function buildRoutineResultPanel(messageLoadError = "") {
  const conv = state.routineConversations.find((c) => c.id === state.routineConversationId);
  const routine = conv ? state.routines.find((r) => r.conversationId === conv.id) : null;
  const transcript = el("div", { class: "routine-result-transcript transcript scroll-thin" });
  const inner = el("div", { class: "transcript-inner" });
  transcript.append(inner);
  // Standing prompt block: the instruction this routine runs, always in view above
  // the results (own scroll so a long prompt can't crowd out the transcript).
  let promptBlock = null;
  if (routine) {
    const promptBody = el("div", { class: "routine-result-prompt-body md scroll-thin" });
    const promptText = (routine.prompt || "").trim();
    if (promptText) promptBody.innerHTML = renderMarkdown(promptText);
    else promptBody.append(el("span", { class: "muted", text: "(프롬프트 없음)" }));
    promptBlock = el("div", { class: "routine-result-prompt" }, [
      el("div", { class: "routine-result-prompt-label muted", text: "지시 프롬프트" }),
      promptBody,
    ]);
  }
  const card = el("section", { class: "settings-card routine-result-card" }, [
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: conv?.title || "루틴 결과" }),
        el("p", { class: "muted", text: conv ? `${conv.avatarDisplayName} · ${timeLabel(conv.updatedAt)}` : "루틴 실행 기록을 선택하세요." }),
      ]),
      conv ? el("button", { class: "ghost-sm", type: "button", text: "일반 대화로 열기", onclick: () => selectConversation(conv) }) : null,
    ]),
    promptBlock,
    transcript,
  ]);
  if (!conv) {
    const firstRoutine = state.routines[0];
    const runFirstBtn = firstRoutine
      ? el("button", {
          class: "linkish small",
          type: "button",
          text: "첫 루틴 지금 실행",
          onclick: (event) => runRoutineFromButton(firstRoutine, event.currentTarget, card),
        })
      : null;
    inner.append(
      state.routines.length
        ? el("div", { class: "empty-note" }, [
            "아직 확인할 실행 결과가 없습니다. 바로 실행하거나 다음 예약 실행 후 결과가 표시됩니다.\n",
            runFirstBtn,
          ])
        : el("div", { class: "empty-note" }, [
            "아직 확인할 루틴 결과가 없습니다.\n",
            el("button", { class: "linkish small", type: "button", text: "첫 루틴 추가", onclick: () => openRoutineModal(null) }),
          ]),
    );
    return card;
  }
  if (messageLoadError) {
    inner.append(
      el("div", { class: "warn-box" }, [
        `루틴 결과를 불러오지 못했습니다: ${messageLoadError} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return card;
  }
  if (!state.routineMessages.length) {
    inner.append(
      el("div", { class: "empty-note" }, [
        "아직 실행 메시지가 없습니다.\n",
        routine ? el("button", { class: "linkish small", type: "button", text: "지금 다시 실행", onclick: (event) => runRoutineFromButton(routine, event.currentTarget, card) }) : null,
      ]),
    );
    return card;
  }
  // A flat thread grows unreadable over many runs. Group it into per-run blocks
  // (one user-prompt → its assistant result(s)), newest FIRST and only the newest
  // expanded; the rest collapse to a one-line header you can open on demand.
  const runs = groupRoutineRuns(state.routineMessages);
  const currentPrompt = (routine?.prompt || "").trim();
  for (let i = runs.length - 1; i >= 0; i--) {
    inner.append(buildRoutineRunBlock(runs[i], i + 1, i === runs.length - 1, currentPrompt, routine));
  }
  return card;
}

// Split the alternating user/assistant transcript into runs: each user message
// starts a new run and the assistant message(s) that follow belong to it.
function groupRoutineRuns(messages) {
  const runs = [];
  let current = null;
  for (const m of messages) {
    if (m.role === "user") {
      current = { prompt: m, responses: [], at: m.createdAt || null };
      runs.push(current);
    } else {
      if (!current) {
        current = { prompt: null, responses: [], at: m.createdAt || null };
        runs.push(current);
      }
      current.responses.push(m);
      if (m.createdAt) current.at = m.createdAt;
    }
  }
  return runs;
}

function buildRoutineRunBlock(run, runNumber, expanded, currentPrompt, routine = null) {
  const time = run.at ? timeLabel(run.at) : "";
  const details = el("details", { class: "routine-run-block", ...(expanded ? { open: "" } : {}) });
  details.append(
    el("summary", { class: "routine-run-summary" }, [
      el("span", { class: "routine-run-chevron", "aria-hidden": "true" }),
      el("span", { class: "routine-run-num", text: `실행 #${runNumber}` }),
      time ? el("span", { class: "routine-run-time muted", text: time }) : null,
    ]),
  );
  const body = el("div", { class: "routine-run-body" });
  // If this run's prompt differs from the routine's current one (it was edited
  // since), surface that run's actual instruction; otherwise the pinned block covers it.
  const runPrompt = (run.prompt?.content || "").trim();
  if (runPrompt && runPrompt !== currentPrompt) {
    const note = el("div", { class: "routine-run-prompt md" });
    note.innerHTML = renderMarkdown(runPrompt);
    body.append(el("div", { class: "routine-run-prompt-label muted", text: "이때의 지시" }), note);
  }
  if (run.responses.length) {
    for (const m of run.responses) body.append(buildRoutineMessageNode(m));
  } else {
    body.append(
      el("div", { class: "empty-note" }, [
        "이 실행에는 결과 메시지가 없습니다.\n",
        routine ? el("button", { class: "linkish small", type: "button", text: "현재 루틴 다시 실행", onclick: (event) => runRoutineFromButton(routine, event.currentTarget, details) }) : null,
      ]),
    );
  }
  details.append(body);
  return details;
}

function buildRoutineMessageNode(message) {
  const isUser = message.role === "user";
  const wrap = el("div", { class: `message ${message.role}` });
  wrap.append(
    el("div", { class: "msg-role" }, [
      el("span", { class: "role-dot" }),
      el("span", { text: isUser ? "루틴 지시" : state.user?.displayName || "아바타" }),
      message.createdAt ? el("time", { class: "msg-time", datetime: message.createdAt, text: timeLabel(message.createdAt) }) : null,
    ]),
  );
  const bubble = el("div", { class: "bubble" });
  if (isUser) bubble.textContent = message.content;
  else renderAssistantInto(bubble, message);
  wrap.append(bubble);
  return wrap;
}

export function openRoutineResult(conversationId) {
  state.routineConversationId = conversationId || "";
  state.view = "routines";
  syncHash();
  renderView();
}
