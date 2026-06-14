// Auto-split from app.js — module: explore. Behavior-preserving relocation only.
import { avatarNode } from "./avatar-image.js";
import { activePane, guardChatReplacement, makeChatPane, refreshConversations, selectConversation, setActivePane, streamingPane, syncLegacyChatState } from "./chat.js";
import { dom, el, icon, notify, state } from "./core.js";
import { openOnboarding } from "./lifecycle.js";
import { loadAvatars } from "./loaders.js";
import { goView, renderView, syncHash } from "./nav.js";
import { viewHeader } from "./shell.js";


/* ============================================================ Explore view */
// First-run pointer shown when the user skipped onboarding and never connected
// anything — the onboarding modal itself is otherwise buried 3 levels deep.
function buildSetupBanner() {
  const u = state.user;
  if (!u || u.gitTokenSet || u.knowledgeRepo) return null;
  try {
    if (sessionStorage.getItem("setupBannerDismissed") === "1") return null;
  } catch {
    /* storage unavailable — just show it */
  }
  const banner = el("div", { class: "setup-banner" }, [
    el("div", { class: "sb-copy" }, [
      el("strong", { text: "지식 저장소를 연결하면 대화가 누적됩니다" }),
      el("span", { text: "아바타가 배운 내용과 스킬을 파일로 정리해 다음 대화에서 다시 사용할 수 있어요." }),
    ]),
    el("div", { class: "sb-actions" }, [
      el("button", { class: "primary small", type: "button", text: "설정하기", onclick: () => openOnboarding() }),
      el("button", {
        class: "linkish small",
        type: "button",
        text: "닫기",
        onclick: () => {
          try {
            sessionStorage.setItem("setupBannerDismissed", "1");
          } catch {
            /* ignore */
          }
          banner.remove();
        },
      }),
    ]),
  ]);
  return banner;
}

const MAX_HASHTAGS = 12;

// Normalize a list of capability hashtags client-side (mirrors the server's
// normalizeHashtags): strip leading "#"/markers, collapse spaces to hyphens,
// dedupe, cap. Bare tags (no "#") are stored; the UI renders the "#".
function normalizeTagList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of [].concat(list || [])) {
    if (typeof raw !== "string") continue;
    let t = raw.trim().replace(/^[#*•·\-\s]+/, "").replace(/\s+/g, "-").replace(/[.,!?]+$/, "").trim();
    if (!t) continue;
    if (t.length > 30) t = t.slice(0, 30);
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

// A chip editor for capability hashtags: type + Enter/comma/space to add, click
// × or Backspace-on-empty to remove. Returns the wrapper plus get/set helpers.
export function buildHashtagEditor(initial) {
  let tags = normalizeTagList(initial || []);
  const chips = el("div", { class: "tag-chips" });
  const input = el("input", {
    class: "tag-input",
    type: "text",
    placeholder: "태그 입력 후 Enter",
    "aria-label": "역량 해시태그 추가",
  });
  function renderChips() {
    chips.replaceChildren(
      ...tags.map((t, i) =>
        el("span", { class: "tag accent hashtag-chip" }, [
          el("span", { text: `#${t}` }),
          el("button", {
            type: "button",
            class: "chip-x",
            "aria-label": `${t} 제거`,
            text: "×",
            onclick: () => {
              tags.splice(i, 1);
              renderChips();
            },
          }),
        ]),
      ),
    );
  }
  function addFromInput() {
    const parts = input.value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const truncated = parts.some((p) => p.replace(/^[#*•·\-\s]+/, "").length > 30);
    tags = normalizeTagList([...tags, ...parts]);
    input.value = "";
    renderChips();
    if (truncated) notify("해시태그는 최대 30자까지만 사용할 수 있어 일부가 잘렸습니다.", "info");
  }
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addFromInput();
    } else if (e.key === " " && input.value.trim()) {
      e.preventDefault();
      addFromInput();
    } else if (e.key === "Backspace" && !input.value && tags.length) {
      tags.pop();
      renderChips();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) addFromInput();
  });
  const wrap = el("div", { class: "hashtag-editor" }, [chips, input]);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target === chips) input.focus();
  });
  renderChips();
  return {
    wrap,
    getTags: () => tags.slice(),
    setTags: (next) => {
      tags = normalizeTagList(next);
      renderChips();
    },
  };
}

