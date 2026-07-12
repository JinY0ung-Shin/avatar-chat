<script lang="ts">
  import Modal from "./Modal.svelte";
  import { confirmation, resolveConfirmation } from "../lib/confirm";

  $: lines = $confirmation?.message.split("\n").filter(Boolean) ?? [];
</script>

{#if $confirmation}
  <Modal
    cardClass="confirm-card"
    ariaLabelledby={`confirm-title-${$confirmation.id}`}
    ariaDescribedby={`confirm-copy-${$confirmation.id}`}
    on:close={() => resolveConfirmation(false)}
  >
    <div class="confirm-symbol" class:danger={$confirmation.tone === "danger"} aria-hidden="true">
      {$confirmation.tone === "danger" ? "!" : "✓"}
    </div>
    <div class="confirm-content">
      <h2 id={`confirm-title-${$confirmation.id}`}>{$confirmation.title}</h2>
      <div id={`confirm-copy-${$confirmation.id}`} class="confirm-copy">
        {#each lines as line}
          <p>{line}</p>
        {/each}
      </div>
    </div>
    <div class="confirm-actions">
      <button class="ghost-sm" type="button" data-modal-autofocus on:click={() => resolveConfirmation(false)}>
        {$confirmation.cancelLabel}
      </button>
      <button
        class={$confirmation.tone === "danger" ? "confirm-danger" : "primary"}
        type="button"
        on:click={() => resolveConfirmation(true)}
      >
        {$confirmation.confirmLabel}
      </button>
    </div>
  </Modal>
{/if}
