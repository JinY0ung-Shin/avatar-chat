import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";

marked.setOptions({ gfm: true, breaks: true });

// Open links in new tab safely.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const app = document.querySelector("#app");

function newId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

const state = {
  user: null,
  bootstrap: null,
  skills: null,
  marketplace: null,
  audit: [],
  invites: [],
  messages: [],
  mode: "colleague",
  conversationId: newId(),
  error: "",
  streaming: false,
};

// Live references into the rendered shell (set by mountWorkspace).
const dom = {};
let abortController = null;

/* ============================================================
   Networking
   ============================================================ */
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

/* ============================================================
   Helpers
   ============================================================ */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name) {
  const paths = {
    gear:
      '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  };
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths[name] || "";
  return svg;
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ""));
}

function timeLabel(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

const modeCopy = {
  owner: {
    title: "업무 지시 모드",
    sub: "소유자 지시를 marketplace skill로 처리하고 결과를 보고합니다.",
    railSub: "작업 명령 실행",
  },
  colleague: {
    title: "동료 조회 모드",
    sub: "초대된 프로젝트 범위 안에서 읽기 전용 상태 확인만 처리합니다.",
    railSub: "읽기 전용 조회",
  },
};

/* ============================================================
   Login view (separate render path)
   ============================================================ */
function renderLogin() {
  abortController?.abort();
  abortController = null;
  state.streaming = false;
  app.replaceChildren(
    el("section", { class: "login-view" }, [
      el("div", { class: "login-panel" }, [
        el("div", { class: "login-mark", text: "A" }),
        el("h1", { text: "Avatar Chat" }),
        el("p", { text: "사내 프로젝트 팀을 위한 초대 기반 업무 채팅입니다." }),
        state.error ? el("div", { class: "error", text: state.error }) : null,
        el(
          "form",
          {
            class: "form-stack",
            id: "login-form",
            onsubmit: async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              try {
                const result = await api("/api/session", {
                  method: "POST",
                  body: JSON.stringify({ name: form.get("name"), code: form.get("code") }),
                });
                state.user = result.user;
                state.mode = state.user.role === "owner" ? "owner" : "colleague";
                state.error = "";
                await hydrate();
              } catch (error) {
                state.error = error.message;
                renderLogin();
              }
            },
          },
          [
            el("label", { class: "field" }, [
              el("span", { text: "이름" }),
              el("input", { name: "name", autocomplete: "name", placeholder: "홍길동", required: "" }),
            ]),
            el("label", { class: "field" }, [
              el("span", { text: "초대 코드" }),
              el("input", {
                name: "code",
                autocomplete: "one-time-code",
                placeholder: "초대 코드 입력",
                required: "",
              }),
            ]),
            el("button", { class: "primary", type: "submit", text: "접속" }),
          ],
        ),
        el("div", {
          class: "hint",
          text: "초대 코드는 앱 소유자가 발급합니다. 초기 소유자 설정 코드는 배포 환경 변수에서 관리합니다.",
        }),
      ]),
    ]),
  );
  app.querySelector('input[name="name"]')?.focus();
}

/* ============================================================
   Workspace shell — built ONCE, updated surgically
   ============================================================ */
