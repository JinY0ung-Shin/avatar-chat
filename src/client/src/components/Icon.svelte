<script lang="ts">
  import { ICON_PATHS } from "../lib/icons";

  export let name: string;
  export let size = 18;
</script>

<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {@html ICON_PATHS[name] || ""}
</svg>
