<script lang="ts">
  import { dismissToast, toasts } from "../lib/state";
  import { cubicIn, cubicOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { prefersReducedMotion } from "../lib/motion";

  function toastIn() {
    return { y: prefersReducedMotion() ? 0 : 14, duration: prefersReducedMotion() ? 120 : 260, easing: cubicOut };
  }

  function toastOut() {
    return { y: prefersReducedMotion() ? 0 : 10, duration: prefersReducedMotion() ? 100 : 180, easing: cubicIn };
  }
</script>

<div class="toast-wrap" aria-atomic="false">
  {#each $toasts as toast (toast.id)}
    {@const urgent = toast.kind === "warn"}
    <div
      class={`toast ${toast.kind}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      in:fly={toastIn()}
      out:fly={toastOut()}
    >
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