function mountWorkspace() {
  const owner = state.user?.role === "owner";
  const initial = (state.user?.name || "?").trim().charAt(0).toUpperCase();

  // --- Left rail ---
  const modeButton = (mode) =>
    el(
      "button",
      {
        class: `rail-mode ${state.mode === mode ? "active" : ""}`,
        type: "button",
        disabled: mode === "owner" && !owner ? "" : null,
        dataset: { mode },
        "aria-pressed": state.mode === mode ? "true" : "false",
        onclick: () => switchMode(mode),
      },
      [
        el("span", { class: "dot" }),
        el("span", {}, [
          el("span", { text: mode === "owner" ? "업무 지시" : "동료 조회" }),
          el("small", { text: modeCopy[mode].railSub }),
        ]),
      ],
    );

  dom.railModes = el("div", { class: "rail-modes" }, [modeButton("colleague"), modeButton("owner")]);

  const gearBtn = el("button", {
    class: "icon-button",
    type: "button",
    "aria-label": "설정 열기",
    title: "설정",
    onclick: () => openDrawer(),
  });
  gearBtn.append(icon("gear"));

  const rail = el("aside", { class: "rail" }, [
    el("div", { class: "rail-brand" }, [
      el("div", { class: "mark", text: "A" }),
      el("div", {}, [
        el("div", { class: "name", text: "Avatar Chat" }),
        el("div", { class: "sub", text: "marketplace workspace" }),
      ]),
    ]),
    el("div", {}, [el("div", { class: "rail-section-label", text: "모드" }), dom.railModes]),
    el("div", { class: "rail-spacer" }),
    el("div", { class: "rail-footer" }, [
      el("div", { class: "rail-user" }, [
        el("div", { class: "avatar", text: initial }),
        el("div", { class: "meta" }, [
          el("b", { text: state.user.name }),
          el("span", { text: owner ? "소유자" : "동료" }),
        ]),
      ]),
      el("div", { class: "rail-actions" }, [
        el("button", {
          class: "rail-logout",
          type: "button",
          text: "나가기",
          onclick: logout,
        }),
        gearBtn,
      ]),
    ]),
  ]);

  // --- Chat header ---
  dom.headerTitle = el("h2");
  dom.headerSub = el("p");
  dom.marketBadge = el("button", {
    class: "market-badge",
    type: "button",
    "aria-label": "마켓플레이스 설정 열기",
    onclick: () => openDrawer("market"),
  });

  dom.mobileMode = el("div", { class: "mobile-mode", role: "group", "aria-label": "모드 전환" }, [
    el("button", {
      type: "button",
      dataset: { mode: "colleague" },
      text: "동료",
      onclick: () => switchMode("colleague"),
    }),
    el("button", {
      type: "button",
      dataset: { mode: "owner" },
      text: "업무",
      disabled: owner ? null : "",
      onclick: () => switchMode("owner"),
    }),
  ]);

  const header = el("header", { class: "chat-header" }, [
    el("div", { class: "title" }, [dom.headerTitle, dom.headerSub]),
    el("div", { class: "header-badges" }, [dom.mobileMode, dom.marketBadge]),
  ]);

  // --- Transcript ---
  dom.transcriptInner = el("div", { class: "transcript-inner" });
  dom.transcript = el("div", {
    class: "transcript scroll-thin",
    role: "log",
    "aria-live": "polite",
    // Only announce newly added nodes, not every token mutation — combined with
    // the aria-busy toggle during streaming this keeps screen readers from
    // re-reading the half-built answer on every frame.
    "aria-relevant": "additions",
  });
  dom.transcript.append(dom.transcriptInner);

  // --- Composer ---
  dom.textarea = el("textarea", {
    name: "message",
    rows: "1",
    placeholder: "메시지를 입력하세요…  (Enter 전송 · Shift+Enter 줄바꿈)",
    "aria-label": "메시지 입력",
  });
  dom.sendButton = el("button", {
    class: "send-button",
    type: "submit",
    "aria-label": "보내기",
    title: "보내기",
  });
  dom.sendButton.append(icon("send"));

  dom.composerBox = el("div", { class: "composer-box" }, [dom.textarea, dom.sendButton]);

  const composerForm = el(
    "form",
    {
      class: "composer-form",
      onsubmit: (event) => {
        event.preventDefault();
        if (state.streaming) {
          stopStreaming();
        } else {
          submitMessage();
        }
      },
    },
    [
      dom.composerBox,
      el("div", { class: "composer-hint" }, [
        el("span", {}, [
          document.createTextNode("Enter 전송 · "),
          el("kbd", { text: "Shift+Enter" }),
          document.createTextNode(" 줄바꿈"),
        ]),
        el("span", { id: "composer-state", text: "" }),
      ]),
    ],
  );

  const composer = el("footer", { class: "composer" }, [
    el("div", { class: "composer-inner" }, [composerForm]),
  ]);

  const chatCol = el("section", { class: "chat-col" }, [header, dom.transcript, composer]);

  // --- Drawer ---
  buildDrawer(owner);

  app.replaceChildren(
    el("section", { class: "workspace" }, [rail, chatCol]),
    dom.backdrop,
    dom.drawer,
  );

  wireComposer();
  syncHeader();
}

/* ============================================================
   Composer behavior (Enter-to-send + IME guard + auto-grow)
   ============================================================ */
function wireComposer() {
  const ta = dom.textarea;

  const autoGrow = () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };

  ta.addEventListener("input", () => {
    autoGrow();
    updateSendState();
  });

  ta.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      if (!state.streaming) submitMessage();
    }
  });

  dom.composerBox.addEventListener("focusin", () => dom.composerBox.classList.add("focused"));
  dom.composerBox.addEventListener("focusout", () => dom.composerBox.classList.remove("focused"));

  autoGrow();
  updateSendState();
}

function updateSendState() {
  const hasText = dom.textarea.value.trim().length > 0;
  if (state.streaming) {
    dom.sendButton.disabled = false;
    dom.sendButton.classList.add("is-stop");
    dom.sendButton.setAttribute("aria-label", "중지");
    dom.sendButton.title = "중지";
    dom.sendButton.replaceChildren(icon("stop"));
  } else {
    dom.sendButton.disabled = !hasText;
    dom.sendButton.classList.remove("is-stop");
    dom.sendButton.setAttribute("aria-label", "보내기");
    dom.sendButton.title = "보내기";
    dom.sendButton.replaceChildren(icon("send"));
  }
}

/* ============================================================
   Header / mode sync (no full re-render)
   ============================================================ */
