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

  $: isSetup = Boolean(bootstrap?.needsSetup);
  $: signupAllowed = isSetup || bootstrap?.signupMode === "open" || bootstrap?.signupMode === "approval";
  $: if (isSetup) mode = "signup";
  $: isLogin = mode === "login";
  $: heading = isSetup ? "관리자 계정 만들기" : isLogin ? "다시 오신 것을 환영합니다" : "Noah Almighty 시작하기";
  $: description = isSetup
    ? "서비스를 처음 시작합니다. 여기서 만드는 첫 계정이 관리자(admin)가 됩니다."
    : "나만의 아바타를 만들고, 다른 사람의 아바타와 대화하세요.";
  $: submitLabel = busy ? (isLogin ? "로그인 중…" : isSetup ? "계정 만드는 중…" : "가입 중…") : isLogin ? "로그인" : isSetup ? "관리자 계정 만들기" : "회원가입";

  async function submit() {
    error = "";
    pending = false;
    busy = true;
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const payload = mode === "login" ? { username, password } : { username, displayName, password };
      const result = await api<{ user?: User; pending?: boolean }>(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (result.pending) {
        pending = true;
        notify("가입 요청이 접수되었습니다. 관리자가 승인하면 로그인할 수 있습니다.", "info");
        mode = "login";
        return;
      }
      if (result.user) {
        replaceState({ user: result.user, view: "explore" });
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

    <form class="form-stack" on:submit|preventDefault={submit} aria-busy={busy ? "true" : "false"}>
      <label class="field">
        <span>사용자명</span>
        <input name="username" autocomplete="username" placeholder="user123" bind:value={username} required minlength="3" />
      </label>

      {#if mode === "signup"}
        <label class="field">
          <span>표시 이름</span>
          <input name="displayName" autocomplete="nickname" bind:value={displayName} placeholder="홍길동" />
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
            required
            minlength="8"
          />
          <button
            class="password-toggle"
            type="button"
            aria-label={passwordVisible ? "비밀번호 숨기기" : "비밀번호 보기"}
            title={passwordVisible ? "비밀번호 숨기기" : "비밀번호 보기"}
            on:click={() => (passwordVisible = !passwordVisible)}
          >
            <Icon name={passwordVisible ? "eye-off" : "eye"} />
          </button>
        </div>
      </label>

      <button class="primary" type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>

    {#if !isSetup}
      <div class="auth-switch">
        {#if mode === "login" && signupAllowed}
          <button type="button" class="linkish" on:click={() => (mode = "signup")}>
            {bootstrap?.signupMode === "approval" ? "가입 승인 요청" : "회원가입"}
          </button>
        {:else if mode === "signup"}
          <button type="button" class="linkish" on:click={() => (mode = "login")}>로그인</button>
        {:else if bootstrap?.signupMode === "closed"}
          <span class="muted">현재 회원가입을 받지 않습니다.</span>
        {/if}
      </div>
    {/if}
  </section>
</main>