// Explore directory search. renderExploreGridImpl is (re)assigned each time the
// Explore view renders; renderExploreGrid is a stable wrapper so the search box
// can call it safely even before the impl exists (e.g. typing while loading).
let renderExploreGridImpl = null;
let exploreViewSeq = 0;
function renderExploreGrid() {
  if (typeof renderExploreGridImpl === "function") renderExploreGridImpl();
}
function matchesAvatarQuery(av, tokens) {
  const hay = [av.displayName, av.alias, av.username, av.bio, ...(av.hashtags || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export async function renderExplore() {
  const renderSeq = ++exploreViewSeq;
  renderExploreGridImpl = null;
  const header = viewHeader("탐색", "공개된 아바타와 대화를 시작하세요");
  const searchInput = el("input", {
    class: "explore-search",
    type: "search",
    placeholder: "이름·해시태그로 검색 (예: #코드리뷰)",
    value: state.exploreQuery || "",
    "aria-label": "아바타 검색",
    oninput: (e) => {
      state.exploreQuery = e.target.value;
      renderExploreGrid();
    },
  });
  const searchBar = el("div", { class: "explore-search-bar" }, [icon("compass"), searchInput]);
  const grid = el("div", { class: "avatar-grid" });
  const body = el("div", { class: "view-body scroll-thin" }, [searchBar, grid]);
  dom.main.append(header, body);
  const isCurrent = () => renderSeq === exploreViewSeq && state.view === "explore" && body.isConnected;
  const clearExploreSearch = () => {
    state.exploreQuery = "";
    searchInput.value = "";
    renderExploreGrid();
    searchInput.focus();
  };

  grid.append(el("div", { class: "muted pad", text: "불러오는 중…" }));
  let loadError = null;
  try {
    await loadAvatars();
  } catch (e) {
    loadError = e;
  }
  if (!isCurrent()) return;
  grid.replaceChildren();
  if (loadError) {
    // A failed fetch must not masquerade as "no avatars exist".
    searchBar.remove();
    grid.append(
      el("div", { class: "warn-box" }, [
        `아바타 목록을 불러오지 못했습니다: ${loadError.message} `,
        el("button", { class: "linkish", type: "button", text: "다시 시도", onclick: () => renderView() }),
      ]),
    );
    return;
  }
  const banner = buildSetupBanner();
  if (banner) body.prepend(banner);
  if (!state.avatars.length) {
    searchBar.remove();
    grid.append(
      el("div", { class: "empty-note" }, [
        "공개된 아바타가 아직 없습니다.\n",
        el("button", {
          class: "linkish small",
          type: "button",
          text: "내 아바타 공개 설정",
          onclick: () => {
            state.settingsTab = "profile";
            goView("settings");
          },
        }),
      ]),
    );
    return;
  }
  // Filter by the search query + (re)build cards. Reused on every keystroke.
  renderExploreGridImpl = () => {
    if (!isCurrent()) return;
    const raw = (state.exploreQuery || "").trim();
    const tokens = raw ? raw.toLowerCase().split(/\s+/).map((t) => t.replace(/^#+/, "")).filter(Boolean) : [];
    // Order: my own avatar first, then group teammates (auto-trusted), then the
    // rest. Within a tier the server's display-name order is preserved.
    const rank = (av) => (av.id === state.user.id ? 0 : av.sharesGroup ? 1 : 2);
    const sorted = [...state.avatars].sort(
      (a, b) => rank(a) - rank(b) || (a.displayName || "").localeCompare(b.displayName || ""),
    );
    const list = tokens.length ? sorted.filter((av) => matchesAvatarQuery(av, tokens)) : sorted;
    grid.replaceChildren();
    if (!list.length) {
      grid.append(
        el("div", { class: "empty-note" }, [
          `"${raw}"에 맞는 아바타가 없습니다.\n`,
          el("button", { class: "linkish small", type: "button", text: "검색어 지우기", onclick: clearExploreSearch }),
        ]),
      );
      return;
    }
    for (const av of list) grid.append(buildAvatarCard(av));
  };
  renderExploreGrid();
}

function buildAvatarCard(av) {
  const isMe = av.id === state.user.id;
  const cardLabel = `${av.alias || av.displayName} 아바타와 대화`;
  const card = el("button", {
    class: "avatar-card",
    type: "button",
    "aria-label": cardLabel,
    title: cardLabel,
    onclick: () => startChatWith(av, card),
  }, [
    avatarNode(av, 56, { alt: "" }),
    el("div", { class: "ac-body" }, [
      el("div", { class: "ac-name" }, [
        el("strong", { text: av.displayName }),
        isMe ? el("span", { class: "tag accent", text: "나" }) : null,
        !isMe && av.sharesGroup ? el("span", { class: "tag write", text: "같은 그룹" }) : null,
        av.visibility === "group" ? el("span", { class: "tag", text: "그룹 공개" }) : null,
        av.visibility === "private" ? el("span", { class: "tag", text: "비공개" }) : null,
      ]),
      el("div", { class: "ac-handle", text: `@${av.username}` }),
      av.alias ? el("div", { class: "ac-alias", text: `"${av.alias}"` }) : null,
      av.bio ? el("p", { class: "ac-bio", text: av.bio }) : null,
      el("div", { class: "ac-tags" }, [
        ...(av.hashtags || []).slice(0, 6).map((t) => el("span", { class: "tag accent", text: `#${t}` })),
        el("span", { class: "tag", text: `플러그인 ${av.pluginCount}개` }),
      ]),
    ]),
  ]);
  return card;
}

export async function startChatWith(av, triggerCard = null) {
  const activeStreaming = streamingPane();
  if (activeStreaming) {
    if (activeStreaming.avatar?.id === av.id) {
      setActivePane(activeStreaming);
      state.view = "chat";
      syncHash();
      renderView();
      return;
    }
    if (!guardChatReplacement()) return;
  }
  const handle = triggerCard?.querySelector(".ac-handle");
  const previousHandle = handle?.textContent || "";
  if (triggerCard) {
    triggerCard.disabled = true;
    triggerCard.setAttribute("aria-busy", "true");
    if (handle) handle.textContent = "대화 여는 중…";
  }
  const restoreTrigger = () => {
    if (!triggerCard?.isConnected) return;
    triggerCard.disabled = false;
    triggerCard.removeAttribute("aria-busy");
    if (handle) handle.textContent = previousHandle;
  };
  // Resume the most recent conversation with this avatar instead of silently
  // forking a new one — Explore and the rail used to diverge here, spawning
  // duplicate threads. "새 대화" in the chat header remains the fork path.
  const existing = state.conversations.find((c) => c.avatarUserId === av.id);
  try {
    if (existing && state.chatPanes.length <= 1) {
      await selectConversation(existing);
      if (state.view === "chat" && activePane()?.conversationId === existing.id) {
        notify(`"${existing.title || av.displayName || "기존 대화"}" 대화를 이어서 열었습니다.`, "info");
      }
      return;
    }
    state.currentAvatar = av;
    const pane = makeChatPane(av);
    state.chatPanes = [pane];
    state.activePaneId = pane.id;
    syncLegacyChatState(pane);
    state.view = "chat";
    syncHash();
    renderView();
    await refreshConversations();
  } catch (e) {
    notify(`대화를 시작하지 못했습니다: ${e.message}`);
  } finally {
    restoreTrigger();
  }
}
