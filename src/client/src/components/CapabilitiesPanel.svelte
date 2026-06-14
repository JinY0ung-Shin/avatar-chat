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
    collapsed = window.matchMedia?.("(max-width: 860px)").matches ?? false;
    if (avatar?.id) void loadSkills(avatar.id);
  });

  function toggleSkill(key: string) {
    const next = new Set(openSkills);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openSkills = next;
  }
</script>

<aside class="cap-panel" class:collapsed aria-label="아바타 역량">
  <div class="cap-resize" aria-hidden="true"></div>
  <button class="cap-collapse" type="button" aria-label="패널 접기" title="패널 접기" aria-expanded={!collapsed} on:click={() => (collapsed = true)}>›</button>

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

  <button class="cap-expand" type="button" aria-label="역량 패널 펼치기" title="역량 패널 펼치기" aria-expanded={!collapsed} on:click={() => (collapsed = false)}>
    <span aria-hidden="true">‹</span>
    <span class="cap-expand-label">아바타 역량 보기</span>
  </button>
</aside>