function syncHeader() {
  const copy = modeCopy[state.mode];
  dom.headerTitle.textContent = copy.title;
  dom.headerSub.textContent = copy.sub;

  // mode buttons (rail + mobile)
  dom.railModes.querySelectorAll("[data-mode]").forEach((btn) => {
    const active = btn.dataset.mode === state.mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
  dom.mobileMode.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.mode);
  });

  syncMarketBadge();
}

function syncMarketBadge() {
  const market = state.marketplace;
  const name = market?.name || state.skills?.marketplace?.name || "marketplace";
  const count = market?.pluginCount ?? market?.plugins?.length;
  let statusClass = "";
  if (market?.registryError) statusClass = "err";
  else if (market?.warnings?.length) statusClass = "warn";

  dom.marketBadge.replaceChildren(
    el("span", { class: `pulse ${statusClass}` }),
    el("span", {
      text: count != null ? `${name} · 플러그인 ${count}` : name,
    }),
  );
}

/* ============================================================
   Transcript rendering (surgical)
   ============================================================ */
function renderEmptyState() {
  const prompts =
    state.mode === "owner"
      ? [
          ["업무 요약", "오늘 업무 지시를 요약해서 보고해줘"],
          ["상태 확인", "지금 서비스들 정상 작동하고 있는지 확인해줘"],
          ["VM 정리", "우리 과제에서 사용 중인 VM 정보 정리해줘"],
          ["보고 초안", "최근 감사 로그 기준으로 진행 상황 정리해줘"],
        ]
      : [
          ["서비스 상태", "지금 서비스들 정상 작동하고 있는지 확인해줘"],
          ["VM 인벤토리", "우리 과제에서 사용 중인 VM 정보 정리해줘"],
          ["읽기 전용 확인", "현재 확인 가능한 운영 상태만 표로 보여줘"],
          ["최근 결과", "최근 조회된 상태를 요약해줘"],
        ];

  const grid = el("div", { class: "prompt-grid" });
  for (const [label, prompt] of prompts) {
    grid.append(
      el(
        "button",
        {
          class: "prompt-chip",
          type: "button",
          onclick: () => {
            dom.textarea.value = prompt;
            dom.textarea.dispatchEvent(new Event("input"));
            dom.textarea.focus();
          },
        },
        [el("strong", { text: label }), el("span", { text: prompt })],
      ),
    );
  }

  return el("div", { class: "empty-state" }, [
    el("div", { class: "hero" }, [
      el("h3", {
        text: state.mode === "owner" ? "업무 지시를 시작하세요" : "운영 상태를 바로 확인하세요",
      }),
      el("p", {
        text:
          state.mode === "owner"
            ? "소유자 모드는 marketplace skill 정책에 따라 작업을 실행하고 결과를 보고합니다. 아래 예시로 시작하거나 직접 지시를 입력하세요."
            : "동료 모드는 초대된 프로젝트 범위 안에서 읽기 전용 skill만 실행합니다. 아래 예시로 빠르게 조회하세요.",
      }),
    ]),
    grid,
  ]);
}

function renderTranscript() {
  dom.transcriptInner.replaceChildren();
  if (!state.messages.length) {
    dom.transcriptInner.append(renderEmptyState());
    return;
  }
  for (const message of state.messages) {
    dom.transcriptInner.append(buildMessageNode(message));
  }
  scrollToBottom(true);
}

function buildMessageNode(message) {
  const isUser = message.role === "user";
  const wrap = el("div", { class: `message ${message.role}` });
  wrap.append(
    el("div", { class: "msg-role" }, [
      el("span", { class: "role-dot" }),
      el("span", { text: isUser ? "나" : "어시스턴트" }),
    ]),
  );

  const bubble = el("div", { class: "bubble" });
  if (isUser) {
    bubble.textContent = message.content; // escaped plaintext, line breaks preserved via white-space
  } else {
    renderAssistantInto(bubble, message);
  }
  wrap.append(bubble);
  return wrap;
}

function renderAssistantInto(bubble, message) {
  const response = message.response;
  bubble.classList.toggle("blocked", response?.runtime === "blocked");
  bubble.classList.toggle("errored", response?.runtime === "error" || message.errored === true);

  if (response) {
    const meta = [
      response.runtime && ["runtime", response.runtime],
      response.pluginName && ["plugin", response.pluginName],
      response.skillName && ["skill", response.skillName],
    ].filter(Boolean);
    if (meta.length) {
      const metaRow = el("div", { class: "response-meta" });
      for (const [kind, val] of meta) {
        metaRow.append(
          el("span", { class: `meta-badge ${kind === "runtime" ? `runtime-${val}` : ""}`, text: val }),
        );
      }
      bubble.append(metaRow);
    }

    if (response.kind === "table" && response.table) {
      bubble.append(buildTable(response));
      if (response.text) bubble.append(el("div", { class: "md", html: renderMarkdown(response.text) }));
      return;
    }
    bubble.append(el("div", { class: "md", html: renderMarkdown(response.text || response.summary) }));
    return;
  }

  // Plain content fallback
  bubble.append(el("div", { class: "md", html: renderMarkdown(message.content) }));
}

