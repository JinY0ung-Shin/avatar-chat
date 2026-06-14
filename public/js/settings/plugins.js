// Auto-split from settings.js — submodule: plugins. Behavior-preserving relocation only.
import { invalidateSkillsCache } from "../chat.js";
import { api, el, icon, notify, setFormBusy, state, timeLabel, wireExpander } from "../core.js";
import { loadPlugins } from "../loaders.js";
import { buildToggle } from "../shell.js";

export function buildPluginsCard() {
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

export function pluginSyncLabel(p) {
  if (!p.lastSyncedAt) return "아직 동기화되지 않음";
  const d = new Date(p.lastSyncedAt);
  if (Number.isNaN(d.getTime())) return "";
  return `동기화: ${timeLabel(p.lastSyncedAt)}`;
}

export function renderPluginRows(list, focusAddForm = null) {
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
export function renderPluginSelectionContents(container, info, { getSelected, onSave, headText }) {
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
export function renderPluginContents(container, list, p, info) {
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
