<script lang="ts">
  import Icon from "./Icon.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { appState, notify, readState, replaceState } from "../lib/state";
  import { copyText } from "../lib/dom";
  import { EXPERIMENTAL_FEATURES } from "../../../server/experimentalFeatures";
  import { isShellExposableSecret } from "../../../server/secretPolicy";
  import type { User } from "../lib/types";

  export let active = false;

  const INTERNAL_GIT_TOKEN = "GIT_TOKEN";
  const EXTERNAL_GIT_TOKEN = "GITHUB_TOKEN";
  const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

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

  const u0 = readState().user;

  // git identity
  let gitIdentityName = u0?.gitIdentityName || "";
  let gitIdentityEmail = u0?.gitIdentityEmail || "";
  let identitySaving = false;

  // git token forms
  let internalToken = "";
  let externalToken = "";
  let internalBusy = false;
  let externalBusy = false;
  let internalError = "";
  let externalError = "";

  // preset secrets value inputs (keyed by name)
  let presetValues: Record<string, string> = {};
  let presetBusy: Record<string, boolean> = {};
  let presetErrors: Record<string, string> = {};

  // arbitrary secret form
  let extraName = "";
  let extraValue = "";
  let extraBusy = false;
  let extraError = "";
  let extraDeleting: Record<string, boolean> = {};

  let sshBusy = false;
  let sshError = "";
  let sshMessage = "";

  // experimental features (#50)
  let experimentalBusy = "";

  // per-secret agent-shell exposure toggle
  let shellExposeBusy = "";

  async function toggleShellExpose(name: string, on: boolean): Promise<void> {
    if (shellExposeBusy) return;
    shellExposeBusy = name;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ shellExpose: on }),
      });
      replaceState({ user: next });
      notify(
        on
          ? `${name} 시크릿을 에이전트 셸에 노출합니다. 다음 대화부터 명령에서 $${name}으로 쓸 수 있어요.`
          : `${name} 시크릿의 셸 노출을 껐습니다.`,
        "ok",
      );
    } catch (err) {
      notify(`셸 노출 설정 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      shellExposeBusy = "";
    }
  }
  const identityStatusId = "access-git-identity-status";
  const internalStatusId = "access-internal-token-status";
  const externalStatusId = "access-external-token-status";
  const extraStatusId = "access-extra-secret-status";
  const sshStatusId = "access-ssh-key-status";

  $: user = $appState.user;
  $: enabledExperimental = new Set(user?.experimentalFeatures || []);
  $: shellExposed = new Set(user?.shellExposedSecretNames || []);
  $: sshStatus = sshBusy
    ? "SSH 키를 생성하는 중입니다."
    : sshError
      ? `SSH 키 생성 실패: ${sshError}`
      : sshMessage;

  async function toggleExperimental(key: string, on: boolean): Promise<void> {
    const current = new Set(readState().user?.experimentalFeatures || []);
    if (on) current.add(key);
    else current.delete(key);
    experimentalBusy = key;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ experimentalFeatures: [...current] }),
      });
      replaceState({ user: next });
      notify(`실험 기능을 ${on ? "켰습니다" : "껐습니다"}. 다음 대화부터 적용됩니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      experimentalBusy = "";
    }
  }
  $: internalSet = Boolean(user?.gitTokenSet);
  $: externalSet = Boolean(user?.secretNames.includes(EXTERNAL_GIT_TOKEN));
  $: githubHost = $appState.bootstrap?.githubHost || "github.com";
  $: presetNames = new Set(SECRET_PRESETS.map((p) => p.name));
  $: extraSecretNames = (user?.secretNames || []).filter((n) => !presetNames.has(n));
  $: savedGitIdentityName = user?.gitIdentityName || "";
  $: savedGitIdentityEmail = user?.gitIdentityEmail || "";
  $: gitIdentityNameTrimmed = gitIdentityName.trim();
  $: gitIdentityEmailTrimmed = gitIdentityEmail.trim();
  $: identityDirty = Boolean(
    user &&
      (gitIdentityNameTrimmed !== savedGitIdentityName ||
        gitIdentityEmailTrimmed !== savedGitIdentityEmail),
  );
  $: identityStatus = identitySaving
    ? "저장 중…"
    : identityDirty
      ? "저장하지 않은 커밋 정보가 있습니다."
      : savedGitIdentityName || savedGitIdentityEmail
        ? "저장됨"
        : "저장 전";
  $: identityCanSave = Boolean(!identitySaving && identityDirty);
  $: internalStatus = internalBusy
    ? "저장 중…"
    : internalError
      ? `저장 실패: ${internalError}`
      : internalToken.trim()
        ? "저장할 토큰이 입력되었습니다."
        : internalSet
          ? "사내 Git 토큰이 설정되어 있습니다."
          : "사내 Git 토큰이 아직 없습니다.";
  $: externalStatus = externalBusy
    ? "저장 중…"
    : externalError
      ? `저장 실패: ${externalError}`
      : externalToken.trim()
        ? "저장할 토큰이 입력되었습니다."
        : externalSet
          ? "외부 GitHub 토큰이 설정되어 있습니다."
          : "외부 GitHub 토큰이 아직 없습니다.";
  $: extraNameTrimmed = extraName.trim();
  $: extraHasValue = Boolean(extraValue.trim());
  $: extraNameValid = !extraNameTrimmed || SECRET_NAME_PATTERN.test(extraNameTrimmed);
  $: extraCanSave = Boolean(!extraBusy && extraNameTrimmed && extraHasValue && extraNameValid);
  $: extraStatus = extraBusy
    ? "저장 중…"
    : extraError
      ? extraError
      : !extraNameValid
        ? "이름 형식을 확인해 주세요."
        : !extraNameTrimmed && !extraHasValue
          ? "입력 대기"
          : !extraNameTrimmed
            ? "이름을 입력해 주세요."
            : !extraHasValue
              ? "값을 입력해 주세요."
              : "저장할 준비가 됐습니다.";

  function secretDomId(name: string, part: string): string {
    return `access-secret-${name.replace(/[^A-Za-z0-9_-]/g, "-")}-${part}`;
  }
  // Svelte 5 legacy mode compiles template FUNCTION CALLS inside untrack()
  // (preserving Svelte-4 compile-time dependency semantics), so a helper that
  // reads `presetValues` in its BODY never re-ran while typing — the 저장
  // button stayed disabled and the status label stale. Derive the per-preset
  // state up front and have the template read these maps DIRECTLY instead.
  $: presetFilled = Object.fromEntries(
    SECRET_PRESETS.map((p) => [p.name, Boolean(presetValues[p.name]?.trim())]),
  ) as Record<string, boolean>;
  $: presetStatusText = Object.fromEntries(
    SECRET_PRESETS.map((p) => {
      const isSet = Boolean(user?.secretNames.includes(p.name));
      const text = presetBusy[p.name]
        ? "저장 중…"
        : presetErrors[p.name]
          ? `저장 실패: ${presetErrors[p.name]}`
          : presetFilled[p.name]
            ? "저장할 값이 입력되었습니다."
            : isSet
              ? `${p.label} 시크릿이 설정되어 있습니다.`
              : `${p.label} 시크릿이 아직 없습니다.`;
      return [p.name, text];
    }),
  ) as Record<string, string>;
  function clearPresetError(name: string): void {
    if (!presetErrors[name]) return;
    presetErrors = { ...presetErrors, [name]: "" };
  }

  // ---- git tokens ----
  async function saveInternalToken(): Promise<void> {
    if (internalBusy) return;
    const token = internalToken.trim();
    if (!token) return;
    internalBusy = true;
    internalError = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      replaceState({ user: next });
      internalToken = "";
      notify("사내 Git 토큰을 저장했습니다.", "ok");
    } catch (err) {
      internalError = (err as Error).message;
      notify(`저장 실패: ${internalError}`, "warn");
    } finally {
      internalBusy = false;
    }
  }
  async function clearInternalToken(): Promise<void> {
    if (internalBusy) return;
    if (!window.confirm("사내 Git 토큰을 삭제할까요?")) return;
    internalBusy = true;
    internalError = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "DELETE" });
      replaceState({ user: next });
      notify("사내 Git 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      internalBusy = false;
    }
  }
  async function saveExternalToken(): Promise<void> {
    if (externalBusy) return;
    const token = externalToken.trim();
    if (!token) return;
    externalBusy = true;
    externalError = "";
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "PUT", body: JSON.stringify({ value: token }) });
      replaceState({ user: next });
      externalToken = "";
      notify("외부 GitHub 토큰을 저장했습니다.", "ok");
    } catch (err) {
      externalError = (err as Error).message;
      notify(`저장 실패: ${externalError}`, "warn");
    } finally {
      externalBusy = false;
    }
  }
  async function clearExternalToken(): Promise<void> {
    if (externalBusy) return;
    if (!window.confirm("외부 GitHub 토큰을 삭제할까요?")) return;
    externalBusy = true;
    externalError = "";
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "DELETE" });
      replaceState({ user: next });
      notify("외부 GitHub 토큰을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      externalBusy = false;
    }
  }

  function syncGitIdentityForm(next: User): void {
    gitIdentityName = next.gitIdentityName || "";
    gitIdentityEmail = next.gitIdentityEmail || "";
  }

  async function saveGitIdentity(): Promise<void> {
    if (identitySaving || !identityDirty) return;
    identitySaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-identity", {
        method: "PUT",
        body: JSON.stringify({ name: gitIdentityNameTrimmed || null, email: gitIdentityEmailTrimmed || null }),
      });
      syncGitIdentityForm(next);
      replaceState({ user: next });
      notify("커밋 정보를 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      identitySaving = false;
    }
  }

  // ---- secrets ----
  async function savePresetSecret(name: string, label: string): Promise<void> {
    if (presetBusy[name]) return;
    const value = presetValues[name] || "";
    if (!value.trim()) {
      notify(`${label} 값을 입력해 주세요.`, "warn");
      return;
    }
    presetBusy = { ...presetBusy, [name]: true };
    presetErrors = { ...presetErrors, [name]: "" };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      presetValues = { ...presetValues, [name]: "" };
      notify(`${label} 시크릿을 저장했습니다.`, "ok");
    } catch (err) {
      presetErrors = { ...presetErrors, [name]: (err as Error).message };
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      presetBusy = { ...presetBusy, [name]: false };
    }
  }
  async function clearPresetSecret(name: string, label: string): Promise<void> {
    if (presetBusy[name]) return;
    if (!window.confirm(`${label} 시크릿을 삭제할까요?`)) return;
    presetBusy = { ...presetBusy, [name]: true };
    presetErrors = { ...presetErrors, [name]: "" };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`${label} 시크릿을 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      presetBusy = { ...presetBusy, [name]: false };
    }
  }

  async function saveExtraSecret(): Promise<void> {
    if (extraBusy) return;
    const name = extraNameTrimmed;
    const value = extraValue;
    extraError = "";
    if (!name || !value.trim()) {
      extraError = "시크릿 이름과 값을 모두 입력해 주세요.";
      notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
      return;
    }
    if (!SECRET_NAME_PATTERN.test(name)) {
      extraError = "이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다.";
      notify("이름은 대문자/숫자/밑줄(환경변수 형식)이어야 합니다. 예: SSH_PRIVATE_KEY", "warn");
      return;
    }
    extraBusy = true;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      extraName = "";
      extraValue = "";
      notify(`시크릿 "${name}"을(를) 저장했습니다.`, "ok");
    } catch (err) {
      extraError = `저장 실패: ${(err as Error).message}`;
      notify(extraError, "warn");
    } finally {
      extraBusy = false;
    }
  }
  async function deleteExtraSecret(name: string): Promise<void> {
    if (extraDeleting[name]) return;
    if (!window.confirm(`시크릿 "${name}"을(를) 삭제할까요?`)) return;
    extraDeleting = { ...extraDeleting, [name]: true };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`시크릿 "${name}"을(를) 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      extraDeleting = { ...extraDeleting, [name]: false };
    }
  }

  async function generateSshKey(): Promise<void> {
    if (sshBusy) return;
    sshBusy = true;
    sshError = "";
    sshMessage = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
      replaceState({ user: next });
      sshMessage = "SSH 키를 생성했습니다.";
      notify(sshMessage, "ok");
    } catch (err) {
      sshError = (err as Error).message;
      notify(`SSH 키 생성 실패: ${sshError}`, "warn");
    } finally {
      sshBusy = false;
    }
  }

  function copySshKey(event: MouseEvent): void {
    const btn = event.currentTarget as HTMLButtonElement;
    void copyText(user?.sshPublicKey || "", btn);
  }