function buildTable(response) {
  const columns = response.table.columns || [];
  const rows = response.table.rows || [];
  const wrap = el("div", {});
  if (response.title || response.summary) {
    wrap.append(el("div", { class: "response-title", text: response.title || response.summary }));
  }
  if (response.title && response.summary && response.title !== response.summary) {
    wrap.append(el("p", { class: "response-summary", text: response.summary }));
  }
  const tableWrap = el("div", { class: "table-wrap" });
  const table = el("table");
  const thead = el("tr");
  for (const c of columns) thead.append(el("th", { text: c }));
  table.append(el("thead", {}, [thead]));
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    for (const c of columns) tr.append(el("td", { text: row[c] == null ? "" : String(row[c]) }));
    tbody.append(tr);
  }
  table.append(tbody);
  tableWrap.append(table);
  wrap.append(tableWrap);
  return wrap;
}

/* ============================================================
   Scroll handling — auto-scroll only when near bottom
   ============================================================ */
function isNearBottom() {
  const t = dom.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom(force) {
  if (force || isNearBottom()) {
    dom.transcript.scrollTop = dom.transcript.scrollHeight;
  }
}

/* ============================================================
   Mode switching (surgical, no shell rebuild)
   ============================================================ */
async function switchMode(mode) {
  if (state.streaming) return;
  if (mode === "owner" && state.user?.role !== "owner") return;
  if (mode === state.mode) return;
  state.mode = mode;
  syncHeader();
  try {
    await loadMessages();
  } catch {
    /* keep current */
  }
  renderTranscript();
}

async function logout() {
  // Cancel any in-flight stream so the request (and its server-side SDK run)
  // is torn down rather than left running against a discarded transcript.
  abortController?.abort();
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* ignore */
  }
  state.user = null;
  state.messages = [];
  renderLogin();
}

/* ============================================================
   Sending + SSE streaming
   ============================================================ */
async function submitMessage() {
  const message = dom.textarea.value.trim();
  if (!message || state.streaming) return;

  // Drop empty-state if present.
  if (!state.messages.length) dom.transcriptInner.replaceChildren();

  // Append user bubble immediately.
  const userMsg = { role: "user", content: message };
  state.messages.push(userMsg);
  dom.transcriptInner.append(buildMessageNode(userMsg));

  dom.textarea.value = "";
  dom.textarea.style.height = "auto";
  scrollToBottom(true);

  await streamChat(message);
}

async function streamChat(message) {
  state.streaming = true;
  updateSendState();
  setComposerState("응답 대기 중…");
  dom.transcript.setAttribute("aria-busy", "true");

  // Live assistant bubble scaffold.
  const bubble = el("div", { class: "bubble" });
  const mdNode = el("div", { class: "md" });
  const caret = el("span", { class: "stream-caret", "aria-hidden": "true" });
  const statusRow = el("div", { class: "stream-status" }, [
    el("span", { class: "spinner" }),
    el("span", { class: "label", text: "준비 중…" }),
  ]);
  const pluginChips = el("div", { class: "plugin-chips" });
  bubble.append(mdNode, caret, statusRow, pluginChips);

  const wrap = el("div", { class: "message assistant" }, [
    el("div", { class: "msg-role" }, [el("span", { class: "role-dot" }), el("span", { text: "어시스턴트" })]),
    bubble,
  ]);
  dom.transcriptInner.append(wrap);
  scrollToBottom(true);

  const live = {
    bubble,
    mdNode,
    caret,
    statusRow,
    statusLabel: statusRow.querySelector(".label"),
    pluginChips,
    text: "",
    rafPending: false,
    done: false,
    aborted: false,
  };

  const flush = () => {
    live.rafPending = false;
    live.mdNode.innerHTML = renderMarkdown(live.text);
    scrollToBottom();
  };
  const scheduleFlush = () => {
    if (live.rafPending) return;
    live.rafPending = true;
    requestAnimationFrame(flush);
  };

  abortController = new AbortController();

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      signal: abortController.signal,
      body: JSON.stringify({
        mode: state.mode,
        message,
        conversationId: state.conversationId,
      }),
    });

    if (!response.ok || !response.body) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error || `HTTP ${response.status}`);
    }

    await consumeSse(response.body, (event, data) => handleSseEvent(event, data, live, scheduleFlush));
  } catch (error) {
    if (error.name === "AbortError" || live.aborted) {
      finalizeStopped(live);
    } else {
      finalizeError(live, error.message || "스트리밍 오류가 발생했습니다.");
    }
  } finally {
    if (!live.done) {
      // Network ended without explicit done/error/abort.
      if (live.aborted) finalizeStopped(live);
      else if (!live.text) finalizeError(live, "연결이 종료되었습니다.");
      else finalizeStopped(live);
    }
    state.streaming = false;
    abortController = null;
    updateSendState();
    setComposerState("");
    dom.transcript.setAttribute("aria-busy", "false");
    dom.textarea.focus();
  }
}

