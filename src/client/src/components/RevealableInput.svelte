<script lang="ts">
  import Icon from "./Icon.svelte";

  export let value = "";
  export let name = "";
  export let placeholder = "";
  export let ariaLabel = "";
  export let autocomplete = "off";
  export let revealLabel = "값";

  let revealed = false;
</script>

<div class="password-field">
  <input
    {name}
    type={revealed ? "text" : "password"}
    {placeholder}
    autocomplete={autocomplete as never}
    aria-label={ariaLabel}
    bind:value
  />
  <button
    class="password-toggle"
    type="button"
    aria-label={revealed ? `${revealLabel} 숨기기` : `${revealLabel} 보기`}
    title={revealed ? `${revealLabel} 숨기기` : `${revealLabel} 보기`}
    on:click={() => (revealed = !revealed)}
  >
    <Icon name={revealed ? "eye-off" : "eye"} />
  </button>
</div>
