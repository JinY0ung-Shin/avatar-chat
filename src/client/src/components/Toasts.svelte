<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import { dismissToast, pauseToast, resumeToast, toasts } from "../lib/state";
  import { quartOut } from "svelte/easing";
  import { fly } from "svelte/transition";
  import { prefersReducedMotion } from "../lib/motion";

  type PauseReason = "pointer" | "focus" | "document";
  const pauseReasons = new Map<string, Set<PauseReason>>();

  // quartOut is the svelte/easing curve closest to the CSS `--ease-out`
  // (cubic-bezier(0.16, 1, 0.3, 1)); 240ms is the top of the DESIGN §2.5 range.
  function toastIn() {
    return { y: prefersReducedMotion() ? 0 : 14, duration: prefersReducedMotion() ? 120 : 240, easing: quartOut };
  }

  function toastOut() {
    return { y: prefersReducedMotion() ? 0 : 10, duration: prefersReducedMotion() ? 100 : 180, easing: quartOut };
  }

  function setPaused(id: string, reason: PauseReason, paused: boolean): void {
    const reasons = pauseReasons.get(id) ?? new Set<PauseReason>();
    if (paused) reasons.add(reason);
    else reasons.delete(reason);
    if (reasons.size) {
      pauseReasons.set(id, reasons);
      pauseToast(id);
    } else {
      pauseReasons.delete(id);
      resumeToast(id);
    }
  }

  function onFocusOut(id: string, event: FocusEvent): void {
    const toast = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && toast.contains(event.relatedTarget)) return;
    setPaused(id, "focus", false);
  }

  // One source of truth: the `$toasts` auto-subscription (used by the template)
  // drives this reactive block on every toast-set change — GC the pause-reason
  // map for gone toasts AND pause any current toast while the tab is hidden. A
  // second manual `toasts.subscribe` here was redundant (setPaused is idempotent).
  $: {
    const ids = new Set($toasts.map((toast) => toast.id));
    for (const id of [...pauseReasons.keys()]) {
      if (!ids.has(id)) pauseReasons.delete(id);
    }
    for (const toast of $toasts) setPaused(toast.id, "document", document.hidden);
  }

  onMount(() => {
    // `document.hidden` is not reactive, so a visibility change with an unchanged
    // toast set won't re-run the block above — handle it here.
    const syncVisibility = () => {
      for (const toast of $toasts) setPaused(toast.id, "document", document.hidden);
    };
    document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  });
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
      on:pointerenter={() => setPaused(toast.id, "pointer", true)}
      on:pointerleave={() => setPaused(toast.id, "pointer", false)}
      on:focusin={() => setPaused(toast.id, "focus", true)}
      on:focusout={(event) => onFocusOut(toast.id, event)}
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
      <button type="button" class="toast-close" aria-label="알림 닫기" on:click={() => dismissToast(toast.id)}><Icon name="close" size={14} /></button>
    </div>
  {/each}
</div>