/* Manual SSE frame parser: split on \n\n, parse event:/data: lines. */
async function consumeSse(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const frame = parseFrame(rawFrame);
      if (frame) onEvent(frame.event, frame.data);
    }
  }
}

function parseFrame(raw) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue; // heartbeat / comment
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s/, ""));
    }
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join("\n");
  let data;
  try {
    data = JSON.parse(dataStr);
  } catch {
    data = { text: dataStr };
  }
  return { event, data };
}

function handleSseEvent(event, data, live, scheduleFlush) {
  switch (event) {
    case "open":
      if (data?.conversationId) state.conversationId = data.conversationId;
      setStatus(live, data?.runtime === "local" ? "로컬 런타임 준비 중…" : "Claude 준비 중…");
      break;
    case "status":
      if (data?.label) setStatus(live, data.label);
      break;
    case "plugin":
      handlePluginEvent(live, data);
      break;
    case "tool":
      if (data?.name) setStatus(live, `도구 실행 중: ${data.name}`);
      break;
    case "delta":
      if (typeof data?.text === "string") {
        live.text += data.text;
        scheduleFlush();
      }
      break;
    case "done":
      finalizeDone(live, data);
      break;
    case "error":
      finalizeError(live, data?.error || "오류가 발생했습니다.");
      break;
    default:
      break;
  }
}

function setStatus(live, label) {
  if (live.statusLabel) live.statusLabel.textContent = label;
}

function handlePluginEvent(live, data) {
  if (!data?.name) return;
  const status = data.status || "started";
  let chip = live.pluginChips.querySelector(`[data-plugin="${cssEscape(data.name)}"]`);
  if (!chip) {
    chip = el("span", { class: "plugin-chip", dataset: { plugin: data.name } }, [
      el("span", { class: "pc-dot" }),
      el("span", { class: "pc-text", text: data.name }),
    ]);
    live.pluginChips.append(chip);
  }
  chip.dataset.status = status;
  const labelMap = {
    started: "설치 중",
    installed: "설치됨",
    completed: "로드됨",
    failed: "실패",
  };
  chip.querySelector(".pc-text").textContent = `${data.name} · ${labelMap[status] || status}`;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function setComposerState(text) {
  const node = document.querySelector("#composer-state");
  if (node) node.textContent = text;
}

function cleanupLive(live) {
  live.caret.remove();
  live.statusRow.remove();
  if (!live.pluginChips.children.length) live.pluginChips.remove();
}

function finalizeDone(live, data) {
  if (live.done) return;
  live.done = true;
  cleanupLive(live);
  const message = data?.message || {
    role: "assistant",
    content: data?.response?.text || data?.response?.summary || live.text,
    response: data?.response,
  };
  // Persist authoritative message.
  state.messages.push(message);
  // Replace bubble content with authoritative render (tables, meta, etc.).
  live.bubble.replaceChildren();
  live.bubble.className = "bubble";
  renderAssistantInto(live.bubble, message);
  scrollToBottom();
  loadAudit().catch(() => {});
}

function finalizeError(live, msg) {
  if (live.done) return;
  live.done = true;
  cleanupLive(live);
  live.bubble.classList.add("errored");
  // Keep any partial text, then append the error note (single bubble + single message).
  if (live.text) {
    live.mdNode.innerHTML = renderMarkdown(live.text);
  } else {
    live.mdNode.remove();
  }
  live.bubble.append(
    el("div", { class: "response-meta" }, [el("span", { class: "meta-badge runtime-blocked", text: "오류" })]),
  );
  live.bubble.append(el("div", { class: "md", text: msg }));
  state.messages.push({
    role: "assistant",
    content: live.text ? `${live.text}\n\n${msg}` : msg,
    errored: true,
    response: { kind: "text", runtime: "error", summary: "오류", text: live.text || msg },
  });
}

function finalizeStopped(live) {
  if (live.done) return;
  live.done = true;
  live.aborted = true;
  cleanupLive(live);
  live.mdNode.innerHTML = renderMarkdown(live.text);
  live.bubble.append(
    el("div", { class: "stream-status" }, [el("span", { class: "label", text: "· 사용자가 중지함" })]),
  );
  // Single message matching the single rendered bubble.
  state.messages.push({
    role: "assistant",
    content: live.text || "(중지됨)",
    response: { kind: "text", runtime: "claude", summary: "중지됨", text: live.text },
  });
}

function stopStreaming() {
  if (abortController) {
    abortController.abort();
  }
}

/* ============================================================
   Settings drawer
   ============================================================ */
function buildDrawer(owner) {
  dom.backdrop = el("div", { class: "drawer-backdrop", onclick: () => closeDrawer() });

  const tabs = [
    { id: "market", label: "마켓플레이스 · 플러그인" },
    { id: "skills", label: "스킬" },
    owner ? { id: "invites", label: "초대" } : null,
    { id: "audit", label: "감사 로그" },
  ].filter(Boolean);

  dom.drawerTabs = el("div", { class: "drawer-tabs", role: "tablist" });
  dom.drawerPanels = {};
  const panelsWrap = el("div", { class: "drawer-body scroll-thin" });

  for (const tab of tabs) {
    const btn = el("button", {
      class: "drawer-tab",
      type: "button",
      role: "tab",
      id: `tab-${tab.id}`,
      "aria-controls": `panel-${tab.id}`,
      tabindex: "-1",
      dataset: { tab: tab.id },
      text: tab.label,
      onclick: () => selectTab(tab.id),
    });
    dom.drawerTabs.append(btn);

    const panel = el("div", {
      class: "drawer-panel",
      dataset: { panel: tab.id },
      role: "tabpanel",
      id: `panel-${tab.id}`,
      "aria-labelledby": `tab-${tab.id}`,
      tabindex: "0",
    });
    dom.drawerPanels[tab.id] = panel;
    panelsWrap.append(panel);
  }

  // Roving arrow-key navigation across the tablist.
  dom.drawerTabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const btns = [...dom.drawerTabs.querySelectorAll(".drawer-tab")];
    const current = btns.findIndex((b) => b.classList.contains("active"));
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = btns[(current + delta + btns.length) % btns.length];
    if (next) {
      selectTab(next.dataset.tab);
      next.focus();
    }
  });

  const closeBtn = el("button", {
    class: "drawer-close",
    type: "button",
    "aria-label": "설정 닫기",
    onclick: () => closeDrawer(),
  });
  closeBtn.append(icon("close"));

  dom.drawer = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true", "aria-label": "설정", hidden: "" }, [
    el("div", { class: "drawer-header" }, [el("h2", { text: "설정" }), closeBtn]),
    dom.drawerTabs,
    panelsWrap,
  ]);

  selectTab(owner ? "market" : "market", false);
}