</script>

{#if active && user}
  <!-- 실험 기능 (#50) -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>실험 기능</h3>
        <p class="muted">아직 다듬는 중인 베타 기능입니다. 기능마다 켜고 끌 수 있으며, 동작이 바뀔 수 있어요. 아바타도 어떤 실험 기능이 켜져 있는지 인지합니다.</p>
      </div>
    </div>
    <div class="experimental-list">
      {#each EXPERIMENTAL_FEATURES as feature (feature.key)}
        <label class="experimental-item">
          <input
            type="checkbox"
            checked={enabledExperimental.has(feature.key)}
            disabled={experimentalBusy === feature.key}
            on:change={(event) => toggleExperimental(feature.key, event.currentTarget.checked)}
          />
          <span class="experimental-meta">
            <strong>{feature.name} <span class="experimental-badge">실험</span></strong>
            <span class="muted">{feature.description}</span>
          </span>
        </label>
      {/each}
    </div>
  </section>

  <!-- Git 자격증명 -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>Git 자격증명</h3>
        <p class="muted">사내 GitHub와 외부 github.com 토큰을 분리해 저장합니다. 값은 암호화되어 저장되며 다시 표시되지 않습니다.</p>
      </div>
    </div>
    <div class="git-token-status muted">
      {#if internalSet}<span class="token-set">● 사내 Git (GIT_TOKEN) 설정됨</span>{:else}<span>사내 Git (GIT_TOKEN) 미설정</span>{/if}
      ·
      {#if externalSet}<span class="token-set">외부 GitHub (GITHUB_TOKEN) 설정됨</span>{:else}<span>외부 GitHub (GITHUB_TOKEN) 미설정</span>{/if}
    </div>

    <form class="secret-preset-row" aria-busy={internalBusy} on:submit|preventDefault={saveInternalToken}>
      <div class="secret-preset-meta">
        <div class="secret-preset-title">
          <strong>사내 Git 토큰</strong>
          <code>{INTERNAL_GIT_TOKEN}</code>
          <span class={internalSet ? "muted token-set" : "muted"}>{internalSet ? "● 설정됨" : "미설정"}</span>
        </div>
        <p class="muted">사내 GitHub({githubHost}) 전용입니다. 지식 저장소 생성·푸시와 사내 비공개 저장소 접근에 사용됩니다.</p>
      </div>
      <RevealableInput bind:value={internalToken} name="internalToken" placeholder="사내 GitHub PAT (GIT_TOKEN)" ariaLabel="사내 Git 토큰 GIT_TOKEN" ariaDescribedby={internalStatusId} revealLabel="토큰" disabled={internalBusy} onInput={() => (internalError = "")} />
      <div class="secret-preset-actions">
        <span id={internalStatusId} class="settings-save-status" class:dirty={Boolean(internalError || internalToken.trim())} role="status" aria-live="polite">{internalStatus}</span>
        <button class="primary" type="submit" disabled={internalBusy || !internalToken.trim()}>{internalSet ? "교체" : "저장"}</button>
        <button class="linkish small" type="button" disabled={!internalSet || internalBusy} on:click={clearInternalToken}>삭제</button>
      </div>
    </form>

    <form class="secret-preset-row" aria-busy={externalBusy} on:submit|preventDefault={saveExternalToken}>
      <div class="secret-preset-meta">
        <div class="secret-preset-title">
          <strong>외부 GitHub 토큰</strong>
          <code>{EXTERNAL_GIT_TOKEN}</code>
          <span class={externalSet ? "muted token-set" : "muted"}>{externalSet ? "● 설정됨" : "미설정"}</span>
        </div>
        <p class="muted">github.com HTTPS 저장소 접근 전용입니다. 지식 저장소 생성·푸시에는 사용되지 않습니다.</p>
      </div>
      <RevealableInput bind:value={externalToken} name="externalToken" placeholder="github.com PAT (GITHUB_TOKEN)" ariaLabel="외부 GitHub 토큰 GITHUB_TOKEN" ariaDescribedby={externalStatusId} revealLabel="토큰" disabled={externalBusy} onInput={() => (externalError = "")} />
      <div class="secret-preset-actions">
        <span id={externalStatusId} class="settings-save-status" class:dirty={Boolean(externalError || externalToken.trim())} role="status" aria-live="polite">{externalStatus}</span>
        <button class="primary" type="submit" disabled={externalBusy || !externalToken.trim()}>{externalSet ? "교체" : "저장"}</button>
        <button class="linkish small" type="button" disabled={!externalSet || externalBusy} on:click={clearExternalToken}>삭제</button>
      </div>
    </form>

    <form class="settings-form" on:submit|preventDefault={saveGitIdentity}>
      <div class="field-row-2col">
        <label class="field"><span>커밋 이름</span><input bind:value={gitIdentityName} placeholder={user.alias || user.displayName || ""} aria-describedby={identityStatusId} disabled={identitySaving} /></label>
        <label class="field"><span>커밋 이메일</span><input type="email" bind:value={gitIdentityEmail} placeholder={`${user.username}@example.com`} aria-describedby={identityStatusId} disabled={identitySaving} /></label>
      </div>
      <div class="settings-save-row">
        <span id={identityStatusId} class="settings-save-status" class:dirty={identityDirty} role="status">{identityStatus}</span>
        <button class="primary" type="submit" disabled={!identityCanSave}>{identitySaving ? "저장 중…" : "커밋 정보 저장"}</button>
      </div>
    </form>
  </section>

  <!-- 시크릿 -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>시크릿</h3>
        <p class="muted">내 아바타의 도구에만 주입되는 비밀값입니다. 암호화되어 저장되고 다시 표시되지 않습니다. 직접 등록한 플러그인·지식 저장소의 <code>.mcp.json</code> 커스텀 MCP 서버에는 시크릿이 환경변수로 주입되고(본인 또는 같은 그룹 팀원과의 대화에서만), <strong>셸 노출</strong>을 켠 시크릿은 아바타의 셸(Bash)에서도 <code>$이름</code>으로 쓸 수 있어요 — 도구 출력에 값이 나타나면 자동으로 가려지지만, 노출을 켠 키는 아바타가 사용할 수 있게 된다는 뜻이니 필요한 키만 켜세요. GIT_TOKEN·GITHUB_TOKEN·SSH 계열은 전용 경로로만 쓰이며 셸 노출이 불가하고, 그룹 저장소의 MCP 서버와 일반 사용자와의 대화에는 어떤 시크릿도 주입되지 않습니다.</p>
      </div>
    </div>

    <div class="secret-preset-list">
      {#each SECRET_PRESETS as preset}
        {@const isSet = user.secretNames.includes(preset.name)}
        {@const presetStatusId = secretDomId(preset.name, "status")}
        <form class="secret-preset-row" aria-busy={presetBusy[preset.name]} on:submit|preventDefault={() => savePresetSecret(preset.name, preset.label)}>
          <div class="secret-preset-meta">
            <div class="secret-preset-title">
              <strong>{preset.label}</strong>
              <code>{preset.name}</code>
              {#if isSet}<span class="muted token-set">● 설정됨</span>{:else}<span class="muted">미설정</span>{/if}
            </div>
            <p class="muted">{preset.description}</p>
          </div>
          <textarea
            rows={preset.rows}
            placeholder={preset.placeholder}
            autocomplete="off"
            aria-label={`${preset.label} 값`}
            aria-describedby={presetStatusId}
            aria-invalid={presetErrors[preset.name] ? "true" : undefined}
            bind:value={presetValues[preset.name]}
            disabled={presetBusy[preset.name]}
            on:input={() => clearPresetError(preset.name)}
          ></textarea>
          <div class="secret-preset-actions">
            <span id={presetStatusId} class="settings-save-status" class:dirty={Boolean(presetErrors[preset.name]) || presetFilled[preset.name]} role="status" aria-live="polite">{presetStatusText[preset.name]}</span>
            {#if isSet && isShellExposableSecret(preset.name)}
              <label class="shell-expose-toggle" title="켜면 이 값이 아바타의 셸(Bash) 환경변수로도 주입됩니다 (본인·신뢰 팀원 대화에서만, 도구 출력에서는 자동 가려짐)">
                <input
                  type="checkbox"
                  checked={shellExposed.has(preset.name)}
                  disabled={shellExposeBusy === preset.name}
                  on:change={(event) => toggleShellExpose(preset.name, event.currentTarget.checked)}
                />
                <span class="muted">셸 노출</span>
              </label>
            {/if}
            <button class="primary" type="submit" disabled={presetBusy[preset.name] || !presetFilled[preset.name]}>{isSet ? "교체" : "저장"}</button>
            <button class="linkish small" type="button" disabled={!isSet || presetBusy[preset.name]} on:click={() => clearPresetSecret(preset.name, preset.label)}>삭제</button>
          </div>
        </form>
      {/each}
    </div>

    {#if user.sshPublicKey}
      <div class="ssh-public-key-box">
        <label class="field ssh-public-key-field">
          <span>SSH 공개키</span>
          <div class="ssh-public-key-row">
            <textarea rows="3" readonly value={user.sshPublicKey}></textarea>
            <button class="msg-act" type="button" aria-label="SSH 공개키 복사" title="SSH 공개키 복사" on:click={copySshKey}><Icon name="copy" /></button>
          </div>
        </label>
      </div>
    {:else}
      <button class="primary" type="button" aria-describedby={sshStatus ? sshStatusId : undefined} disabled={sshBusy} on:click={generateSshKey}>{sshBusy ? "생성 중…" : "SSH 키 생성"}</button>
    {/if}
    {#if sshStatus}
      <div class="settings-save-row compact">
        <span id={sshStatusId} class="settings-save-status" class:dirty={Boolean(sshBusy || sshError || sshMessage)} role="status" aria-live="polite">{sshStatus}</span>
      </div>
    {/if}

    <div class="secret-extra-head">
      <strong>기타 시크릿</strong>
      <p class="muted">도구가 추가로 요구하는 환경변수 이름이 있으면 직접 등록하세요.</p>
    </div>
    <div class="secret-list">
      {#if !extraSecretNames.length}
        <div class="empty-note">추가 시크릿이 없습니다.</div>
      {:else}
        {#each extraSecretNames as name (name)}
          <div class="secret-row">
            <code>{name}</code>
            <span class="muted token-set">● 설정됨</span>
            {#if isShellExposableSecret(name)}
              <label class="shell-expose-toggle" title="켜면 이 값이 아바타의 셸(Bash) 환경변수로도 주입됩니다 (본인·신뢰 팀원 대화에서만, 도구 출력에서는 자동 가려짐)">
                <input
                  type="checkbox"
                  checked={shellExposed.has(name)}
                  disabled={shellExposeBusy === name}
                  on:change={(event) => toggleShellExpose(name, event.currentTarget.checked)}
                />
                <span class="muted">셸 노출</span>
              </label>
            {/if}
            <button class="linkish small" type="button" aria-label={`시크릿 삭제: ${name}`} disabled={extraDeleting[name]} on:click={() => deleteExtraSecret(name)}>삭제</button>
          </div>
        {/each}
      {/if}
    </div>
    <form class="settings-form" on:submit|preventDefault={saveExtraSecret}>
      <label class="field"><span>이름</span><input bind:value={extraName} placeholder="SSH_PRIVATE_KEY" autocomplete="off" required aria-describedby={extraStatusId} aria-invalid={extraNameValid ? undefined : "true"} disabled={extraBusy} on:input={() => (extraError = "")} /></label>
      <label class="field"><span>값</span><textarea rows="4" bind:value={extraValue} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…" autocomplete="off" required aria-describedby={extraStatusId} disabled={extraBusy} on:input={() => (extraError = "")}></textarea></label>
      <div class="settings-save-row">
        <span id={extraStatusId} class="settings-save-status" class:dirty={!extraNameValid || Boolean(extraError)} role="status">{extraStatus}</span>
        <button class="primary" type="submit" disabled={!extraCanSave}>{extraBusy ? "저장 중…" : "추가 시크릿 저장"}</button>
      </div>
    </form>
  </section>
{/if}

<style>
  .experimental-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-3, 12px);
  }
  .experimental-item {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2, 8px);
    cursor: pointer;
  }
  .experimental-item input {
    margin-top: 3px;
  }
  .experimental-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .shell-expose-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    white-space: nowrap;
  }
  .experimental-badge {
    font-size: 0.65rem;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--surface-2, #eee);
    font-weight: 600;
    vertical-align: middle;
  }
</style>
