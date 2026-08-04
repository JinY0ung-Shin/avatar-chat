<script lang="ts">
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { replaceState, notify } from "../lib/state";
  import type { BootstrapInfo, User } from "../lib/types";

  export let bootstrap: BootstrapInfo | null;

  let mode: "login" | "signup" = bootstrap?.needsSetup ? "signup" : "login";
  let username = "";
  let displayName = "";
  let password = "";
  let error = "";
  let pending = false;
  let busy = false;
  let passwordVisible = false;
  const usernameIssueId = "auth-username-issue";
  const passwordIssueId = "auth-password-issue";
  const submitStatusId = "auth-submit-status";

  $: isSetup = Boolean(bootstrap?.needsSetup);
  $: signupAllowed = isSetup || bootstrap?.signupMode === "open" || bootstrap?.signupMode === "approval";
  $: if (isSetup) mode = "signup";
  $: isLogin = mode === "login";
  $: usernameTrimmed = username.trim();
  $: displayNameTrimmed = displayName.trim();
  $: usernameIssue = usernameTrimmed.length === 0 ? "사용자명을 입력해 주세요." : usernameTrimmed.length < 3 ? "사용자명은 3자 이상이어야 합니다." : "";
  $: passwordIssue = password.length === 0 ? "비밀번호를 입력해 주세요." : password.length < 8 ? "비밀번호는 8자 이상이어야 합니다." : "";
  $: canSubmit = Boolean(usernameTrimmed.length >= 3 && password.length >= 8 && !busy);
  $: heading = isSetup ? "관리자 계정 만들기" : isLogin ? "다시 오신 것을 환영합니다" : "Noah Almighty 시작하기";
  $: description = isSetup
    ? "서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다."
    : "나만의 아바타를 만들고, 다른 사람의 아바타와 대화하세요.";
  $: submitLabel = busy ? (isLogin ? "로그인 중…" : isSetup ? "계정 만드는 중…" : "가입 중…") : isLogin ? "로그인" : isSetup ? "관리자 계정 만들기" : "회원가입";
  $: submitStatus = busy
    ? isLogin
      ? "로그인 요청을 보내는 중입니다."
      : "계정 요청을 보내는 중입니다."
    : usernameIssue || passwordIssue || (isLogin ? "로그인할 준비가 됐습니다." : isSetup ? "관리자 계정을 만들 준비가 됐습니다." : bootstrap?.signupMode === "approval" ? "승인 요청을 보낼 준비가 됐습니다." : "회원가입할 준비가 됐습니다.");
  $: submitStatusWarn = Boolean(!busy && (usernameIssue || passwordIssue));
  $: usernameDescribedBy = usernameIssue ? `${usernameIssueId} ${submitStatusId}` : submitStatusId;
  $: passwordDescribedBy = passwordIssue ? `${passwordIssueId} ${submitStatusId}` : submitStatusId;

  function setMode(next: "login" | "signup", force = false) {
    if (busy && !force) return;
    mode = next;
    error = "";
    pending = false;
  }

  async function submit() {
    if (!canSubmit) return;
    error = "";
    pending = false;
    busy = true;
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const payload = mode === "login"
        ? { username: usernameTrimmed, password }
        : { username: usernameTrimmed, displayName: displayNameTrimmed, password };
      const result = await api<{ user?: User; pending?: boolean }>(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (result.pending) {
        notify("가입 요청이 접수되었습니다. 관리자가 승인하면 로그인할 수 있으며, 그룹 권한은 승인 후 관리자에게 신청해 주세요.", "info");
        setMode("login", true);
        pending = true;
        return;
      }
      if (result.user) {
        const signedUp = mode === "signup" && !isSetup;
        replaceState({ user: result.user, view: "explore" });
        if (signedUp) {
          notify(
            "회원가입이 완료되었습니다. 그룹 아바타 이용 등 그룹 권한이 필요하면 관리자에게 그룹 추가를 신청해 주세요.",
            "info",
            { durationMs: 9000 },
          );
        }
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main class="auth-view">
  <section class="auth-panel">
    <img class="login-mark" src="/icon-192.png" alt="Noah Almighty" width="48" height="48" />
    {#if isSetup}
      <div class="setup-badge">첫 실행 · 관리자 설정</div>
    {/if}
    <h1>{heading}</h1>
    <p>{description}</p>

    {#if error}
      <div class="error" role="alert">{error}</div>
    {/if}
    {#if pending}
      <p class="muted auth-note" role="status">가입 요청이 승인 대기 상태입니다.</p>
    {:else if mode === "signup" && !isSetup && bootstrap?.signupMode === "approval"}
      <p class="muted auth-note">관리자 승인 후 로그인할 수 있습니다.</p>
    {/if}

    <form class="form-stack" on:submit|preventDefault={submit} aria-busy={busy ? "true" : "false"} aria-describedby={submitStatusId}>
      <label class="field">
        <span>사용자명</span>
        <input name="username" autocomplete="username" placeholder="user123" bind:value={username} aria-describedby={usernameDescribedBy} aria-invalid={Boolean(usernameIssue)} required minlength="3" disabled={busy} />
        {#if usernameIssue}<span id={usernameIssueId} class="field-hint warn">{usernameIssue}</span>{/if}
      </label>

      {#if mode === "signup"}
        <label class="field">
          <span>표시 이름</span>
          <input name="displayName" autocomplete="nickname" bind:value={displayName} placeholder="홍길동" disabled={busy} />
          <span class="field-hint">비워두면 사용자명이 표시됩니다.</span>
        </label>
      {/if}

      <label class="field">
        <span>비밀번호</span>
        <div class="password-field">
          <input
            name="password"
            type={passwordVisible ? "text" : "password"}
            autocomplete={mode === "login" ? "current-password" : "new-password"}
            placeholder={mode === "login" ? "비밀번호" : "8자 이상"}
            bind:value={password}
            aria-describedby={passwordDescribedBy}
            aria-invalid={Boolean(passwordIssue)}
            required
            minlength="8"
            disabled={busy}
          />
          <button
            class="password-toggle"
            type="button"
            disabled={busy}
            aria-label={passwordVisible ? "비밀번호 숨기기" : "비밀번호 보기"}
            title={passwordVisible ? "비밀번호 숨기기" : "비밀번호 보기"}
            on:click={() => (passwordVisible = !passwordVisible)}
          >
            <Icon name={passwordVisible ? "eye-off" : "eye"} />
          </button>
        </div>
        {#if passwordIssue}<span id={passwordIssueId} class="field-hint warn">{passwordIssue}</span>{/if}
      </label>

      <p id={submitStatusId} class:warn={submitStatusWarn} class="auth-submit-status" role="status" aria-live="polite">{submitStatus}</p>

      <button class="primary" type="submit" disabled={!canSubmit}>
        {submitLabel}
      </button>
    </form>

    {#if !isSetup}
      <div class="auth-switch">
        {#if mode === "login" && signupAllowed}
          <button type="button" class="linkish" disabled={busy} on:click={() => setMode("signup")}>
            {bootstrap?.signupMode === "approval" ? "가입 승인 요청" : "회원가입"}
          </button>
        {:else if mode === "signup"}
          <button type="button" class="linkish" disabled={busy} on:click={() => setMode("login")}>로그인</button>
        {:else if bootstrap?.signupMode === "closed"}
          <span class="muted">현재 회원가입을 받지 않습니다.</span>
        {/if}
      </div>
    {/if}
  </section>
</main>
