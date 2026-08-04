<script lang="ts">
  import { avatarGradient, avatarImageUrl, initials } from "../lib/format";

  export let user: { id: string; alias?: string; displayName?: string; username?: string; hasImage?: boolean } | null;
  export let size = 40;
  export let alt = "";

  let failedKey = "";
  $: imageKey = `${user?.id || ""}:${user?.hasImage ? "1" : "0"}:${size}`;
  $: url = failedKey !== imageKey ? avatarImageUrl(user, size) : null;
  $: gradient = avatarGradient(user);
</script>

<span
  class="avatar-img"
  style={url ? `width:${size}px;height:${size}px;--avatar-size:${size}px` : `width:${size}px;height:${size}px;--avatar-size:${size}px;background:${gradient};color:var(--on-avatar)`}
  aria-hidden={alt === "" ? "true" : undefined}
  role={!url && alt ? "img" : undefined}
  aria-label={!url && alt ? alt : undefined}
>
  {#if url}
    <img src={url} {alt} width={size} height={size} on:error={() => (failedKey = imageKey)} />
  {:else}
    <span aria-hidden="true">{initials(user)}</span>
  {/if}
</span>
