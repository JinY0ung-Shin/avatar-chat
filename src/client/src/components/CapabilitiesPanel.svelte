<script lang="ts" context="module">
  let nextCapabilityPanelId = 0;
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { renderMarkdown } from "../lib/format";
  import type { AvatarDetail, SkillInfo } from "../lib/types";

  export let avatar: AvatarDetail;

  let collapsed = false;
  let loading = true;
  let error = "";
  let skills: SkillInfo[] = [];
  let openSkills = new Set<string>();
  let loadToken = 0;
  let hasStoredCollapsePref = false;
  let mobile = false;
  const panelId = `cap-panel-${++nextCapabilityPanelId}`;
  const bodyId = `${panelId}-body`;

  const CAP_WIDTH_MIN = 220;
  const CAP_WIDTH_MAX = 720;
  const CAP_WIDTH_DEFAULT = 360;
  let panelWidth = CAP_WIDTH_DEFAULT;

  function capPref(key: string, fallback: string): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function setCapPref(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: prefs just won't persist */
    }
  }
  // Bound the stored/dragged width to the panel's own min/max only. CSS owns the
  // actual fit: `.cap-panel:not(.collapsed)` flex-shrinks and the `.chat-layout >
  // .chat-col` min-width floors the chat, and on narrow viewports the panel stacks
  // below the chat (#40 responsive). The old `window.innerWidth - 248 - 380` term
  // reserved rail+chat as if this were the only side panel, which double-counted
  // against the canvas panel and pushed it off the right edge.
  function clampWidth(width: number): number {
    return Math.min(CAP_WIDTH_MAX, Math.max(CAP_WIDTH_MIN, width));
  }
  function savePanelWidth(width: number): void {
    panelWidth = clampWidth(width);
    setCapPref("capPanelWidth", String(Math.round(panelWidth)));
  }

  function startResize(event: PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = panelWidth;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev: PointerEvent) => {
      // Panel sits at the right edge → dragging left (smaller clientX) widens it.
      panelWidth = clampWidth(startW + (startX - ev.clientX));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setCapPref("capPanelWidth", String(Math.round(panelWidth)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  function onResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      savePanelWidth(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      savePanelWidth(panelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      savePanelWidth(CAP_WIDTH_DEFAULT);
    } else if (event.key === "End") {
      event.preventDefault();
      savePanelWidth(CAP_WIDTH_MAX);
    }
  }

  function setCollapsed(value: boolean) {
    collapsed = value;
    hasStoredCollapsePref = true;
    setCapPref("capPanelCollapsed", value ? "1" : "0");
  }

  function syncAutomaticCollapse(): void {
    if (hasStoredCollapsePref) return;
    const empty = !error && !avatar.intro && !avatar.hashtags?.length && !avatar.plugins?.length && !skills.length;
    collapsed = mobile || empty;
  }

  $: if (avatar?.id) void loadSkills(avatar.id);

  let loadedFor = "";
  async function loadSkills(avatarId: string, force = false) {
    if (!force && loadedFor === avatarId) return;
    const token = ++loadToken;
    loadedFor = avatarId;
    loading = true;
    error = "";
    try {
      const result = await api<{ skills: SkillInfo[] }>(`/api/avatars/${encodeURIComponent(avatarId)}/skills`);
      if (token !== loadToken) return;
      skills = result.skills || [];
      syncAutomaticCollapse();
    } catch (err) {
      if (token !== loadToken) return;
      error = (err as Error).message;
      syncAutomaticCollapse();
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  onMount(() => {
    mobile = window.matchMedia?.("(max-width: 860px)").matches ?? false;
    const storedCollapse = capPref("capPanelCollapsed", "");
    hasStoredCollapsePref = storedCollapse === "0" || storedCollapse === "1";
    collapsed = hasStoredCollapsePref ? storedCollapse === "1" : mobile;
    panelWidth = clampWidth(Number(capPref("capPanelWidth", String(CAP_WIDTH_DEFAULT))) || CAP_WIDTH_DEFAULT);
    if (avatar?.id) void loadSkills(avatar.id);
  });

  function toggleSkill(key: string) {
    const next = new Set(openSkills);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openSkills = next;
  }

  function retrySkills() {
    if (avatar?.id) void loadSkills(avatar.id, true);
  }
</script>

<aside class="cap-panel" class:collapsed aria-label="아바타 역량" style={collapsed ? undefined : `width:${panelWidth}px`}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div
    class="cap-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="역량 패널 너비 조절"
    aria-valuenow={Math.round(panelWidth)}
    aria-valuemin={CAP_WIDTH_MIN}
    aria-valuemax={CAP_WIDTH_MAX}
    aria-valuetext={`${Math.round(panelWidth)}px`}
    tabindex="0"
    on:pointerdown={startResize}
    on:keydown={onResizeKeydown}
  ></div>
  <button class="cap-collapse" type="button" aria-label="패널 접기" title="패널 접기" aria-expanded={!collapsed} aria-controls={bodyId} on:click={() => setCollapsed(true)}>›</button>

  <div id={bodyId} class="cap-body scroll-thin">
    <div class="cap-head">
      <h3>이 아바타의 역량</h3>
      <p class="cap-sub">{avatar.displayName} 아바타가 사용할 수 있는 도구</p>
    </div>

    {#if avatar.intro}
      <div class="cap-intro">
        <div class="cap-intro-text md">{@html renderMarkdown(avatar.intro)}</div>
      </div>
    {/if}

    {#if avatar.hashtags?.length}
      <div class="cap-tags">
        {#each avatar.hashtags as tag}
          <span class="tag accent">#{tag}</span>
        {/each}
      </div>
    {/if}

    {#if avatar.plugins?.length}
      <div class="cap-section">
        <div class="cap-section-title">플러그인</div>
        <div class="cap-section-body cap-plugins">
        {#each avatar.plugins as plugin}
          <div class="cap-plugin">
            <span class="cap-plugin-name">{plugin.label || plugin.repo}</span>
            {#if plugin.label}<span class="cap-plugin-repo">{plugin.repo}</span>{/if}
          </div>
        {/each}
        </div>
      </div>
    {/if}

    <div class="cap-section" aria-busy={loading ? "true" : "false"}>
      <div class="cap-section-title">스킬</div>
      <div class="cap-section-body cap-skills">
      {#if loading}
        <p class="cap-loading" role="status">불러오는 중…</p>
      {:else if error}
        <div class="cap-empty cap-error" role="alert">
          <span>{error}</span>
          <button class="linkish small" type="button" disabled={loading} on:click={retrySkills}>다시 시도</button>
        </div>
      {:else if !skills.length}
        <p class="cap-empty">사용 가능한 스킬이 없습니다.</p>
      {:else}
        <div class="cap-skill-list" role="list" aria-label={`${avatar.displayName} 스킬`}>
          {#each skills as skill, index}
            {@const key = `${skill.name}-${skill.source || "default"}-${index}`}
            {@const descId = `${panelId}-skill-desc-${index}`}
            {@const hasDescription = Boolean(skill.description)}
            {@const fromPlugin = Boolean(skill.source && skill.source !== "default")}
            <div class="cap-skill" class:open={openSkills.has(key)} role="listitem">
              <button
                class="cap-skill-head"
                type="button"
                disabled={!hasDescription}
                aria-expanded={hasDescription ? openSkills.has(key) : undefined}
                aria-describedby={hasDescription ? descId : undefined}
                on:click={() => toggleSkill(key)}
              >
                {#if hasDescription}<span class="cap-skill-caret" aria-hidden="true">▸</span>{/if}
                <span class="cap-skill-name">{skill.name}</span>
                {#if fromPlugin}<span class="cap-skill-src">{skill.source}</span>{/if}
              </button>
              {#if hasDescription}<p id={descId} class="cap-skill-desc">{skill.description}</p>{/if}
            </div>
          {/each}
        </div>
      {/if}
      </div>
    </div>
  </div>

  <button class="cap-expand" type="button" aria-label="역량 패널 펼치기" title="역량 패널 펼치기" aria-expanded={!collapsed} aria-controls={bodyId} on:click={() => setCollapsed(false)}>
    <span aria-hidden="true">‹</span>
    <span class="cap-expand-label">아바타 역량 보기</span>
  </button>
</aside>
