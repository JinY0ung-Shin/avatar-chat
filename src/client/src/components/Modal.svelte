<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";

  export let cardClass = "";
  export let ariaLabelledby: string | undefined = undefined;
  export let ariaDescribedby: string | undefined = undefined;
  export let closeOnBackdrop = true;
  export let closeDisabled = false;

  const dispatch = createEventDispatcher<{ close: void }>();
  let overlayEl: HTMLDivElement;
  let cardEl: HTMLDivElement;

  function close() {
    if (closeDisabled) return;
    dispatch("close");
  }

  function focusables(): HTMLElement[] {
    return [
      ...cardEl.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((el) => el.getAttribute("aria-hidden") !== "true");
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !cardEl.contains(document.activeElement))) {
        last.focus();
        event.preventDefault();
      } else if (!event.shiftKey && document.activeElement === last) {
        first.focus();
        event.preventDefault();
      }
    }
  }

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    (cardEl.querySelector<HTMLElement>("input, select, textarea, button:not(:disabled)") || cardEl)?.focus?.();
    return () => previous?.focus?.();
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div
  bind:this={overlayEl}
  class="modal-overlay"
  role="presentation"
  on:mousedown={(event) => {
    if (closeOnBackdrop && event.target === overlayEl) close();
  }}
>
  <div
    bind:this={cardEl}
    class={`modal-card ${cardClass}`}
    role="dialog"
    aria-modal="true"
    aria-labelledby={ariaLabelledby}
    aria-describedby={ariaDescribedby}
    tabindex="-1"
  >
    <slot />
  </div>
</div>
