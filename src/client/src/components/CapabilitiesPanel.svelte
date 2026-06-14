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

  const CAP_WIDTH_MIN = 220;
  const CAP_WIDTH_MAX = 720;
  const CAP_WIDTH_DEFAULT = 480;
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
  // Clamp so the panel can never squeeze the chat column out (rail 248 + ~380 readable).
  function clampWidth(width: number): number {
    const available = Math.max(CAP_WIDTH_MIN, window.innerWidth - 248 - 380);
    return Math.min(Math.min(CAP_WIDTH_MAX, available), Math.max(CAP_WIDTH_MIN, width));
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

  function setCollapsed(value: boolean) {
    collapsed = value;
    setCapPref("capPanelCollapsed", value ? "1" : "0");
  }

  $: if (avatar?.id) void loadSkills(avatar.id);

  let loadedFor = "";
  async function loadSkills(avatarId: string) {
    if (loadedFor === avatarId) return;
    loadedFor = avatarId;
    loading = true;
    error = "";
    try {
      const result = await api<{ skills: SkillInfo[] }>(`/api/avatars/${encodeURIComponent(avatarId)}/skills`);
      skills = result.skills || [];
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    const mobile = window.matchMedia?.("(max-width: 860px)").matches ?? false;
    collapsed = capPref("capPanelCollapsed", mobile ? "1" : "0") === "1";
    panelWidth = clampWidth(Number(capPref("capPanelWidth", String(CAP_WIDTH_DEFAULT))) || CAP_WIDTH_DEFAULT);
    if (avatar?.id) void loadSkills(avatar.id);
  });

  function toggleSkill(key: string) {
    const next = new Set(openSkills);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openSkills = next;
  }
</script>

<aside class="cap-panel" class:collapsed aria-label="아바타 역량" style={collapsed ? undefined : `width:${panelWidth}px`}>
  <div class="cap-resize" role="separator" aria-orientation="vertical" aria-label="패널 너비 조절" on:pointerdown={startResize}></div>
  <button class="cap-collapse" type="button" aria-label="패널 접기" title="패널 접기" aria-expanded={!collapsed} on:click={() => setCollapsed(true)}>›</button>

  <div class="cap-body scroll-thin">
    <div class="cap-head">
      <h3>이 아바타의 역량</h3>
      <p class="cap-sub">{avatar.displayName}이(가) 사용할 수 있는 도구</p>
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

    <div class="cap-section">
      <div class="cap-section-title">스킬</div>
      <div class="cap-section-body cap-skills">
      {#if loading}
        <p class="cap-loading">불러오는 중…</p>
      {:else if error}
        <div class="cap-empty cap-error">
          <span>{error}</span>
        </div>
      {:else if !skills.length}
        <p class="cap-empty">사용 가능한 스킬이 없습니다.</p>
      {:else}
        {#each skills as skill, index}
          {@const key = `${skill.name}-${skill.source || "default"}-${index}`}
          {@const hasDescription = Boolean(skill.description)}
          {@const fromPlugin = Boolean(skill.source && skill.source !== "default")}
          <div class="cap-skill" class:open={openSkills.has(key)}>
            <button class="cap-skill-head" type="button" disabled={!hasDescription} aria-expanded={openSkills.has(key)} on:click={() => toggleSkill(key)}>
              {#if hasDescription}<span class="cap-skill-caret" aria-hidden="true">▸</span>{/if}
              <span class="cap-skill-name">{skill.name}</span>
              {#if fromPlugin}<span class="cap-skill-src">{skill.source}</span>{/if}
            </button>
            {#if hasDescription}<p class="cap-skill-desc">{skill.description}</p>{/if}
          </div>
        {/each}
      {/if}
      </div>
    </div>
  </div>

  <button class="cap-expand" type="button" aria-label="역량 패널 펼치기" title="역량 패널 펼치기" aria-expanded={!collapsed} on:click={() => setCollapsed(false)}>
    <span aria-hidden="true">‹</span>
    <span class="cap-expand-label">아바타 역량 보기</span>
  </button>
</aside>