function selectTab(id, render = true) {
  dom.drawerTabs.querySelectorAll(".drawer-tab").forEach((btn) => {
    const active = btn.dataset.tab === id;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = active ? 0 : -1;
  });
  for (const [pid, panel] of Object.entries(dom.drawerPanels)) {
    panel.classList.toggle("active", pid === id);
  }
  if (render) renderPanel(id);
}

function openDrawer(tab) {
  // Remember what opened the drawer so focus can return there on close.
  dom.drawerOpener = document.activeElement;
  dom.drawer.hidden = false;
  // Hide the background from AT and pointer while the modal drawer is open.
  document.querySelector(".workspace")?.setAttribute("aria-hidden", "true");
  // allow transition
  requestAnimationFrame(() => {
    dom.backdrop.classList.add("open");
    dom.drawer.classList.add("open");
  });
  if (tab) selectTab(tab);
  else {
    const active = dom.drawerTabs.querySelector(".drawer-tab.active")?.dataset.tab || "market";
    renderPanel(active);
  }
  document.addEventListener("keydown", onDrawerKeydown);
  dom.drawer.querySelector(".drawer-tab.active")?.focus();
}

function closeDrawer() {
  dom.backdrop.classList.remove("open");
  dom.drawer.classList.remove("open");
  document.removeEventListener("keydown", onDrawerKeydown);
  document.querySelector(".workspace")?.removeAttribute("aria-hidden");
  // Restore focus to the control that opened the drawer.
  const opener = dom.drawerOpener;
  if (opener && typeof opener.focus === "function") opener.focus();
  setTimeout(() => {
    if (!dom.drawer.classList.contains("open")) dom.drawer.hidden = true;
  }, 320);
}

function drawerFocusables() {
  return [...dom.drawer.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => node.offsetParent !== null || node === document.activeElement);
}

function onDrawerKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeDrawer();
    return;
  }
  // Focus trap: keep Tab cycling within the drawer.
  if (event.key === "Tab") {
    const focusables = drawerFocusables();
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dom.drawer.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dom.drawer.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }
}

function renderPanel(id) {
  const panel = dom.drawerPanels[id];
  if (!panel) return;
  if (id === "market") renderMarketPanel(panel);
  else if (id === "skills") renderSkillsPanel(panel);
  else if (id === "invites") renderInvitesPanel(panel);
  else if (id === "audit") renderAuditPanel(panel);
}

