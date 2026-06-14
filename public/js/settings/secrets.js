// Auto-split from settings.js — submodule: secrets (git credentials + secrets + SSH).
// Behavior-preserving relocation only.
import { buildRevealableInput } from "../auth.js";
import { api, copyText, el, icon, notify, setFormBusy, state } from "../core.js";

const INTERNAL_GIT_TOKEN_SECRET_NAME = "GIT_TOKEN";
const EXTERNAL_GIT_TOKEN_SECRET_NAME = "GITHUB_TOKEN";

export function hasSecret(name) {
  return (state.user.secretNames || []).includes(name);
}

export function buildSshPublicKeyField(publicKey) {
  const copyBtn = el("button", { class: "msg-act", type: "button", "aria-label": "SSH 공개키 복사", title: "SSH 공개키 복사" });
  copyBtn.append(icon("copy"));
  copyBtn.addEventListener("click", () => copyText(publicKey, copyBtn));
  return el("label", { class: "field ssh-public-key-field" }, [
    el("span", { text: "SSH 공개키" }),
    el("div", { class: "ssh-public-key-row" }, [
      el("textarea", { rows: "3", readonly: "", text: publicKey }),
      copyBtn,
    ]),
  ]);
}

// Git 자격증명: write-only internal/external tokens + commit identity. Token
// values are never returned by the server; only set/unset state is exposed.
export function buildGitCredentialsCard() {
  const u = state.user;
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "Git 자격증명" }),
        el("p", { class: "muted", text: "사내 GitHub와 외부 github.com 토큰을 분리해 저장합니다. 값은 암호화되어 저장되며 다시 표시되지 않습니다." }),
      ]),
    ]),
  );

  const status = el("div", { class: "git-token-status muted" });
  const renderStatus = () => {
    const externalSet = hasSecret(EXTERNAL_GIT_TOKEN_SECRET_NAME);
    status.replaceChildren(
      state.user.gitTokenSet
        ? el("span", { class: "token-set", text: "● 사내 Git (GIT_TOKEN) 설정됨" })
        : el("span", { text: "사내 Git (GIT_TOKEN) 미설정" }),
      " · ",
      externalSet
        ? el("span", { class: "token-set", text: "외부 GitHub (GITHUB_TOKEN) 설정됨" })
        : el("span", { text: "외부 GitHub (GITHUB_TOKEN) 미설정" }),
    );
  };
  renderStatus();

  const buildTokenForm = ({ label, secretName, description, placeholder, ariaLabel, saveToken, clearToken, isSet }) => {
    let form;
    const tokenField = buildRevealableInput({ name: "token", placeholder, ariaLabel, revealLabel: "토큰", required: true });
    const input = tokenField.input;
    const saveBtn = el("button", { class: "primary", type: "submit", text: isSet() ? "교체" : "저장" });
    const clearBtn = el("button", {
      class: "linkish small",
      type: "button",
      text: "삭제",
      disabled: isSet() ? null : "",
      onclick: async () => {
        if (!window.confirm(`${label}을 삭제할까요?`)) return;
        const saved = clearBtn.textContent;
        setFormBusy(form, true);
        clearBtn.textContent = "삭제 중…";
        try {
          await clearToken();
          notify(`${label}을 삭제했습니다.`, "ok");
          renderStatus();
          clearBtn.textContent = saved;
          setFormBusy(form, false);
          refreshRow();
        } catch (e) {
          notify(`삭제 실패: ${e.message}`);
          clearBtn.textContent = saved;
          setFormBusy(form, false);
          refreshRow();
        }
      },
    });
    const rowStatus = el("span", {
      class: isSet() ? "muted token-set" : "muted",
      text: isSet() ? "● 설정됨" : "미설정",
    });
    const refreshRow = () => {
      const set = isSet();
      rowStatus.className = set ? "muted token-set" : "muted";
      rowStatus.textContent = set ? "● 설정됨" : "미설정";
      saveBtn.textContent = set ? "교체" : "저장";
      clearBtn.disabled = set ? false : true;
    };
    form = el("form", {
      class: "secret-preset-row",
      onsubmit: async (e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const token = input.value.trim();
        if (!token) return;
        const saved = saveBtn.textContent;
        setFormBusy(formEl, true);
        saveBtn.textContent = "저장 중…";
        try {
          await saveToken(token);
          input.value = "";
          renderStatus();
          refreshRow();
          setFormBusy(formEl, true);
          saveBtn.textContent = "저장됨 ✓";
          notify(`${label}을 저장했습니다.`, "ok");
          setTimeout(() => { setFormBusy(formEl, false); refreshRow(); }, 1200);
        } catch (err) {
          saveBtn.textContent = saved;
          setFormBusy(formEl, false);
          refreshRow();
          notify(`저장 실패: ${err.message}`);
        }
      },
    }, [
      el("div", { class: "secret-preset-meta" }, [
        el("div", { class: "secret-preset-title" }, [
          el("strong", { text: label }),
          el("code", { text: secretName }),
          rowStatus,
        ]),
        el("p", { class: "muted", text: description }),
      ]),
      tokenField.wrap,
      el("div", { class: "secret-preset-actions" }, [saveBtn, clearBtn]),
    ]);
    return form;
  };

  const internalTokenForm = buildTokenForm({
    label: "사내 Git 토큰",
    secretName: INTERNAL_GIT_TOKEN_SECRET_NAME,
    description: `사내 GitHub(${state.githubHost || "GITHUB_HOST"}) 전용입니다. 지식 저장소 생성·푸시와 사내 비공개 저장소 접근에 사용됩니다.`,
    placeholder: "사내 GitHub PAT (GIT_TOKEN)",
    ariaLabel: "사내 Git 토큰 GIT_TOKEN",
    isSet: () => Boolean(state.user.gitTokenSet),
    saveToken: async (token) => {
      const { user } = await api("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      state.user = user;
    },
    clearToken: async () => {
      const { user } = await api("/api/me/git-token", { method: "DELETE" });
      state.user = user;
    },
  });

  const externalTokenForm = buildTokenForm({
    label: "외부 GitHub 토큰",
    secretName: EXTERNAL_GIT_TOKEN_SECRET_NAME,
    description: "github.com HTTPS 저장소 접근 전용입니다. 지식 저장소 생성·푸시에는 사용되지 않습니다.",
    placeholder: "github.com PAT (GITHUB_TOKEN)",
    ariaLabel: "외부 GitHub 토큰 GITHUB_TOKEN",
    isSet: () => hasSecret(EXTERNAL_GIT_TOKEN_SECRET_NAME),
    saveToken: async (token) => {
      const { user } = await api(`/api/me/secrets/${EXTERNAL_GIT_TOKEN_SECRET_NAME}`, {
        method: "PUT",
        body: JSON.stringify({ value: token }),
      });
      state.user = user;
    },
    clearToken: async () => {
      const { user } = await api(`/api/me/secrets/${EXTERNAL_GIT_TOKEN_SECRET_NAME}`, { method: "DELETE" });
      state.user = user;
    },
  });

  // Commit identity used for knowledge-repo pushes.
  const identityForm = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        const { user } = await api("/api/me/git-identity", {
          method: "PUT",
          body: JSON.stringify({ name: fd.get("name") || null, email: fd.get("email") || null }),
        });
        state.user = user;
        btn.textContent = "저장됨 ✓";
        notify("커밋 정보를 저장했습니다.", "ok");
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
      } catch (err) {
        btn.textContent = saved;
        setFormBusy(formEl, false);
        notify(`저장 실패: ${err.message}`);
      }
    },
  }, [
    el("div", { class: "field-row-2col" }, [
      el("label", { class: "field" }, [el("span", { text: "커밋 이름" }), el("input", { name: "name", value: u.gitIdentityName || "", placeholder: u.alias || u.displayName || "" })]),
      el("label", { class: "field" }, [el("span", { text: "커밋 이메일" }), el("input", { name: "email", type: "email", value: u.gitIdentityEmail || "", placeholder: `${u.username}@example.com` })]),
    ]),
    el("button", { class: "primary", type: "submit", text: "커밋 정보 저장" }),
  ]);

  card.append(status, internalTokenForm, externalTokenForm, identityForm);
  return card;
}

