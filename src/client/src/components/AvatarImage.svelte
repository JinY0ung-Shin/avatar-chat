<script lang="ts">
  import { avatarImageUrl, initials } from "../lib/format";

  export let user: { id: string; alias?: string; displayName?: string; username?: string; hasImage?: boolean } | null;
  export let size = 40;
  export let alt = "";

  $: url = avatarImageUrl(user, size);
</script>

<span class="avatar-img" style={`width:${size}px;height:${size}px;--avatar-size:${size}px`}>
  {#if url}
    <img src={url} {alt} width={size} height={size} />
  {:else}
    <span aria-hidden="true">{initials(user)}</span>
  {/if}
</span>