/* ---------- Marketplace panel ---------- */
function renderMarketPanel(panel) {
  panel.replaceChildren();
  const market = state.marketplace;

  const isOwner = state.user?.role === "owner";
  // Owners get an actionable refresh control; colleagues see passive copy
  // instead of a permanently-disabled (dead-looking) button.
  let headAction;
  if (isOwner) {
    const refreshBtn = el("button", {
      class: "refresh-btn",
      type: "button",
      title: "마켓플레이스 다시 동기화",
    });
    refreshBtn.append(icon("refresh"), el("span", { text: "다시 동기화" }));
    refreshBtn.addEventListener("click", () => refreshMarketplace(refreshBtn, panel));
    headAction = refreshBtn;
  } else {
    headAction = el("span", { class: "tag", text: "소유자가 동기화를 관리합니다" });
  }

  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "마켓플레이스 · 플러그인" }),
        el("p", { text: "부팅 시 자동으로 로드된 Claude 플러그인 상태입니다." }),
      ]),
      headAction,
    ]),
  );

  if (!market) {
    panel.append(el("div", { class: "empty-note", text: "마켓플레이스 정보를 불러오는 중…" }));
    loadMarketplace()
      .then(() => {
        if (dom.drawerPanels.market?.classList.contains("active")) renderMarketPanel(dom.drawerPanels.market);
        syncMarketBadge();
      })
      .catch((err) => {
        panel.querySelector(".empty-note")?.replaceWith(
          el("div", { class: "warn-box", text: `상태를 불러오지 못했습니다: ${err.message}` }),
        );
      });
    return;
  }

  panel.append(
    el("div", { class: "market-meta" }, [
      el("div", { class: "market-summary" }, [
        el("span", { class: "tag accent", text: market.name || "marketplace" }),
        el("span", { class: "tag", text: `플러그인 ${market.pluginCount ?? market.plugins?.length ?? 0}개` }),
      ]),
    ]),
  );

  if (market.registryError) {
    panel.append(el("div", { class: "warn-box", text: `레지스트리 오류: ${market.registryError}` }));
  }
  if (market.warnings?.length) {
    panel.append(el("div", { class: "warn-box", text: market.warnings.join("\n") }));
  }

  const cards = el("div", { class: "plugin-cards" });
  const plugins = market.plugins || [];
  if (!plugins.length) {
    cards.append(el("div", { class: "empty-note", text: "로드된 플러그인이 없습니다." }));
  }
  for (const plugin of plugins) {
    cards.append(buildPluginCard(plugin));
  }
  panel.append(cards);
}

function buildPluginCard(plugin) {
  const owner = state.user?.role === "owner";
  const card = el("div", { class: "plugin-card" }, [
    el("div", { class: "plugin-card-head" }, [
      el("span", { class: "pc-name", text: plugin.name }),
      plugin.version ? el("span", { class: "pc-version", text: `v${plugin.version}` }) : null,
    ]),
  ]);
  if (plugin.description) card.append(el("p", { class: "pc-desc", text: plugin.description }));

  const tags = el("div", { class: "pc-tags" });
  if (typeof plugin.commandCount === "number") {
    tags.append(el("span", { class: "tag", text: `명령 ${plugin.commandCount}개` }));
  }
  if (plugin.source) {
    const src = typeof plugin.source === "string" ? plugin.source : plugin.source.source || "source";
    tags.append(el("span", { class: "tag", text: src }));
  }
  // Read-only / owner visibility derived from skills registry.
  const access = pluginAccess(plugin.name);
  if (access) tags.append(el("span", { class: `tag ${access.cls}`, text: access.label }));
  for (const t of plugin.tags || []) tags.append(el("span", { class: "tag", text: t }));
  if (!owner) tags.append(el("span", { class: "tag", text: "조회 전용" }));
  card.append(tags);
  return card;
}

// Determine if a plugin exposes any owner-only (write) commands, from /api/skills.
function pluginAccess(name) {
  const skillsPlugin = (state.skills?.plugins || []).find((p) => p.name === name);
  if (!skillsPlugin) return null;
  const cmds = skillsPlugin.commands || [];
  if (!cmds.length) return null;
  const hasWrite = cmds.some((c) => c.readOnly === false);
  return hasWrite
    ? { cls: "write", label: "owner 작업 포함" }
    : { cls: "read", label: "read-only" };
}

async function refreshMarketplace(btn, panel) {
  if (state.user?.role !== "owner") return;
  btn.classList.add("loading");
  btn.disabled = true;
  const labelNode = btn.querySelector("span");
  const prev = labelNode.textContent;
  labelNode.textContent = "동기화 중…";
  try {
    const result = await api("/api/marketplace/refresh", { method: "POST" });
    state.marketplace = result;
    try {
      await loadSkills();
    } catch {
      /* ignore */
    }
    renderMarketPanel(panel);
    syncMarketBadge();
  } catch (error) {
    btn.classList.remove("loading");
    btn.disabled = false;
    labelNode.textContent = prev;
    panel.append(el("div", { class: "warn-box", text: `동기화 실패: ${error.message}` }));
  }
}

