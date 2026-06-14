<script lang="ts">
  import Icon from "./Icon.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { appState, notify, readState, replaceState } from "../lib/state";
  import { copyText } from "../lib/dom";
  import type { User } from "../lib/types";

  export let active = false;

  const INTERNAL_GIT_TOKEN = "GIT_TOKEN";
  const EXTERNAL_GIT_TOKEN = "GITHUB_TOKEN";

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

  // preset secrets value inputs (keyed by name)
  let presetValues: Record<string, string> = {};
  let presetBusy: Record<string, boolean> = {};

  // arbitrary secret form
  let extraName = "";
  let extraValue = "";
  let extraBusy = false;

  let sshBusy = false;

  $: user = $appState.user;
  $: internalSet = Boolean(user?.gitTokenSet);
  $: externalSet = Boolean(user?.secretNames.includes(EXTERNAL_GIT_TOKEN));
  $: githubHost = $appState.bootstrap?.githubHost || "github.com";
  $: presetNames = new Set(SECRET_PRESETS.map((p) => p.name));
  $: extraSecretNames = (user?.secretNames || []).filter((n) => !presetNames.has(n));

  // ---- git tokens ----
  async function saveInternalToken(): Promise<void> {
    const token = internalToken.trim();
    if (!token) return;
    internalBusy = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
      replaceState({ user: next });
      internalToken = "";
      notify("사내 Git 토큰을 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      internalBusy = false;
    }
  }
  async function clearInternalToken(): Promise<void> {
    if (!window.confirm("사내 Git 토큰을 삭제할까요?")) return;
    internalBusy = true;
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
    const token = externalToken.trim();
    if (!token) return;
    externalBusy = true;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${EXTERNAL_GIT_TOKEN}`, { method: "PUT", body: JSON.stringify({ value: token }) });
      replaceState({ user: next });
      externalToken = "";
      notify("외부 GitHub 토큰을 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      externalBusy = false;
    }
  }
  async function clearExternalToken(): Promise<void> {
    if (!window.confirm("외부 GitHub 토큰을 삭제할까요?")) return;
    externalBusy = true;
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

  async function saveGitIdentity(): Promise<void> {
    identitySaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/git-identity", {
        method: "PUT",
        body: JSON.stringify({ name: gitIdentityName || null, email: gitIdentityEmail || null }),
      });
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
    const value = presetValues[name] || "";
    if (!value) {
      notify(`${label} 값을 입력해 주세요.`, "warn");
      return;
    }
    presetBusy = { ...presetBusy, [name]: true };
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value }) });
      replaceState({ user: next });
      presetValues = { ...presetValues, [name]: "" };
      notify(`${label} 시크릿을 저장했습니다.`, "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      presetBusy = { ...presetBusy, [name]: false };
    }
  }
  async function clearPresetSecret(name: string, label: string): Promise<void> {
    if (!window.confirm(`${label} 시크릿을 삭제할까요?`)) return;
    presetBusy = { ...presetBusy, [name]: true };
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
    const name = extraName.trim();
    const value = extraValue;
    if (!name || !value) {
      notify("시크릿 이름과 값을 모두 입력해 주세요.", "warn");
      return;
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
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
      notify(`저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      extraBusy = false;
    }
  }
  async function deleteExtraSecret(name: string): Promise<void> {
    if (!window.confirm(`시크릿 "${name}"을(를) 삭제할까요?`)) return;
    try {
      const { user: next } = await api<{ user: User }>(`/api/me/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      replaceState({ user: next });
      notify(`시크릿 "${name}"을(를) 삭제했습니다.`, "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function generateSshKey(): Promise<void> {
    sshBusy = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
      replaceState({ user: next });
      notify("SSH 키를 생성했습니다.", "ok");
    } catch (err) {
      notify(`SSH 키 생성 실패: ${(err as Error).message}`, "warn");
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

    <form class="secret-preset-row" on:submit|preventDefault={saveInternalToken}>
      <div class="secret-preset-meta">
        <div class="secret-preset-title">
          <strong>사내 Git 토큰</strong>
          <code>{INTERNAL_GIT_TOKEN}</code>
          <span class={internalSet ? "muted token-set" : "muted"}>{internalSet ? "● 설정됨" : "미설정"}</span>
        </div>
        <p class="muted">사내 GitHub({githubHost}) 전용입니다. 지식 저장소 생성·푸시와 사내 비공개 저장소 접근에 사용됩니다.</p>
      </div>
      <RevealableInput bind:value={internalToken} name="internalToken" placeholder="사내 GitHub PAT (GIT_TOKEN)" ariaLabel="사내 Git 토큰 GIT_TOKEN" revealLabel="토큰" />
      <div class="secret-preset-actions">
        <button class="primary" type="submit" disabled={internalBusy || !internalToken.trim()}>{internalSet ? "교체" : "저장"}</button>
        <button class="linkish small" type="button" disabled={!internalSet || internalBusy} on:click={clearInternalToken}>삭제</button>
      </div>
    </form>

    <form class="secret-preset-row" on:submit|preventDefault={saveExternalToken}>
      <div class="secret-preset-meta">
        <div class="secret-preset-title">
          <strong>외부 GitHub 토큰</strong>
          <code>{EXTERNAL_GIT_TOKEN}</code>
          <span class={externalSet ? "muted token-set" : "muted"}>{externalSet ? "● 설정됨" : "미설정"}</span>
        </div>
        <p class="muted">github.com HTTPS 저장소 접근 전용입니다. 지식 저장소 생성·푸시에는 사용되지 않습니다.</p>
      </div>
      <RevealableInput bind:value={externalToken} name="externalToken" placeholder="github.com PAT (GITHUB_TOKEN)" ariaLabel="외부 GitHub 토큰 GITHUB_TOKEN" revealLabel="토큰" />
      <div class="secret-preset-actions">
        <button class="primary" type="submit" disabled={externalBusy || !externalToken.trim()}>{externalSet ? "교체" : "저장"}</button>
        <button class="linkish small" type="button" disabled={!externalSet || externalBusy} on:click={clearExternalToken}>삭제</button>
      </div>
    </form>

    <form class="settings-form" on:submit|preventDefault={saveGitIdentity}>
      <div class="field-row-2col">
        <label class="field"><span>커밋 이름</span><input bind:value={gitIdentityName} placeholder={user.alias || user.displayName || ""} /></label>
        <label class="field"><span>커밋 이메일</span><input type="email" bind:value={gitIdentityEmail} placeholder={`${user.username}@example.com`} /></label>
      </div>
      <button class="primary" type="submit" disabled={identitySaving}>{identitySaving ? "저장 중…" : "커밋 정보 저장"}</button>
    </form>
  </section>

  <!-- 시크릿 -->
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>시크릿</h3>
        <p class="muted">내 아바타가 도구를 쓸 때만 주입되는 비밀값입니다. 암호화되어 저장되고 아바타에게도 값 자체는 보이지 않으며, 다시 표시되지 않습니다.</p>
      </div>
    </div>

    <div class="secret-preset-list">
      {#each SECRET_PRESETS as preset}
        {@const isSet = user.secretNames.includes(preset.name)}
        <form class="secret-preset-row" on:submit|preventDefault={() => savePresetSecret(preset.name, preset.label)}>
          <div class="secret-preset-meta">
            <div class="secret-preset-title">
              <strong>{preset.label}</strong>
              <code>{preset.name}</code>
              {#if isSet}<span class="muted token-set">● 설정됨</span>{:else}<span class="muted">미설정</span>{/if}
            </div>
            <p class="muted">{preset.description}</p>
          </div>
          <textarea rows={preset.rows} placeholder={preset.placeholder} autocomplete="off" bind:value={presetValues[preset.name]}></textarea>
          <div class="secret-preset-actions">
            <button class="primary" type="submit" disabled={presetBusy[preset.name] || !presetValues[preset.name]}>{isSet ? "교체" : "저장"}</button>
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
      <button class="primary" type="button" disabled={sshBusy} on:click={generateSshKey}>{sshBusy ? "생성 중…" : "SSH 키 생성"}</button>
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
            <button class="linkish small" type="button" aria-label={`시크릿 삭제: ${name}`} on:click={() => deleteExtraSecret(name)}>삭제</button>
          </div>
        {/each}
      {/if}
    </div>
    <form class="settings-form" on:submit|preventDefault={saveExtraSecret}>
      <label class="field"><span>이름</span><input bind:value={extraName} placeholder="SSH_PRIVATE_KEY" autocomplete="off" /></label>
      <label class="field"><span>값</span><textarea rows="4" bind:value={extraValue} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----…" autocomplete="off"></textarea></label>
      <button class="primary" type="submit" disabled={extraBusy}>{extraBusy ? "저장 중…" : "추가 시크릿 저장"}</button>
    </form>
  </section>
{/if}
