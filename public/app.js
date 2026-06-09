const app = document.querySelector("#app");

const state = {
  user: null,
  bootstrap: null,
  skills: null,
  audit: [],
  messages: [],
  mode: "colleague",
  conversationId: crypto.randomUUID(),
  loading: false,
  error: "",
};

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLogin() {
  app.innerHTML = `
    <section class="login-view">
      <div class="login-panel">
        <div class="login-mark">A</div>
        <h1>Avatar Chat</h1>
        <p>사내 프로젝트 팀을 위한 초대 기반 업무 채팅입니다.</p>
        ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
        <form class="form-stack" id="login-form">
          <label class="field">
            <span>이름</span>
            <input name="name" autocomplete="name" placeholder="홍길동" required />
          </label>
          <label class="field">
            <span>초대 코드</span>
            <input name="code" autocomplete="one-time-code" placeholder="초대 코드 입력" required />
          </label>
          <button class="primary" type="submit">접속</button>
        </form>
        <div class="hint">초대 코드는 앱 소유자가 발급합니다. 초기 소유자 설정 코드는 배포 환경 변수에서 관리합니다.</div>
      </div>
    </section>
  `;
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/session", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          code: form.get("code"),
        }),
      });
      state.user = result.user;
      state.mode = state.user.role === "owner" ? "owner" : "colleague";
      state.error = "";
      await hydrate();
    } catch (error) {
      state.error = error.message;
      renderLogin();
    }
  });
}

function renderSkills() {
  const plugins = state.skills?.plugins || [];
  const items = plugins.flatMap((plugin) =>
    plugin.commands.map(
      (command) => `
        <li class="skill-item">
          <strong>${escapeHtml(plugin.name)}:${escapeHtml(command.name)}</strong>
          <p>${escapeHtml(command.description)}</p>
          <p>
            <span class="tag">${command.readOnly ? "read-only" : "write"}</span>
            <span class="tag">${command.projectScoped ? "project-scoped" : "owner-only"}</span>
          </p>
        </li>
      `,
    ),
  );
  return `
    <section class="section">
      <div class="section-header">
        <h2>사용 가능한 Skills</h2>
        <span class="tag">${items.length}</span>
      </div>
      <ul class="skill-list compact">${items.join("") || `<li class="muted">현재 모드에서 보이는 skill이 없습니다.</li>`}</ul>
    </section>
  `;
}

function renderInvitePanel() {
  if (state.user?.role !== "owner") {
    return "";
  }
  return `
    <section class="section">
      <h2>초대 생성</h2>
      <form class="form-stack" id="invite-form">
        <label class="field">
          <span>라벨</span>
          <input name="label" value="팀원 초대" />
        </label>
        <label class="field">
          <span>역할</span>
          <select name="role">
            <option value="colleague">동료</option>
            <option value="owner">소유자</option>
          </select>
        </label>
        <label class="field">
          <span>프로젝트 범위</span>
          <input name="projectScope" value="${escapeHtml(state.user.projectScope)}" />
        </label>
        <label class="field">
          <span>사용 횟수</span>
          <input name="maxUses" type="number" min="1" max="500" value="5" />
        </label>
        <button class="ghost" type="submit">초대 코드 만들기</button>
      </form>
      <div id="invite-result"></div>
    </section>
  `;
}

function renderAudit() {
  const items = state.audit.slice(0, 10).map(
    (event) => `
      <li class="audit-item ${escapeHtml(event.status)}">
        <strong>${escapeHtml(event.action)} · ${escapeHtml(event.mode)}</strong>
        <p>${escapeHtml(event.detail)}</p>
      </li>
    `,
  );
  return `
    <section class="section">
      <h2>최근 감사 로그</h2>
      <ul class="audit-list">${items.join("") || `<li class="muted">아직 로그가 없습니다.</li>`}</ul>
    </section>
  `;
}

