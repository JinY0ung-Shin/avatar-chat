<script lang="ts">
  // Accessible switch. `onChange` runs before the visual flip so a failed save
  // (which should re-throw) doesn't render as "on". Mirrors the old buildToggle().
  export let on = false;
  export let label = "사용";
  export let onChange: (next: boolean) => Promise<void> | void = () => {};
  /** Locked by a PRECONDITION (not by an in-flight save) — `title` should say which. */
  export let disabled = false;
  /** Hover/AT explanation; defaults to `label` so the plain switch is unchanged. */
  export let title = "";

  let busy = false;

  async function handle() {
    if (busy || disabled) return;
    const next = !on;
    busy = true;
    try {
      await onChange(next);
      on = next;
    } catch {
      /* caller already surfaced the error; keep the previous visual state */
    } finally {
      busy = false;
    }
  }
</script>

<button
  class={`toggle ${on ? "on" : ""}`}
  type="button"
  role="switch"
  aria-checked={on ? "true" : "false"}
  aria-busy={busy ? "true" : "false"}
  aria-label={label}
  title={title || label}
  disabled={busy || disabled}
  on:click|stopPropagation={handle}
>
  <span class="knob"></span>
</button>