/* ---------- Skills panel ---------- */
function renderSkillsPanel(panel) {
  panel.replaceChildren();
  const plugins = state.skills?.plugins || [];
  const items = plugins.flatMap((plugin) =>
    (plugin.commands || []).map((command) => ({ plugin: plugin.name, command })),
  );

  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "사용 가능한 스킬" }),
        el("p", { text: "현재 모드에서 실행 가능한 marketplace 스킬입니다." }),
      ]),
      el("span", { class: "tag accent", text: `${items.length}개` }),
    ]),
  );

  if (!items.length) {
    panel.append(el("div", { class: "empty-note", text: "현재 모드에서 보이는 스킬이 없습니다." }));
    return;
  }

  const list = el("ul", { class: "skill-list" });
  for (const { plugin, command } of items) {
    list.append(
      el("li", { class: "skill-item" }, [
        el("strong", { text: `${plugin}:${command.name}` }),
        el("p", { text: command.description || "" }),
        el("div", { class: "tags" }, [
          el("span", { class: `tag ${command.readOnly ? "read" : "write"}`, text: command.readOnly ? "read-only" : "write" }),
          el("span", { class: "tag", text: command.projectScoped ? "project-scoped" : "owner-only" }),
        ]),
      ]),
    );
  }
  panel.append(list);
}

/* ---------- Invites panel ---------- */
function renderInvitesPanel(panel) {
  panel.replaceChildren();
  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "초대 생성" }),
        el("p", { text: "팀원을 초대할 코드를 발급합니다." }),
      ]),
    ]),
  );

  const result = el("div", {});
  const form = el(
    "form",
    {
      class: "form-stack",
      onsubmit: async (event) => {
        event.preventDefault();
        const fd = new FormData(event.currentTarget);
        const btn = event.currentTarget.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          const res = await api("/api/invites", {
            method: "POST",
            body: JSON.stringify({
              label: fd.get("label"),
              role: fd.get("role"),
              projectScope: fd.get("projectScope"),
              maxUses: Number(fd.get("maxUses")),
            }),
          });
          result.replaceChildren(el("div", { class: "invite-result", text: res.invite.code }));
          await loadAudit().catch(() => {});
        } catch (error) {
          result.replaceChildren(el("div", { class: "warn-box", text: error.message }));
        } finally {
          btn.disabled = false;
        }
      },
    },
    [
      el("label", { class: "field" }, [el("span", { text: "라벨" }), el("input", { name: "label", value: "팀원 초대" })]),
      el("label", { class: "field" }, [
        el("span", { text: "역할" }),
        el("select", { name: "role" }, [
          el("option", { value: "colleague", text: "동료" }),
          el("option", { value: "owner", text: "소유자" }),
        ]),
      ]),
      el("label", { class: "field" }, [
        el("span", { text: "프로젝트 범위" }),
        el("input", { name: "projectScope", value: state.user?.projectScope || "default-project" }),
      ]),
      el("label", { class: "field" }, [
        el("span", { text: "사용 횟수" }),
        el("input", { name: "maxUses", type: "number", min: "1", max: "500", value: "5" }),
      ]),
      el("button", { class: "primary", type: "submit", text: "초대 코드 만들기" }),
    ],
  );
  panel.append(form, result);
}

/* ---------- Audit panel ---------- */
function renderAuditPanel(panel) {
  panel.replaceChildren();
  panel.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "감사 로그" }),
        el("p", { text: "최근 활동 기록입니다." }),
      ]),
    ]),
  );

  const events = state.audit.slice(0, 30);
  if (!events.length) {
    panel.append(el("div", { class: "empty-note", text: "아직 로그가 없습니다." }));
    return;
  }
  const list = el("ul", { class: "audit-list" });
  for (const event of events) {
    list.append(
      el("li", { class: `audit-item ${event.status}` }, [
        el("strong", { text: `${event.action} · ${event.mode}` }),
        el("p", { text: event.detail || "" }),
        event.createdAt ? el("time", { text: timeLabel(event.createdAt) }) : null,
      ]),
    );
  }
  panel.append(list);
}

/* ============================================================
   Data loaders
   ============================================================ */
async function loadSkills() {
  state.skills = await api("/api/skills");
}
async function loadAudit() {
  const result = await api("/api/audit");
  state.audit = result.audit || [];
  if (dom.drawerPanels?.audit?.classList.contains("active")) {
    renderAuditPanel(dom.drawerPanels.audit);
  }
}
async function loadMessages() {
  const result = await api(`/api/messages?mode=${encodeURIComponent(state.mode)}`);
  state.messages = result.messages || [];
}
async function loadMarketplace() {
  state.marketplace = await api("/api/marketplace/status");
}

async function hydrate() {
  await Promise.all([
    loadSkills().catch(() => {}),
    loadAudit().catch(() => {}),
    loadMessages().catch(() => {}),
  ]);
  mountWorkspace();
  renderTranscript();
  // Warm marketplace status in background for the header badge + drawer.
  loadMarketplace()
    .then(() => syncMarketBadge())
    .catch(() => {});
}

async function boot() {
  state.bootstrap = await api("/api/bootstrap").catch(() => null);
  const me = await api("/api/me");
  state.user = me.user;
  if (!state.user) {
    renderLogin();
    return;
  }
  state.mode = state.user.role === "owner" ? "owner" : "colleague";
  await hydrate();
}

boot().catch((error) => {
  state.error = error.message;
  renderLogin();
});
