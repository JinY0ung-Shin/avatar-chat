<script lang="ts">
  import { dismissToast, toasts } from "../lib/state";
</script>

<div class="notify-wrap" aria-live="polite" aria-atomic="false">
  {#each $toasts as toast (toast.id)}
    <div class={`toast ${toast.kind}`} role="status">
      <span>{toast.message}</span>
      {#if toast.action && toast.actionLabel}
        <button
          type="button"
          class="linkish small"
          on:click={() => {
            toast.action?.();
            dismissToast(toast.id);
          }}
        >
          {toast.actionLabel}
        </button>
      {/if}
      <button type="button" class="toast-close" aria-label="알림 닫기" on:click={() => dismissToast(toast.id)}>×</button>
    </div>
  {/each}
</div>
