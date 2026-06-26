<script lang="ts">
  import Icon from "./Icon.svelte";

  export let value = "";
  export let name = "";
  export let placeholder = "";
  export let ariaLabel = "";
  export let ariaDescribedby: string | undefined = undefined;
  export let ariaInvalid = false;
  export let autocomplete = "off";
  export let revealLabel = "값";
  export let disabled = false;
  export let onInput: (() => void) | null = null;

  let revealed = false;
  $: if (disabled && revealed) revealed = false;
</script>

<div class="password-field">
  <input
    {name}
    type={revealed ? "text" : "password"}
    {placeholder}
    autocomplete={autocomplete as never}
    aria-label={ariaLabel}
    aria-describedby={ariaDescribedby}
    aria-invalid={ariaInvalid ? "true" : undefined}
    {disabled}
    bind:value
    on:input={() => onInput?.()}
  />
  <button
    class="password-toggle"
    type="button"
    {disabled}
    aria-label={revealed ? `${revealLabel} 숨기기` : `${revealLabel} 보기`}
    title={revealed ? `${revealLabel} 숨기기` : `${revealLabel} 보기`}
    on:click={() => (revealed = !revealed)}
  >
    <Icon name={revealed ? "eye-off" : "eye"} />
  </button>
</div>
