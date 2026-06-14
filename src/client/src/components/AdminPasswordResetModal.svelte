<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Modal from "./Modal.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { notify } from "../lib/state";
  import type { AdminUserSummary } from "../lib/types";

  export let user: AdminUserSummary;

  const dispatch = createEventDispatcher<{ close: void; done: void }>();

  let password = "";
  let confirmPassword = "";
  let errorMessage = "";
  let busy = false;

  async function submit() {
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

<Modal cardClass="password-reset-card" ariaLabelledby="admin-password-reset-title" on:close={() => dispatch("close")}>
  <h2 id="admin-password-reset-title">비밀번호 재설정</h2>
  <p class="muted">저장하면 이 사용자의 기존 세션이 모두 로그아웃됩니다.</p>
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
        revealLabel="비밀번호"
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
        revealLabel="비밀번호"
      />
    </label>
    {#if errorMessage}
      <div class="error" role="alert">{errorMessage}</div>
    {/if}
    <div class="routine-modal-actions">
      <div class="routine-modal-actions-left">
        <span class="muted">대상: {user.displayName} (@{user.username})</span>
      </div>
      <div class="routine-modal-actions-right">
        <button class="ghost-sm" type="button" disabled={busy} on:click={() => dispatch("close")}>취소</button>
        <button class="primary" type="submit" disabled={busy}>{busy ? "재설정 중…" : "재설정"}</button>
      </div>
    </div>
  </form>
</Modal>
