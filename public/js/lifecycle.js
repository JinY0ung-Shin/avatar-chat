// Auto-split from app.js — module: lifecycle. Behavior-preserving relocation only.
import { buildRevealableInput, renderAuth } from "./auth.js";
import { refreshConversations, selectConversation, stopAllChatStreams } from "./chat.js";
import { api, app, el, isSessionExpired, setFormBusy, setSessionExpired, setSessionExpiredHandler, state } from "./core.js";
import { refreshKnowledgeStatus, refreshNotificationStatus, startKnowledgeWatch, stopKnowledgeWatch } from "./loaders.js";
import { renderView, routeFromHash, syncHash } from "./nav.js";
import { buildSshPublicKeyField, hasSecret } from "./settings.js";
import { closeRail, hidePromptModal, mountShell, openModal } from "./shell.js";


/* ============================================================ Lifecycle */
export async function logout(triggerBtn = null) {
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.title = "로그아웃 중…";
    triggerBtn.setAttribute("aria-label", "로그아웃 중");
  }
  stopAllChatStreams();
  stopKnowledgeWatch();
  hidePromptModal();
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  setSessionExpired(false);
  state.user = null;
  state.currentAvatar = null;
  state.chatPanes = [];
  state.activePaneId = null;
  state.messages = [];
  state.conversations = [];
  state.routineConversations = [];
  state.routineConversationId = "";
  state.routineMessages = [];
  state.notifications = [];
  renderAuth("login");
}

// Session-expiry teardown. Registered into core (setSessionExpiredHandler) so core's
// api()/SSE 401 paths can trigger it without core importing feature modules. Moved
// here out of core.js to keep that module a leaf (no feature-module imports).
export function handleSessionExpired() {
  if (isSessionExpired()) return;
  setSessionExpired(true);
  stopAllChatStreams();
  stopKnowledgeWatch();
  hidePromptModal();
  state.user = null;
  state.currentAvatar = null;
  state.chatPanes = [];
  state.activePaneId = null;
  state.messages = [];
  state.conversations = [];
  state.routineConversations = [];
  state.routineConversationId = "";
  state.routineMessages = [];
  state.notifications = [];
  state.authError = "세션이 만료되었습니다. 다시 로그인해 주세요.";
  renderAuth();
}
setSessionExpiredHandler(handleSessionExpired);

export async function enterApp() {
  mountShell();
  // Restore the view (and conversation) from the URL hash so a reload doesn't
  // dump the user back on Explore.
  const { view, arg } = routeFromHash();
  const isAdmin = state.user.roles?.includes("admin");
  state.view = view && !(view === "admin" && !isAdmin) ? view : "explore";
  if (view === "settings" && arg) state.settingsTab = arg;
  if (view === "routines" && arg) state.routineConversationId = arg;
  if (view === "admin" && arg) state.adminTab = arg;
  const wantConversation = view === "chat" && arg ? arg : null;
  if (wantConversation) state.view = "explore"; // placeholder frame until messages load
  renderView();
  syncHash(true);
  refreshKnowledgeStatus({ announce: true });
  startKnowledgeWatch();
  refreshNotificationStatus({ announce: true });
  await refreshConversations();
  if (wantConversation) {
    const conv = state.conversations.find((c) => c.id === wantConversation);
    if (conv) await selectConversation(conv);
    else syncHash(true);
  }
  // First-time guidance: explain the app and optionally collect the internal Git token. Skippable,
  // tracked per-user in localStorage so it doesn't reappear once dismissed.
  if (!onboardingDone(state.user.id)) {
    openOnboarding();
  }
}

/** localStorage key flagging that a user has seen/dismissed onboarding. */
function onboardingKey(userId) {
  return `onboarded:${userId}`;
}
function onboardingDone(userId) {
  try {
    return localStorage.getItem(onboardingKey(userId)) === "1";
  } catch {
    return false; // storage blocked → just show it; harmless
  }
}
function markOnboardingDone(userId) {
  try {
    localStorage.setItem(onboardingKey(userId), "1");
  } catch {
    /* ignore */
  }
}

