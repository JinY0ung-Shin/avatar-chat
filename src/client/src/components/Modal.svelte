<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { fade, fly } from "svelte/transition";
  import { prefersReducedMotion, project, rubberband, springValue } from "../lib/motion";

  export let cardClass = "";
  export let ariaLabelledby: string | undefined = undefined;
  export let ariaDescribedby: string | undefined = undefined;
  export let closeOnBackdrop = true;
  export let closeDisabled = false;

  const dispatch = createEventDispatcher<{ close: void }>();
  let overlayEl: HTMLDivElement;
  let cardEl: HTMLDivElement;
  let cancelSheetSpring: () => void = () => {};
  let sheetY = 0;
  let dragging = false;

  const mobileSheetMedia =
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;

  function overlayMotion() {
    return { duration: prefersReducedMotion() ? 120 : 180 };
  }

  function cardMotion() {
    return { y: prefersReducedMotion() ? 0 : 18, duration: prefersReducedMotion() ? 120 : 260, easing: cubicOut };
  }

  function close() {
    if (closeDisabled) return;
    dispatch("close");
  }

  function setSheetY(value: number): void {
    sheetY = value;
  }

  function settleSheet(from: number, to: number, velocity = 0, complete?: () => void): void {
    cancelSheetSpring();
    cancelSheetSpring = springValue({
      from,
      to,
      velocity,
      response: 0.3,
      dampingRatio: 0.84,
      onUpdate: setSheetY,
      onComplete: () => {
        cancelSheetSpring = () => {};
        complete?.();
      },
    });
  }

  function startSheetDrag(event: PointerEvent): void {
    if (!mobileSheetMedia?.matches || closeDisabled) return;
    event.preventDefault();
    cancelSheetSpring();
    dragging = true;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const height = Math.max(1, cardEl.getBoundingClientRect().height);
    const startPointer = event.clientY;
    const startPosition = sheetY;
    let position = startPosition;
    let velocity = 0;
    let lastPosition = position;
    let lastTime = event.timeStamp;

    const onMove = (move: PointerEvent) => {
      const raw = startPosition + move.clientY - startPointer;
      position = raw < 0 ? rubberband(raw, height) : raw;
      const dt = Math.max(1, move.timeStamp - lastTime) / 1000;
      velocity = velocity * 0.65 + ((position - lastPosition) / dt) * 0.35;
      lastPosition = position;
      lastTime = move.timeStamp;
      setSheetY(position);
    };
    const cleanup = () => {
      dragging = false;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    };
    const onUp = () => {
      cleanup();
      const shouldClose = project(position, velocity) > height * 0.45 || velocity > 620;
      if (shouldClose) {
        settleSheet(position, height, velocity, () => {
          close();
          // If a parent vetoes close, bring the still-mounted sheet back.
          queueMicrotask(() => {
            if (cardEl?.isConnected) settleSheet(height, 0);
          });
        });
      } else {
        settleSheet(position, 0, velocity);
      }
    };
    const onCancel = () => {
      cleanup();
      settleSheet(position, 0);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  }

  function focusables(): HTMLElement[] {
    return [
      ...cardEl.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((el) => {
      if (el.getAttribute("aria-hidden") === "true" || el.hidden) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
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
    const preferred = cardEl.querySelector<HTMLElement>("[data-modal-autofocus]");
    (preferred && focusables().includes(preferred) ? preferred : focusables()[0] || cardEl).focus();
    return () => {
      cancelSheetSpring();
      restoreOutside();
      previous?.focus?.();
    };
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div
  bind:this={overlayEl}
  class="modal-overlay"
  class:sheet-dragging={dragging}
  role="presentation"
  transition:fade={overlayMotion()}
  on:pointerdown={(event) => {
    if (!closeOnBackdrop || event.target !== overlayEl) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    overlayEl.setPointerCapture(pointerId);
    const finish = (up: PointerEvent) => {
      overlayEl.removeEventListener("pointerup", finish);
      overlayEl.removeEventListener("pointercancel", finish);
      if (up.type === "pointerup" && Math.hypot(up.clientX - startX, up.clientY - startY) < 10) close();
    };
    overlayEl.addEventListener("pointerup", finish);
    overlayEl.addEventListener("pointercancel", finish);
  }}
>
  <div class="modal-motion" transition:fly={cardMotion()}>
    <div
      bind:this={cardEl}
      class={`modal-card ${cardClass}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      tabindex="-1"
      style={`--sheet-translate-y: ${sheetY}px`}
    >
      <button
        class="modal-sheet-grabber"
        type="button"
        aria-label="아래로 쓸어 창 닫기"
        disabled={closeDisabled}
        tabindex="-1"
        on:pointerdown={startSheetDrag}
      ><span></span></button>
      <slot />
    </div>
  </div>
</div>
