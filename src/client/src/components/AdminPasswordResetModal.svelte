<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { notify } from "../lib/state";
  import type { AdminUserSummary } from "../lib/types";

  export let user: AdminUserSummary;

  const dispatch = createEventDispatcher<{ close: void; done: void }>();
  const VALIDATION_ERRORS = new Set(["비밀번호는 8자 이상이어야 합니다.", "두 비밀번호가 일치하지 않습니다."]);

  let password = "";
  let confirmPassword = "";
  let errorMessage = "";
  let busy = false;

  $: userIdBase = user.id.replace(/[^A-Za-z0-9_-]/g, "-");
  $: titleId = `admin-password-reset-${userIdBase}-title`;
  $: descId = `admin-password-reset-${userIdBase}-desc`;
  $: statusId = `admin-password-reset-${userIdBase}-status`;
  $: errorId = `admin-password-reset-${userIdBase}-error`;
  $: passwordReady = password.length >= 8;
  $: passwordsMatch = Boolean(password && confirmPassword && password === confirmPassword);
  $: canSubmit = Boolean(!busy && passwordReady && passwordsMatch);
  $: passwordInvalid = Boolean(password && !passwordReady) || errorMessage === "비밀번호는 8자 이상이어야 합니다.";
  $: confirmInvalid = Boolean(confirmPassword && !passwordsMatch) || errorMessage === "두 비밀번호가 일치하지 않습니다.";
  $: inputDescribedBy = errorMessage ? `${statusId} ${errorId}` : statusId;
  $: passwordStatus = busy
    ? "재설정 중…"
    : !password
      ? "새 비밀번호를 입력해 주세요."
      : !passwordReady
        ? "비밀번호는 8자 이상이어야 합니다."
        : !confirmPassword
          ? "확인 비밀번호를 입력해 주세요."
          : !passwordsMatch
            ? "두 비밀번호가 일치하지 않습니다."
            : "재설정할 준비가 됐습니다.";
  $: if (errorMessage && VALIDATION_ERRORS.has(errorMessage) && canSubmit) errorMessage = "";

  async function submit() {
    if (busy) return;
    if (password.length < 8) {
      errorMessage = "비밀번호는 8자 이상이어야 합니다.";
      return;
    }
    if (password !== confirmPassword) {
      errorMessage = "두 비밀번호가 일치하지 않습니다.";
      return;
    }
    errorMessage = "";
    busy = true;
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}/password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      notify("비밀번호를 재설정했습니다.", "ok");
      dispatch("done");
      dispatch("close");
    } catch (err) {
      busy = false;
      errorMessage = `재설정 실패: ${(err as Error).message}`;
    }
  }
</script>

<Modal
  cardClass="password-reset-card"
  ariaLabelledby={titleId}
  ariaDescribedby={descId}
  closeDisabled={busy}
  on:close={() => dispatch("close")}
>
  <h2 id={titleId}>비밀번호 재설정</h2>
  <p class="muted" id={descId}>저장하면 이 사용자의 기존 세션이 모두 로그아웃됩니다.</p>
  <form
    class="routine-modal-form"
    on:submit|preventDefault={submit}
  >
    <label class="field">
      <span>새 비밀번호</span>
      <RevealableInput
        bind:value={password}
        name="password"
        autocomplete="new-password"
        placeholder="새 비밀번호"
        ariaLabel={`${user.displayName} 새 비밀번호`}
        ariaDescribedby={inputDescribedBy}
        ariaInvalid={passwordInvalid}
        revealLabel="비밀번호"
        disabled={busy}
      />
    </label>
    <label class="field">
      <span>새 비밀번호 확인</span>
      <RevealableInput
        bind:value={confirmPassword}
        name="confirmPassword"
        autocomplete="new-password"
        placeholder="새 비밀번호 확인"
        ariaLabel={`${user.displayName} 새 비밀번호 확인`}
        ariaDescribedby={inputDescribedBy}
        ariaInvalid={confirmInvalid}
        revealLabel="비밀번호"
        disabled={busy}
      />
    </label>
    {#if errorMessage}
      <div class="error" id={errorId} role="alert">{errorMessage}</div>
    {/if}
    <div
      class="routine-form-status"
      id={statusId}
      class:invalid={Boolean(errorMessage || passwordInvalid || confirmInvalid)}
      class:dirty={canSubmit}
      class:pending={busy}
      role="status"
      aria-live="polite"
    >{passwordStatus}</div>
    <div class="routine-modal-actions">
      <div class="routine-modal-actions-left">
        <span class="muted">대상: {user.displayName} (@{user.username})</span>
      </div>
      <div class="routine-modal-actions-right">
        <button class="ghost-sm" type="button" disabled={busy} on:click={() => dispatch("close")}>취소</button>
        <button class="primary" type="submit" disabled={!canSubmit}>{busy ? "재설정 중…" : "재설정"}</button>
      </div>
    </div>
  </form>
</Modal>
