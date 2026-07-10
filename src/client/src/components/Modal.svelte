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

  function inertOutside(root: HTMLElement): () => void {
    const changed: HTMLElement[] = [];
    let branch: HTMLElement = root;
    while (branch.parentElement) {
      const parent = branch.parentElement;
      for (const sibling of parent.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.inert) continue;
        sibling.inert = true;
        changed.push(sibling);
      }
      if (parent === document.body) break;
      branch = parent;
    }
    return () => {
      for (const element of changed) element.inert = false;
    };
  }

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    const restoreOutside = inertOutside(overlayEl);
    (cardEl.querySelector<HTMLElement>("input, select, textarea, button:not(:disabled)") || cardEl)?.focus?.();
    return () => {
      restoreOutside();
      previous?.focus?.();
    };
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