const ONBOARDING_FEATURES = [
  {
    title: "아바타 찾기",
    desc: "탐색에서 공개 아바타를 검색하고 바로 대화를 시작합니다.",
  },
  {
    title: "내 아바타 키우기",
    desc: "프로필, 페르소나, 자기소개, 역량 태그를 설정해 업무 맥락을 드러냅니다.",
  },
  {
    title: "지식 저장소 연결",
    desc: "반복 업무와 프로젝트 규칙을 저장소와 스킬로 쌓아 다음 대화에 재사용합니다.",
  },
  {
    title: "동료에게 요청",
    desc: "동료가 공개한 지식과 스킬을 바탕으로 조사, 검토, 정리를 요청합니다.",
  },
  {
    title: "루틴 자동 실행",
    desc: "매일·매주 반복되는 확인 작업을 예약하고 결과를 대화에 쌓습니다.",
  },
  {
    title: "도구 확장",
    desc: "Git 토큰, 플러그인, SSH, Confluence 연결로 작업 범위를 넓힙니다.",
  },
];

const ONBOARDING_EXAMPLES = [
  "내가 자주 맡기는 배포 점검 절차를 스킬로 정리하고 다음부터 그대로 수행해줘.",
  "민수님의 아바타에게 이번 장애 원인과 재발 방지 체크리스트를 물어봐.",
  "내 지식 저장소에 이 프로젝트 운영 절차를 스킬로 정리해줘.",
  "접근 가능한 서버에 SSH로 접속해서 서비스 로그와 디스크 사용량을 점검해줘.",
];

function buildOnboardingGuide() {
  return el("div", { class: "onboard-guide" }, [
    el("section", { class: "onboard-section" }, [
      el("h3", { text: "이 앱에서 할 수 있는 일" }),
      el("div", { class: "onboard-feature-list" },
        ONBOARDING_FEATURES.map((item) =>
          el("div", { class: "onboard-feature" }, [
            el("strong", { text: item.title }),
            el("p", { text: item.desc }),
          ]),
        ),
      ),
    ]),
    el("section", { class: "onboard-section" }, [
      el("h3", { text: "처음 대화할 때 이렇게 시켜볼 수 있어요" }),
      el("ul", { class: "onboard-examples" }, ONBOARDING_EXAMPLES.map((text) => el("li", { text }))),
    ]),
    el("p", {
      class: "onboard-note",
      text: "권한은 대화 상대에 따라 달라집니다. 내 아바타와 신뢰한 사용자는 작업 도구를 쓸 수 있고, 일반 사용자가 다른 아바타와 대화할 때는 읽기 전용으로 실행됩니다.",
    }),
  ]);
}

/**
 * Skippable onboarding overlay: explains the main workflows and optionally stores
 * an internal Git token. Knowledge repo/branch setup stays in chat or settings so first
 * login does not feel like a repository configuration wizard.
 */
