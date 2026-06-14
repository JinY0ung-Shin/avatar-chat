// Auto-split from app.js — module: auth. Behavior-preserving relocation only.
import { stopAllChatStreams } from "./chat.js";
import { api, app, el, icon, notify, setAbort, setFormBusy, setSessionExpired, state } from "./core.js";
import { enterApp } from "./lifecycle.js";


/* ============================================================ Auth view */
export function buildRevealableInput({
  name,
  autocomplete = "off",
  placeholder = "",
  ariaLabel = "",
  revealLabel = "비밀번호",
  required = false,
  minlength = null,
}) {
  const input = el("input", {
    name,
    type: "password",
    autocomplete,
    placeholder,
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(required ? { required: "" } : {}),
    ...(minlength ? { minlength: String(minlength) } : {}),
  });
  const toggle = el("button", {
    class: "password-toggle",
    type: "button",
    "aria-label": `${revealLabel} 보기`,
    title: `${revealLabel} 보기`,
  });
  const sync = () => {
    const visible = input.type === "text";
    toggle.setAttribute("aria-label", visible ? `${revealLabel} 숨기기` : `${revealLabel} 보기`);
    toggle.title = visible ? `${revealLabel} 숨기기` : `${revealLabel} 보기`;
    toggle.replaceChildren(icon(visible ? "eye-off" : "eye"));
  };
  toggle.addEventListener("click", () => {
    input.type = input.type === "password" ? "text" : "password";
    sync();
    input.focus();
  });
  sync();
  return { input, wrap: el("div", { class: "password-field" }, [input, toggle]) };
}

function buildPasswordInput({ autocomplete, placeholder }) {
  return buildRevealableInput({
    name: "password",
    autocomplete,
    placeholder,
    required: true,
    minlength: 8,
  }).wrap;
}

export function renderAuth(mode = "login", { username = "", displayName = "" } = {}) {
  stopAllChatStreams();
  setAbort(null);
  state.streaming = false;
  document.title = "Noah Almighty";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  // Self-service signup is gated by the deployment's signup mode. The very first
  // account (setup) is always allowed; otherwise "closed" hides the signup form.
  const signupAllowed = mode === "setup" || state.signupMode !== "closed";
  if (mode === "signup" && !signupAllowed) {
    renderAuth("login", { username, displayName });
    return;
  }
  const isLogin = mode === "login";
  const isSetup = mode === "setup";
  const form = el("form", {
    class: "form-stack",
    onsubmit: async (event) => {
      event.preventDefault();
      const formEl = event.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      const savedLabel = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = isLogin ? "로그인 중…" : isSetup ? "계정 만드는 중…" : "가입 중…";
      try {
        const path = isLogin ? "/api/auth/login" : "/api/auth/signup";
        const payload = isLogin
          ? { username: fd.get("username"), password: fd.get("password") }
          : { username: fd.get("username"), displayName: fd.get("displayName"), password: fd.get("password") };
        const result = await api(path, { method: "POST", body: JSON.stringify(payload) });
        // Approval-mode signup: the account is created but parked until an admin
        // activates it — there's no session yet, so bounce back to the login form.
        if (!isLogin && result.pending) {
          state.authError = "";
          renderAuth("login", { username: fd.get("username") || "" });
          notify("가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.", "info");
          return;
        }
        setSessionExpired(false);
        state.user = result.user;
        state.authError = "";
        await enterApp();
      } catch (error) {
        state.authError = error.message;
        // Keep what the user typed — re-entering the username after a wrong
        // password is pure friction.
        renderAuth(mode, { username: fd.get("username") || "", displayName: fd.get("displayName") || "" });
        btn.textContent = savedLabel;
      }
    },
  });

  const fields = [];
  fields.push(
    el("label", { class: "field" }, [
      el("span", { text: "사용자명" }),
      el("input", { name: "username", autocomplete: "username", placeholder: "user123", required: "", minlength: "3", value: username }),
    ]),
  );
  if (!isLogin) {
    fields.push(
      el("label", { class: "field" }, [
        el("span", { text: "표시 이름" }),
        el("input", { name: "displayName", autocomplete: "nickname", placeholder: "홍길동", required: "", value: displayName }),
      ]),
    );
  }
  fields.push(
    el("label", { class: "field" }, [
      el("span", { text: "비밀번호" }),
      buildPasswordInput({
        autocomplete: isLogin ? "current-password" : "new-password",
        placeholder: isLogin ? "비밀번호" : "8자 이상",
      }),
    ]),
  );
  fields.push(el("button", { class: "primary", type: "submit", text: isLogin ? "로그인" : isSetup ? "관리자 계정 만들기" : "회원가입" }));
  form.append(...fields);

  app.replaceChildren(
    el("section", { class: "auth-view" }, [
      el("div", { class: "auth-panel" }, [
        el("img", { class: "login-mark", src: "/icon-192.png", alt: "Noah Almighty", width: "48", height: "48" }),
        isSetup ? el("div", { class: "setup-badge", text: "첫 실행 · 관리자 설정" }) : null,
        el("h1", { text: isSetup ? "관리자 계정 만들기" : isLogin ? "다시 오신 것을 환영합니다" : "Noah Almighty 시작하기" }),
        el("p", {
          text: isSetup
            ? "서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다."
            : "나만의 아바타를 만들고, 다른 사람의 아바타와 대화하세요.",
        }),
        !isLogin && !isSetup && state.signupMode === "approval"
          ? el("p", { class: "muted auth-note", text: "관리자 승인 후 로그인할 수 있습니다." })
          : null,
        state.authError ? el("div", { class: "error", role: "alert", text: state.authError }) : null,
        form,
        renderAuthSwitch({ isLogin, isSetup, signupAllowed }),
      ]),
    ]),
  );
  const userInput = app.querySelector('input[name="username"]');
  if (userInput && !userInput.value) userInput.focus();
  else app.querySelector('input[name="password"]')?.focus();
}

/* Login↔signup toggle. Hidden during setup; on the login screen it collapses to
   a "signup disabled" note when the deployment has closed self-service signup. */
function renderAuthSwitch({ isLogin, isSetup, signupAllowed }) {
  if (isSetup) return null;
  if (isLogin && !signupAllowed) {
    return el("div", { class: "auth-switch" }, [
      el("span", { class: "muted", text: "현재 회원가입을 받지 않습니다." }),
    ]);
  }
  return el("div", { class: "auth-switch" }, [
    el("span", { text: isLogin ? "계정이 없으신가요? " : "이미 계정이 있으신가요? " }),
    el("button", {
      class: "linkish",
      type: "button",
      text: isLogin ? "회원가입" : "로그인",
      onclick: () => {
        const currentUsername = app.querySelector('input[name="username"]')?.value || "";
        const currentDisplayName = app.querySelector('input[name="displayName"]')?.value || "";
        state.authError = "";
        renderAuth(isLogin ? "signup" : "login", {
          username: currentUsername,
          displayName: currentDisplayName,
        });
      },
    }),
  ]);
}
