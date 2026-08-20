<script lang="ts">
  // 설정 ▸ 내 봇 — the owner's personal agents (admin-only feature). Mirrors the
  // group-agent block in SettingsGroupCard MINUS the shared-brain capture scope:
  // a bot runs with its OWNER's own capability, so there is no second party to
  // scope writes for. The extra field a bot has is a default model tier, which
  // seeds a new conversation with it (lib/chat.ts makePane).
  import AvatarImage from "./AvatarImage.svelte";
  import { api } from "../lib/api";
  import { startChatWith } from "../lib/chat";
  import { confirmAction } from "../lib/confirm";
  import { downscaleImageToDataUrl } from "../lib/dom";
  import { loadAvatars } from "../lib/loaders";
  import { appState, notify } from "../lib/state";
  import type { PersonalAgent } from "../lib/types";

  export let active = false;

  const agentPath = (suffix = "") => `/api/me/agents${suffix}`;
  /** Same composite id the server binds conversations + avatar images to. */
  const avatarIdOf = (agent: PersonalAgent) => `personal:${agent.ownerUserId}:${agent.id}`;

  /** A grant takes effect from the bot's next NEW conversation, server-wide. */
  const SKILL_APPLY_HINT = "변경은 봇의 다음 새 대화부터 적용됩니다.";

  /** One grantable skill out of the owner's own knowledge repo. */
  interface SkillCatalogEntry {
    slug: string;
    intro: string;
  }

  let agents: PersonalAgent[] = [];
  let loading = false;
  let loaded = false;
  let error = "";

  // The grantable-skill catalog costs a repo clone server-side, so it is pulled
  // once per card mount and only when a form actually opens — the listing above
  // is the common visit, and it needs none of this.
  let catalogLoaded = false;
  let catalogLoading = false;
  let catalogRepoConfigured = false;
  let catalogSkills: SkillCatalogEntry[] = [];
  let catalogError = "";

  let saving = false;
  let rowBusyId = "";
  let chatBusyId = "";
  let picBusy = false;

  let formOpen = false;
  /** Bot being edited; null = the form creates a NEW one. */
  let editingId: string | null = null;
  let formDisplayName = "";
  let formAlias = "";
  let formBio = "";
  let formIntro = "";
  let formPersona = "";
  let formDefaultModel = "";
  /**
   * The bot's skill grants as the form currently has them. Seeded from the ROW,
   * never from the catalog, so saving while the repo is unreachable replaces the
   * stored list with itself instead of silently revoking every grant.
   */
  let formSkills: string[] = [];

  // An env-pinned model (bootstrap.modelSelection.locked) ignores every
  // per-conversation choice, so offering a per-bot tier there would be a control
  // that does nothing. When it is hidden the field is also omitted from the save
  // body — undefined keeps whatever tier is stored.
  $: modelTiers = $appState.bootstrap?.modelSelection?.tiers ?? [];
  $: modelLocked = Boolean($appState.bootstrap?.modelSelection?.locked);
  $: canPickModel = modelTiers.length > 0 && !modelLocked;
  $: editingAgent = editingId ? (agents.find((agent) => agent.id === editingId) ?? null) : null;
  $: statusText = loading
    ? "봇 목록을 불러오는 중입니다."
    : error
      ? `봇 목록을 불러오지 못했습니다: ${error}`
      : `봇 ${agents.length}개`;

  // Lazy: the listing is admin-only, so it is fetched the first time the tab is
  // actually opened rather than on every settings visit.
  $: if (active && !loaded && !loading) void load();

  function modelLabel(tierId: string | null): string {
    if (!tierId) return "기본값";
    return modelTiers.find((tier) => tier.id === tierId)?.label ?? tierId;
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const { agents: next } = await api<{ agents: PersonalAgent[] }>(agentPath());
      agents = next ?? [];
      loaded = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  /** Refresh the listing AND the avatar list the 탐색 cards + rail read. */
  async function reload(): Promise<void> {
    await load();
    void loadAvatars(true).catch(() => {});
  }

  function openForm(agent: PersonalAgent | null): void {
    editingId = agent?.id ?? null;
    formDisplayName = agent?.displayName ?? "";
    formAlias = agent?.alias ?? "";
    formBio = agent?.bio ?? "";
    formIntro = agent?.intro ?? "";
    formPersona = agent?.persona ?? "";
    formDefaultModel = agent?.defaultModel ?? "";
    formSkills = [...(agent?.selectedSkills ?? [])];
    formOpen = true;
    void loadCatalog();
  }

  /** What the owner may grant — read once, the first time a form opens. */
  async function loadCatalog(): Promise<void> {
    if (catalogLoaded || catalogLoading) return;
    catalogLoading = true;
    catalogError = "";
    try {
      const body = await api<{ repoConfigured: boolean; skills: SkillCatalogEntry[] }>(
        agentPath("/skill-catalog"),
      );
      catalogRepoConfigured = Boolean(body.repoConfigured);
      catalogSkills = body.skills ?? [];
      catalogLoaded = true;
    } catch (err) {
      // Left un-loaded on purpose: a clone failure is fixable (address/branch/
      // token), so the next form open retries instead of staying dark forever.
      catalogError = (err as Error).message;
    } finally {
      catalogLoading = false;
    }
  }

  function toggleSkill(slug: string, on: boolean): void {
    const without = formSkills.filter((item) => item !== slug);
    formSkills = on ? [...without, slug] : without;
  }

  function closeForm(): void {
    formOpen = false;
    editingId = null;
  }

  async function save(): Promise<void> {
    if (saving) return;
    if (!formDisplayName.trim()) {
      notify("봇 이름을 입력해 주세요.", "warn");
      return;
    }
    saving = true;
    try {
      const payload: Record<string, unknown> = {
        displayName: formDisplayName.trim(),
        alias: formAlias,
        bio: formBio,
        intro: formIntro,
        persona: formPersona,
        // FULL REPLACE — the server takes this array as the bot's whole grant
        // list, which is why it is seeded from the row rather than the catalog.
        selectedSkills: formSkills,
      };
      if (canPickModel) payload.defaultModel = formDefaultModel || null;
      const body = JSON.stringify(payload);
      if (editingId) {
        await api(agentPath(`/${encodeURIComponent(editingId)}`), { method: "PATCH", body });
      } else {
        await api(agentPath(), { method: "POST", body });
      }
      notify(`"${formDisplayName.trim()}" 봇을 저장했습니다.`, "ok");
      closeForm();
      await reload();
    } catch (err) {
      notify(`봇 저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      saving = false;
    }
  }

  async function toggleEnabled(agent: PersonalAgent, on: boolean): Promise<void> {
    if (rowBusyId) return;
    rowBusyId = agent.id;
    try {
      await api(agentPath(`/${encodeURIComponent(agent.id)}`), {
        method: "PATCH",
        body: JSON.stringify({ enabled: on }),
      });
      notify(
        on
          ? `"${agent.displayName}" 봇을 활성화했습니다.`
          : `"${agent.displayName}" 봇을 비활성화했습니다. 다음 대화부터 차단되며 기존 대화 기록은 유지됩니다.`,
        "ok",
      );
      await reload();
    } catch (err) {
      notify(`봇 설정 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      rowBusyId = "";
    }
  }

  async function remove(agent: PersonalAgent): Promise<void> {
    if (rowBusyId) return;
    const confirmed = await confirmAction(
      `"${agent.displayName}" 봇을 삭제할까요?\n이 봇과의 모든 대화 기록이 함께 삭제되며 되돌릴 수 없습니다. 기록을 남기려면 대신 ‘비활성화’를 사용하세요.\n봇의 기억 폴더(지식 저장소의 agents/${agent.memoryDir}/)는 삭제되지 않고 남습니다.`,
      { title: "봇을 삭제할까요?", confirmLabel: "삭제", tone: "danger" },
    );
    if (!confirmed) return;
    rowBusyId = agent.id;
    try {
      await api(agentPath(`/${encodeURIComponent(agent.id)}`), { method: "DELETE" });
      notify(`"${agent.displayName}" 봇을 삭제했습니다.`, "ok");
      if (editingId === agent.id) closeForm();
      await reload();
    } catch (err) {
      notify(`봇 삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      rowBusyId = "";
    }
  }

  async function chatWith(agent: PersonalAgent): Promise<void> {
    if (chatBusyId) return;
    chatBusyId = agent.id;
    try {
      await startChatWith({
        id: avatarIdOf(agent),
        username: `personal-agent-${agent.id.slice(0, 8)}`,
        displayName: agent.displayName,
        alias: agent.alias,
        bio: agent.bio,
        hashtags: agent.hashtags,
        hasImage: agent.hasImage,
        pluginCount: 0,
        visibility: "group",
        updatedAt: null,
        runtime: "native",
        personalAgent: { agentId: agent.id, defaultModel: agent.defaultModel },
      });
    } catch (err) {
      notify(`봇과의 대화를 열지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      chatBusyId = "";
    }
  }

  async function uploadImage(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || picBusy || !editingId) return;
    picBusy = true;
    try {
      const image = await downscaleImageToDataUrl(file, 256);
      await api(agentPath(`/${encodeURIComponent(editingId)}/image`), {
        method: "PUT",
        body: JSON.stringify({ image }),
      });
      notify("봇 사진을 변경했습니다.", "ok");
      await reload();
    } catch (err) {
      notify(`사진 업로드 실패: ${(err as Error).message}`, "warn");
    } finally {
      picBusy = false;
    }
  }

  async function deleteImage(): Promise<void> {
    if (picBusy || !editingId) return;
    picBusy = true;
    try {
      await api(agentPath(`/${encodeURIComponent(editingId)}/image`), { method: "DELETE" });
      notify("봇 사진을 삭제했습니다.", "ok");
      await reload();
    } catch (err) {
      notify(`사진 삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      picBusy = false;
    }
  }
</script>

{#if active}
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>내 봇</h3>
        <p class="muted">
          나만 대화할 수 있는 봇입니다. 각 봇은 내 권한으로 움직이고(내 지식 저장소·연결·플러그인을 그대로 사용) 봇마다 대화 기록이 따로 남아요.
          만든 봇은 탐색과 왼쪽 메뉴의 ‘내 봇’에서 바로 대화할 수 있습니다. 예약 작업은 아직 봇 대화에서 쓸 수 없어요.
        </p>
      </div>
      <div class="head-actions">
        <span class="muted small nowrap" role="status" aria-live="polite">{statusText}</span>
        <button class="linkish small" type="button" disabled={loading} on:click={() => void reload()}>새로고침</button>
      </div>
    </div>

    {#if loading && !loaded}
      <div class="muted" role="status">불러오는 중…</div>
    {:else if error}
      <div class="warn-box" role="alert">
        봇 목록을 불러오지 못했습니다: {error}
        <button class="linkish" type="button" disabled={loading} on:click={() => void reload()}>다시 시도</button>
      </div>
    {/if}

    {#if agents.length}
      <div class="plugin-rows">
        {#each agents as agent (agent.id)}
          {@const busy = chatBusyId === agent.id || rowBusyId === agent.id}
          <div class="plugin-row" class:busy aria-busy={busy ? "true" : "false"}>
            <AvatarImage user={{ id: avatarIdOf(agent), hasImage: agent.hasImage, displayName: agent.displayName }} size={32} alt="" />
            <div class="pr-main">
              <strong>{agent.displayName}</strong>
              <div class="pr-sub">
                {agent.alias ? `"${agent.alias}" · ` : ""}모델: {modelLabel(agent.defaultModel)}
                {agent.persona ? " · 페르소나 설정됨" : ""}
                {agent.selectedSkills.length ? ` · 스킬 ${agent.selectedSkills.length}개` : ""}
              </div>
            </div>
            {#if !agent.enabled}<span class="tag read">비활성</span>{/if}
            <div class="pr-actions">
              {#if agent.enabled}
                <button class="ghost-sm" type="button" disabled={Boolean(chatBusyId)} on:click={() => chatWith(agent)}>
                  {chatBusyId === agent.id ? "여는 중…" : "대화하기"}
                </button>
              {/if}
              <button class="ghost-sm" type="button" disabled={saving || Boolean(rowBusyId)} on:click={() => openForm(agent)}>설정</button>
              <button class="ghost-sm" type="button" disabled={saving || Boolean(rowBusyId)} on:click={() => toggleEnabled(agent, !agent.enabled)}>
                {agent.enabled ? "비활성화" : "활성화"}
              </button>
              <button
                class="ghost-sm danger"
                type="button"
                title="이 봇과의 모든 대화 기록이 함께 삭제됩니다"
                disabled={saving || Boolean(rowBusyId)}
                on:click={() => remove(agent)}
              >삭제</button>
            </div>
          </div>
        {/each}
      </div>
    {:else if loaded && !error}
      <p class="muted">아직 만든 봇이 없어요. 역할별로 봇을 나눠 두면 대화 기록과 말투를 따로 관리할 수 있습니다.</p>
    {/if}

    {#if !formOpen}
      <button class="ghost-sm" type="button" disabled={loading} on:click={() => openForm(null)}>
        {agents.length ? "봇 추가" : "봇 만들기"}
      </button>
    {:else}
      <div class="group-add-panel" aria-busy={saving}>
        <label class="field">
          <span>표시 이름</span>
          <input type="text" bind:value={formDisplayName} maxlength="64" placeholder="예: 코드리뷰 봇" disabled={saving} />
        </label>
        <label class="field">
          <span>별칭 (대화에서 스스로를 부르는 이름)</span>
          <input type="text" bind:value={formAlias} maxlength="64" disabled={saving} />
        </label>
        <label class="field">
          <span>한 줄 소개</span>
          <input type="text" bind:value={formBio} maxlength="200" disabled={saving} />
        </label>
        <label class="field">
          <span>자기소개 (탐색의 소개 보기에 표시)</span>
          <textarea rows="2" bind:value={formIntro} disabled={saving}></textarea>
        </label>
        <label class="field">
          <span>페르소나 · 지침</span>
          <textarea rows="4" bind:value={formPersona} disabled={saving} placeholder="이 봇의 말투, 역할, 우선순위를 적어 주세요"></textarea>
        </label>
        {#if canPickModel}
          <label class="field">
            <span>기본 모델</span>
            <select bind:value={formDefaultModel} disabled={saving}>
              <option value="">기본값 (내 설정 따르기)</option>
              {#each modelTiers as tier (tier.id)}
                <option value={tier.id}>{tier.label}</option>
              {/each}
            </select>
            <span class="field-hint">이 봇과 새 대화를 시작할 때 이 모델로 시작합니다. 대화마다 바꿀 수 있어요.</span>
          </label>
        {:else if modelLocked}
          <p class="muted">이 서버는 모델이 고정되어 있어 봇별 기본 모델을 고를 수 없어요.</p>
        {/if}
        <!-- 스킬은 COPY가 아니라 내 저장소를 가리키는 참조다 — 그래서 목록은
             주인의 저장소에서 그때그때 읽고, 준 스킬은 빈 목록이 기본값이다. -->
        <div class="field">
          <span>스킬</span>
          <span class="field-hint">이 봇이 불러올 내 지식 저장소의 스킬을 고릅니다. 고르지 않으면 아무 스킬도 불러오지 않아요.</span>
          {#if catalogLoading && !catalogLoaded}
            <span class="field-hint" role="status">스킬 목록을 불러오는 중…</span>
          {:else if catalogError}
            <span class="field-hint warn" role="alert">스킬 목록을 불러오지 못했습니다: {catalogError}</span>
          {:else if !catalogRepoConfigured}
            <span class="field-hint">지식 저장소를 연결하면 봇에게 내 스킬을 줄 수 있어요.</span>
          {:else if !catalogSkills.length}
            <span class="field-hint">지식 저장소에 아직 스킬이 없습니다.</span>
          {:else}
            <div class="pc-list" role="group" aria-label="봇에게 줄 스킬">
              {#each catalogSkills as skill (skill.slug)}
                <label class="pc-item">
                  <input
                    type="checkbox"
                    checked={formSkills.includes(skill.slug)}
                    disabled={saving}
                    on:change={(event) => toggleSkill(skill.slug, event.currentTarget.checked)}
                  />
                  <span>{skill.slug}</span>
                  {#if skill.intro}<span class="field-hint">{skill.intro}</span>{/if}
                </label>
              {/each}
            </div>
            <span class="field-hint">{SKILL_APPLY_HINT}</span>
          {/if}
        </div>
        {#if editingAgent}
          <div class="pr-actions">
            <label class="ghost-sm" style="cursor:pointer">
              사진 업로드
              <input type="file" accept="image/*" style="display:none" disabled={picBusy} on:change={uploadImage} />
            </label>
            {#if editingAgent.hasImage}
              <button class="ghost-sm danger" type="button" disabled={picBusy} on:click={deleteImage}>사진 삭제</button>
            {/if}
          </div>
        {/if}
        <div class="pr-actions">
          <button class="ghost-sm" type="button" disabled={saving} on:click={save}>{saving ? "저장 중…" : editingId ? "저장" : "만들기"}</button>
          <button class="ghost-sm" type="button" disabled={saving} on:click={closeForm}>닫기</button>
        </div>
      </div>
    {/if}
  </section>
{/if}