export function openOnboarding() {
  const gitTokenField = buildRevealableInput({
    name: "token",
    placeholder: "사내 GitHub PAT (GIT_TOKEN)",
    autocomplete: "off",
    ariaLabel: "사내 Git 토큰 GIT_TOKEN",
    revealLabel: "토큰",
  });
  const tokenInput = gitTokenField.input;
  const confluenceField = buildRevealableInput({
    name: "confluence",
    placeholder: "Confluence PAT (CONFLUENCE_PAT)",
    autocomplete: "off",
    ariaLabel: "Confluence Personal Access Token CONFLUENCE_PAT",
    revealLabel: "토큰",
  });
  const confluenceInput = confluenceField.input;
  const errorBox = el("div", { class: "error", role: "alert", hidden: "" });
  const sshStatus = el("div", { class: "git-token-status muted" });
  const sshPublicKeyBox = el("div", { class: "ssh-public-key-box" });
  const generateSshBtn = el("button", {
    class: "primary",
    type: "button",
    text: "SSH 키 생성",
    onclick: async () => {
      generateSshBtn.disabled = true;
      const savedLabel = generateSshBtn.textContent;
      generateSshBtn.textContent = "생성 중…";
      errorBox.hidden = true;
      try {
        const { user } = await api("/api/me/ssh-key", { method: "POST" });
        state.user = user;
        renderSshSetup();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        generateSshBtn.textContent = savedLabel;
        generateSshBtn.disabled = false;
      }
    },
  });
  function renderSshSetup() {
    const publicKey = (state.user.sshPublicKey || "").trim();
    if (publicKey) {
      sshStatus.replaceChildren(el("span", { class: "token-set", text: "● SSH_PRIVATE_KEY 생성됨" }));
      sshPublicKeyBox.hidden = false;
      sshPublicKeyBox.replaceChildren(buildSshPublicKeyField(publicKey));
      generateSshBtn.textContent = "SSH 키 생성됨";
      generateSshBtn.disabled = true;
      return;
    }
    if (hasSecret("SSH_PRIVATE_KEY")) {
      sshStatus.replaceChildren(el("span", { class: "token-set", text: "● SSH_PRIVATE_KEY 설정됨" }));
      sshPublicKeyBox.hidden = true;
      sshPublicKeyBox.replaceChildren();
      generateSshBtn.textContent = "SSH 키 설정됨";
      generateSshBtn.disabled = true;
      return;
    }
    sshStatus.replaceChildren(el("span", { text: "SSH_PRIVATE_KEY 미설정" }));
    sshPublicKeyBox.hidden = true;
    sshPublicKeyBox.replaceChildren();
    generateSshBtn.textContent = "SSH 키 생성";
    generateSshBtn.disabled = false;
  }
  renderSshSetup();

  const saveBtn = el("button", { class: "primary", type: "submit", text: "시작하기" });
  const skipBtn = el("button", { class: "linkish", type: "button", text: "건너뛰기" });
  const updateSaveButtonLabel = () => {
    const hasToken = Boolean(tokenInput.value.trim());
    const hasConfluencePat = state.confluenceConfigured && Boolean(confluenceInput.value.trim());
    saveBtn.textContent = hasToken || hasConfluencePat ? "저장하고 시작" : "시작하기";
  };
  tokenInput.addEventListener("input", updateSaveButtonLabel);
  confluenceInput.addEventListener("input", updateSaveButtonLabel);
  updateSaveButtonLabel();

  const setupItem = (title, summary, children) =>
    el("details", { class: "onboard-setup-item" }, [
      el("summary", {}, [
        el("strong", { text: title }),
        el("span", { text: summary }),
      ]),
      el("div", { class: "onboard-setup-body" }, children),
    ]);

  openModal({
    cardClass: "onboard-card",
    ariaLabelledby: "onboarding-title",
    onBeforeClose: () => markOnboardingDone(state.user.id),
    buildCard: (card, close) => {
      const form = el("form", {
        class: "form-stack",
        onsubmit: async (e) => {
          e.preventDefault();
          const formEl = e.currentTarget;
          const savedLabel = saveBtn.textContent;
          const token = tokenInput.value.trim();
          const confluencePat = confluenceInput.value.trim();
          const willSave = Boolean(token || confluencePat);
          setFormBusy(formEl, true);
          saveBtn.textContent = willSave ? "저장 중…" : "시작 중…";
          errorBox.hidden = true;
          try {
            if (token) {
              const { user } = await api("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
              state.user = user;
            }
            if (confluencePat) {
              const { user } = await api("/api/me/secrets/CONFLUENCE_PAT", {
                method: "PUT",
                body: JSON.stringify({ value: confluencePat }),
              });
              state.user = user;
            }
            close();
            renderView();
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.hidden = false;
            saveBtn.textContent = savedLabel;
            setFormBusy(formEl, false);
            renderSshSetup();
          }
        },
      }, [
        el("div", { class: "onboard-setup-list" }, [
          setupItem("Git 토큰", "비공개 저장소 읽기와 지식 저장소 커밋·푸시에 사용합니다.", [
            el("label", { class: "field" }, [
              el("span", {}, [
                "사내 Git 토큰 (GIT_TOKEN, 선택) ",
                el("a", {
                  class: "linkish",
                  href: `https://${(state.githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/, "")}/settings/tokens`,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  text: "토큰 만들러 가기 ↗",
                }),
              ]),
              gitTokenField.wrap,
            ]),
          ]),
          setupItem("SSH 키", "서버 로그 확인, 파일 점검, 원격 명령 같은 작업에 사용합니다.", [
            el("p", {
              class: "muted",
              text: "개인키는 암호화되어 저장되고 도구 실행 시에만 주입됩니다. 공개키만 접속 대상 서버에 등록하면 됩니다.",
            }),
            sshStatus,
            el("div", { class: "git-token-actions" }, [generateSshBtn]),
            sshPublicKeyBox,
          ]),
          state.confluenceConfigured
            ? setupItem("Confluence 연결", "문서를 검색·조회하고 페이지 작성·수정 작업을 맡길 수 있습니다.", [
                el("label", { class: "field" }, [
                  el("span", { text: "Confluence PAT (CONFLUENCE_PAT, 선택)" }),
                  confluenceField.wrap,
                ]),
              ])
            : null,
        ]),
        errorBox,
        el("div", { class: "onboard-actions" }, [
          skipBtn,
          saveBtn,
        ]),
      ]);
      skipBtn.onclick = () => close();

      card.append(
        el("img", { class: "login-mark", src: "/icon-192.png", alt: "", "aria-hidden": "true", width: "48", height: "48" }),
        el("h2", { id: "onboarding-title", text: "아바타 사용 준비하기" }),
        el("p", {
          class: "muted",
          text: "업무 방식과 반복 절차를 아바타에 쌓고, 동료 아바타에게도 질문·요청할 수 있습니다.",
        }),
        buildOnboardingGuide(),
        el("div", { class: "onboard-connect" }, [
          el("h3", { text: "선택 설정" }),
          el("p", {
            class: "muted",
            text: "지금 건너뛰어도 됩니다. 필요한 연결은 내 아바타 설정에서 언제든 다시 추가할 수 있습니다.",
          }),
        ]),
        form,
      );
      // Keep the opening focus on the guide itself; jumping straight to the
      // token field skips the explanation and can scroll the modal past it.
      return { focusTarget: card };
    },
  });
}

export async function boot() {
  app.replaceChildren(
    el("div", { class: "boot" }, [
      el("img", { class: "boot-mark", src: "/icon-192.png", alt: "", "aria-hidden": "true", width: "52", height: "52" }),
      el("div", { class: "boot-spinner" }),
      el("div", { class: "boot-label", text: "불러오는 중…" }),
    ]),
  );
  let me = null;
  let bootstrap = null;
  try {
    bootstrap = await api("/api/bootstrap");
    state.githubHost = bootstrap.githubHost || state.githubHost;
    state.signupMode = bootstrap.signupMode || state.signupMode;
    state.confluenceConfigured = Boolean(bootstrap.confluenceConfigured);
  } catch {
    bootstrap = null;
  }
  try {
    me = await api("/api/me");
  } catch {
    me = null;
  }
  state.user = me?.user || null;
  if (!state.user) {
    // On a fresh install (no accounts yet) show the admin-setup screen.
    const needsSetup = Boolean(bootstrap?.needsSetup);
    renderAuth(needsSetup ? "setup" : "login");
    return;
  }
  await enterApp();
}

if (window.matchMedia) {
  const mq = window.matchMedia("(min-width: 861px)");
  const onChange = () => {
    if (mq.matches) closeRail();
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange);
}
