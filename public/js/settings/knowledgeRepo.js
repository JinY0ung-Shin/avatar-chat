// Auto-split from settings.js — submodule: knowledgeRepo. Behavior-preserving relocation only.
import { chatAboutTopic, invalidateSkillsCache } from "../chat.js";
import { api, el, icon, notify, setFormBusy, state, wireExpander } from "../core.js";
import { openOnboarding } from "../lifecycle.js";
import { renderView, syncHash } from "../nav.js";
import { renderPluginSelectionContents } from "./plugins.js";

// Convert an `owner/repo` or git/https URL into a browsable https GitHub link,
// or null if we can't (e.g. ssh `git@` remote). Strips a trailing `.git`.
export function repoToHref(repo) {
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
export function buildKnowledgeRepoCard() {
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
export function renderKnowledgeRepoContents(container, info) {
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