function renderResponse(response) {
  if (!response) {
    return "";
  }
  const meta = [
    response.runtime,
    response.pluginName,
    response.skillName,
  ].filter(Boolean);
  const metaHtml = `<div class="response-meta">${meta.map((item) => `<span class="mode-badge">${escapeHtml(item)}</span>`).join("")}</div>`;
  if (response.kind === "table" && response.table) {
    const columns = response.table.columns || [];
    const rows = response.table.rows || [];
    return `
      ${metaHtml}
      <strong>${escapeHtml(response.title || response.summary)}</strong>
      <p>${escapeHtml(response.summary)}</p>
      <div class="table-wrap">
        <table>
          <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
          <tbody>
            ${rows
              .map(
                (row) =>
                  `<tr>${columns.map((column) => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
      ${response.text ? `<p>${escapeHtml(response.text)}</p>` : ""}
    `;
  }
  return `${metaHtml}${escapeHtml(response.text || response.summary)}`;
}

function renderMessages() {
  if (!state.messages.length) {
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
    return `
      <div class="empty-state">
        <div>
          <h3>${state.mode === "owner" ? "업무 지시를 시작하세요" : "운영 상태를 바로 확인하세요"}</h3>
          <p>${state.mode === "owner" ? "소유자 모드는 marketplace skill 정책에 따라 작업을 실행하고 결과를 보고합니다." : "동료 모드는 초대된 프로젝트 범위 안에서 읽기 전용 skill만 실행합니다."}</p>
        </div>
        <div class="prompt-grid">
          ${prompts
            .map(
              ([label, prompt]) => `
                <button class="prompt-chip" type="button" data-prompt="${escapeHtml(prompt)}">
                  <strong>${escapeHtml(label)}</strong>
                  <span>${escapeHtml(prompt)}</span>
                </button>
              `,
            )
            .join("")}
        </div>
      </div>
    `;
  }
  const messages = state.messages.map((message) => {
    const blocked = message.response?.runtime === "blocked" ? " blocked" : "";
    return `
      <li class="message ${message.role}">
        <div class="bubble${blocked}">
          ${
            message.role === "assistant"
              ? renderResponse(message.response) || escapeHtml(message.content)
              : escapeHtml(message.content)
          }
        </div>
      </li>
    `;
  });
  return `<ul class="message-list">${messages.join("")}</ul>`;
}

function renderWorkspace() {
  const owner = state.user?.role === "owner";
  app.innerHTML = `
    <section class="workspace">
      <aside class="sidebar">
        <div class="brand">
          <div>
            <h1>Avatar Chat</h1>
            <span class="role-badge">${escapeHtml(state.user.name)} · ${escapeHtml(state.user.role)}</span>
          </div>
          <button class="ghost" id="logout-button">나가기</button>
        </div>
        <div class="section">
          <h2>Marketplace</h2>
          <p class="muted">${escapeHtml(state.skills?.marketplace?.name || "loading")}</p>
          ${
            state.skills?.marketplace?.warnings?.length
              ? `<div class="error">${state.skills.marketplace.warnings.map(escapeHtml).join("<br />")}</div>`
              : ""
          }
        </div>
        ${renderSkills()}
        ${renderInvitePanel()}
        ${renderAudit()}
      </aside>
      <section class="main-panel">
        <header class="topbar">
          <div class="panel-title">
            <h2>${state.mode === "owner" ? "업무 지시 모드" : "동료 조회 모드"}</h2>
            <p class="muted">${state.mode === "owner" ? "소유자 지시를 marketplace skill로 처리합니다." : "읽기 전용 상태 확인과 과제 리소스 조회만 처리합니다."}</p>
            <div class="status-line">
              <span class="mode-badge">${escapeHtml(state.skills?.marketplace?.name || "marketplace")}</span>
              <span class="mode-badge">${state.mode === "owner" ? "owner tools" : "read-only"}</span>
            </div>
          </div>
          <div class="segmented" role="tablist">
            <button data-mode="colleague" class="${state.mode === "colleague" ? "active" : ""}">동료 조회</button>
            <button data-mode="owner" class="${state.mode === "owner" ? "active" : ""}" ${owner ? "" : "disabled"}>업무 지시</button>
          </div>
        </header>
        <div class="messages" id="messages">${renderMessages()}</div>
        <footer class="chat-input">
          <form class="chat-form" id="chat-form">
            <textarea name="message" placeholder="예: 지금 서비스들 정상 작동하고 있는지 확인해줘" required></textarea>
            <button class="primary" type="submit" ${state.loading ? "disabled" : ""}>보내기</button>
          </form>
        </footer>
      </section>
    </section>
  `;

  document.querySelector("#logout-button").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    state.messages = [];
    renderLogin();
  });

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      state.mode = button.dataset.mode;
      await loadMessages();
      renderWorkspace();
    });
  });

  document.querySelector("#chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const message = String(form.get("message") || "").trim();
    if (!message) return;
    state.loading = true;
    state.messages.push({ role: "user", content: message });
    renderWorkspace();
    try {
      const result = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          mode: state.mode,
          message,
          conversationId: state.conversationId,
        }),
      });
      state.messages.push(result.message);
      await loadAudit();
    } catch (error) {
      state.messages.push({
        role: "assistant",
        content: error.message,
        response: { kind: "text", runtime: "blocked", summary: "오류", text: error.message },
      });
    } finally {
      state.loading = false;
      renderWorkspace();
      document.querySelector("#messages").scrollTop = document.querySelector("#messages").scrollHeight;
    }
  });

  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      const textarea = document.querySelector('textarea[name="message"]');
      textarea.value = button.dataset.prompt;
      textarea.focus();
    });
  });

  const inviteForm = document.querySelector("#invite-form");
  if (inviteForm) {
    inviteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const result = await api("/api/invites", {
        method: "POST",
        body: JSON.stringify({
          label: form.get("label"),
          role: form.get("role"),
          projectScope: form.get("projectScope"),
          maxUses: Number(form.get("maxUses")),
        }),
      });
      document.querySelector("#invite-result").innerHTML = `
        <div class="invite-result">${escapeHtml(result.invite.code)}</div>
      `;
      await loadAudit();
    });
  }
}

async function loadSkills() {
  state.skills = await api("/api/skills");
}

async function loadAudit() {
  const result = await api("/api/audit");
  state.audit = result.audit || [];
}

async function loadMessages() {
  const result = await api(`/api/messages?mode=${encodeURIComponent(state.mode)}`);
  state.messages = result.messages || [];
}

async function hydrate() {
  await Promise.all([loadSkills(), loadAudit(), loadMessages()]);
  renderWorkspace();
}

async function boot() {
  state.bootstrap = await api("/api/bootstrap");
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
