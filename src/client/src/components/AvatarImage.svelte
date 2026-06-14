<script lang="ts">
  import { avatarGradient, avatarImageUrl, initials } from "../lib/format";

  export let user: { id: string; alias?: string; displayName?: string; username?: string; hasImage?: boolean } | null;
  export let size = 40;
  export let alt = "";

  let failed = false;
  $: url = !failed ? avatarImageUrl(user, size) : null;
  $: gradient = avatarGradient(user);
</script>

<span
  class="avatar-img"
  style={url ? `width:${size}px;height:${size}px;--avatar-size:${size}px` : `width:${size}px;height:${size}px;--avatar-size:${size}px;background:${gradient};color:#fff`}
  aria-hidden={alt === "" ? "true" : undefined}
>
  {#if url}
    <img src={url} {alt} width={size} height={size} on:error={() => (failed = true)} />
  {:else}
    <span aria-hidden="true">{initials(user)}</span>
  {/if}
</span>