// 시크릿: write-only named secrets (e.g. SSH_PRIVATE_KEY) encrypted at rest.
// Values are injected ONLY into the avatar's MCP tool subprocesses as env, so
// the avatar can use them (e.g. ssh into your servers) without ever seeing the
// raw value, and they're never returned to the client. We only know the NAMES
// that are set (u.secretNames). The avatar uses ITS OWNER's secrets regardless
// of who is chatting with it.
const SECRET_PRESETS = [
  {
    name: "SSH_PRIVATE_KEY",
    label: "SSH 개인키",
    description: "원격 SSH 도구가 사용할 OpenSSH/PEM 개인키입니다. 앱에서 키를 생성하면 자동으로 채워집니다.",
    placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    rows: 4,
  },
  {
    name: "CONFLUENCE_PAT",
    label: "Confluence PAT",
    description: "사내 Confluence 공용 도구가 Bearer 인증에 사용할 Personal Access Token입니다.",
    placeholder: "Confluence personal access token",
    rows: 2,
  },
];

export function buildSecretsCard() {
  const card = el("section", { class: "settings-card" });
  card.append(
    el("div", { class: "panel-section-head" }, [
      el("div", {}, [
        el("h3", { text: "시크릿" }),
        el("p", { class: "muted", text: "내 아바타가 도구를 쓸 때만 주입되는 비밀값입니다. 암호화되어 저장되고 아바타에게도 값 자체는 보이지 않으며, 다시 표시되지 않습니다." }),
      ]),
    ]),
  );

  const presetList = el("div", { class: "secret-preset-list" });

  const saveSecret = async (name, value) => {
    const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    state.user = user;
    renderPresetList();
    renderList();
    renderPublicKey();
  };

  const deleteSecret = async (name) => {
    const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.user = user;
    renderPresetList();
    renderList();
    renderPublicKey();
  };

  const renderPresetList = () => {
    const names = new Set(state.user.secretNames || []);
    presetList.replaceChildren(
      ...SECRET_PRESETS.map((preset) => {
        const isSet = names.has(preset.name);
        const valueField = el("textarea", {
          name: "value",
          rows: String(preset.rows),
          placeholder: preset.placeholder,
          autocomplete: "off",
          required: "",
        });
        const saveBtn = el("button", { class: "primary", type: "submit", text: isSet ? "교체" : "저장" });
        const clearBtn = el("button", {
          class: "linkish small",
          type: "button",
          text: "삭제",
          disabled: isSet ? null : "",
          onclick: async () => {
            if (!window.confirm(`${preset.label} 시크릿을 삭제할까요?`)) return;
            const formEl = clearBtn.closest("form");
            const saved = clearBtn.textContent;
            setFormBusy(formEl, true);
            clearBtn.textContent = "삭제 중…";
            try {
              await deleteSecret(preset.name);
              notify(`${preset.label} 시크릿을 삭제했습니다.`, "ok");
            } catch (err) {
              notify(`삭제 실패: ${err.message}`);
              clearBtn.textContent = saved;
              setFormBusy(formEl, false);
            }
          },
        });
        const form = el("form", {
          class: "secret-preset-row",
          onsubmit: async (e) => {
            e.preventDefault();
            const formEl = e.currentTarget;
            const value = valueField.value;
            if (!value) {
              notify(`${preset.label} 값을 입력해 주세요.`, "warn");
              return;
            }
            const saved = saveBtn.textContent;
            setFormBusy(formEl, true);
            saveBtn.textContent = "저장 중…";
            try {
              await saveSecret(preset.name, value);
              notify(`${preset.label} 시크릿을 저장했습니다.`, "ok");
            } catch (err) {
              notify(`저장 실패: ${err.message}`);
              saveBtn.textContent = saved;
              setFormBusy(formEl, false);
            }
          },
        }, [
          el("div", { class: "secret-preset-meta" }, [
            el("div", { class: "secret-preset-title" }, [
              el("strong", { text: preset.label }),
              el("code", { text: preset.name }),
              isSet ? el("span", { class: "muted token-set", text: "● 설정됨" }) : el("span", { class: "muted", text: "미설정" }),
            ]),
            el("p", { class: "muted", text: preset.description }),
          ]),
          valueField,
          el("div", { class: "secret-preset-actions" }, [saveBtn, clearBtn]),
        ]);
        return form;
      }),
    );
  };
  renderPresetList();

  // List of currently-set secret names, each with a delete button.
  const list = el("div", { class: "secret-list" });
  let extraSecretNameInput;
  const focusExtraSecretForm = () => extraSecretNameInput?.focus();
  const renderList = () => {
    const presetNames = new Set(SECRET_PRESETS.map((preset) => preset.name));
    const names = (state.user.secretNames || []).filter((name) => !presetNames.has(name));
    if (!names.length) {
      list.replaceChildren(
        el("div", { class: "empty-note" }, [
          "추가 시크릿이 없습니다.\n",
          el("button", { class: "linkish small", type: "button", text: "시크릿 이름 입력", onclick: focusExtraSecretForm }),
        ]),
      );
      return;
    }
    list.replaceChildren(
      ...names.map((name) => {
        const delBtn = el("button", {
          class: "linkish small",
          type: "button",
          text: "삭제",
          "aria-label": `시크릿 삭제: ${name}`,
        });
        delBtn.addEventListener("click", async () => {
          if (!window.confirm(`시크릿 "${name}"을(를) 삭제할까요?`)) return;
          const saved = delBtn.textContent;
          delBtn.disabled = true;
          delBtn.textContent = "삭제 중…";
          try {
            await deleteSecret(name);
            notify(`시크릿 "${name}"을(를) 삭제했습니다.`, "ok");
          } catch (err) {
            notify(`삭제 실패: ${err.message}`);
            delBtn.disabled = false;
            delBtn.textContent = saved;
          }
        });
        return el("div", { class: "secret-row" }, [
          el("code", { text: name }),
          el("span", { class: "muted token-set", text: "● 설정됨" }),
          delBtn,
        ]);
      }),
    );
  };
  renderList();

  const publicKeyBox = el("div", { class: "ssh-public-key-box" });
  const renderPublicKey = () => {
    const publicKey = (state.user.sshPublicKey || "").trim();
    if (!publicKey) {
      publicKeyBox.replaceChildren();
      publicKeyBox.hidden = true;
      return;
    }
    publicKeyBox.hidden = false;
    publicKeyBox.replaceChildren(buildSshPublicKeyField(publicKey));
  };
  renderPublicKey();

  // Add/update form: an env-style NAME plus a (multiline-capable) value.
  const form = el("form", {
    class: "settings-form",
    onsubmit: async (e) => {
      e.preventDefault();
      const formEl = e.currentTarget;
      const fd = new FormData(formEl);
      const name = (fd.get("name") || "").toString().trim();
      const value = (fd.get("value") || "").toString();
      if (!name || !value) {
        notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
        return;
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        notify("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다. 예: SSH_PRIVATE_KEY", "warn");
        return;
      }
      const btn = formEl.querySelector("button[type=submit]");
      const saved = btn.textContent;
      setFormBusy(formEl, true);
      btn.textContent = "저장 중…";
      try {
        const { user } = await api(`/api/me/secrets/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify({ value }),
        });
        state.user = user;
        formEl.reset();
        renderPresetList();
        renderList();
        renderPublicKey();
        btn.textContent = "저장됨 ✓";
        notify(`시크릿 "${name}"을(를) 저장했습니다.`, "ok");
        setTimeout(() => { btn.textContent = saved; setFormBusy(formEl, false); }, 1200);
      } catch (err) {
        notify(`저장 실패: ${err.message}`);
        btn.textContent = saved;
        setFormBusy(formEl, false);
      }
    },
  }, [
    el("label", { class: "field" }, [
      el("span", { text: "이름" }),
      extraSecretNameInput = el("input", { name: "name", placeholder: "SSH_PRIVATE_KEY", autocomplete: "off", required: "" }),
    ]),
    el("label", { class: "field" }, [
      el("span", { text: "값" }),
      el("textarea", { name: "value", rows: "4", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----…", autocomplete: "off", required: "" }),
    ]),
    el("button", { class: "primary", type: "submit", text: "추가 시크릿 저장" }),
  ]);

  card.append(
    presetList,
    publicKeyBox,
    el("div", { class: "secret-extra-head" }, [
      el("strong", { text: "기타 시크릿" }),
      el("p", { class: "muted", text: "도구가 추가로 요구하는 환경변수 이름이 있으면 직접 등록하세요." }),
    ]),
    list,
    form,
  );
  return card;
}
