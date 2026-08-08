<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import Toggle from "../components/Toggle.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { timeLabel } from "../lib/format";
  import { goView } from "../lib/nav";
  import { appState, notify } from "../lib/state";
  import type { SharedSkillListing } from "../lib/types";

  // 스킬 배우기: 동료 아바타가 공유한 스킬을 둘러보고 내 아바타의 지식 저장소로
  // 전수(복사+커밋)하는 탭 + 내 저장소 스킬의 공유 토글. 서버 계약은
  // routes/skillShare.ts — 공유 범위는 탐색과 동일(같은 그룹, 아바타 공개 시).

  interface MySkill {
    slug: string;
    name: string;
    description: string;
    shared: boolean;
    /** 이 스킬이 동료에게 전수된 횟수 (공유 해제해도 이력은 유지). */
    learnCount: number;
    /** 전수받은 스킬의 출처 마커 — 원본 해시와 비교해 업데이트 여부를 판단. */
    origin: {
      ownerUserId: string;
      ownerUsername: string;
      skillName: string;
      contentHash: string | null;
    } | null;
  }

  /** 목록 카드 하나의 파생 상태 (내 것/전수받음/업데이트 가능). */
  interface ListingView {
    skill: SharedSkillListing;
    own: boolean;
    /** 이 공유에서 전수받은 내 스킬 (있다면). */
    copy: MySkill | null;
    updateAvailable: boolean;
  }

  let loading = true;
  let error = "";
  let learnable: SharedSkillListing[] = [];
  let mineLoading = true;
  let mineError = "";
  let repoConfigured = true;
  let mySkills: MySkill[] = [];

  let query = "";
  let searchInput: HTMLInputElement | null = null;
  let learningId: string | null = null;

  // 미리보기 모달: 목록 카드에서 열고, 이름 충돌(409) 시 새 이름 입력을 안내.
  let preview: SharedSkillListing | null = null;
  let previewContent = "";
  let previewLoading = false;
  let previewError = "";
  let renameValue = "";
  let renameInput: HTMLInputElement | null = null;

  onMount(() => {
    void load();
    void loadMine();
  });

  async function load(): Promise<void> {
    loading = true;
    error = "";
    try {
      const data = await api<{ skills: SharedSkillListing[] }>("/api/skill-share/available");
      learnable = data.skills;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function loadMine(): Promise<void> {
    mineLoading = true;
    mineError = "";
    try {
      const data = await api<{ repoConfigured: boolean; skills: MySkill[] }>("/api/skill-share/mine");
      repoConfigured = data.repoConfigured;
      mySkills = data.skills;
    } catch (err) {
      mineError = (err as Error).message;
    } finally {
      mineLoading = false;
    }
  }

  function refresh(): void {
    void load();
    void loadMine();
  }

  $: displayQuery = query.trim();
  $: tokens = displayQuery.toLowerCase().split(/\s+/).filter(Boolean);
  $: filtered = tokens.length ? learnable.filter((skill) => matches(skill, tokens)) : learnable;
  $: sharedCount = mySkills.filter((skill) => skill.shared).length;
  // 전수 출처 조인: 카드가 "내 것 / 전수받음 / 업데이트 있음"을 알 수 있게
  // mine의 origin 마커와 목록의 현재 해시를 비교한다.
  $: myUserId = $appState.user?.id ?? "";
  $: copiesByOrigin = new Map(
    mySkills
      .filter((skill) => skill.origin)
      .map((skill) => [`${skill.origin!.ownerUserId}:${skill.origin!.skillName}`, skill]),
  );
  $: listingViews = filtered.map((skill): ListingView => {
    const own = skill.ownerUserId === myUserId;
    const copy = own ? null : (copiesByOrigin.get(`${skill.ownerUserId}:${skill.skillName}`) ?? null);
    return {
      skill,
      own,
      copy,
      updateAvailable: Boolean(
        copy?.origin?.contentHash && skill.contentHash && copy.origin.contentHash !== skill.contentHash,
      ),
    };
  });
  // 내 스킬 관리 목록: 스킬이 많아지면 토글을 찾아 스크롤하는 대신 검색.
  let mineQuery = "";
  $: mineTokens = mineQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  $: mineFiltered = mineTokens.length
    ? mySkills.filter((skill) =>
        mineTokens.every((t) =>
          [skill.slug, skill.name, skill.description, skill.origin?.ownerUsername ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(t),
        ),
      )
    : mySkills;
  $: resultStatus = loading
    ? "공유된 스킬을 불러오는 중입니다."
    : error
      ? `공유된 스킬을 불러오지 못했습니다: ${error}`
      : !learnable.length
        ? "아직 공유된 스킬이 없습니다."
        : !filtered.length
          ? `${displayQuery} 검색 결과가 없습니다.`
          : displayQuery
            ? `${displayQuery} 검색 결과 ${filtered.length}개가 있습니다.`
            : `공유된 스킬 ${filtered.length}개가 있습니다.`;

  function matches(skill: SharedSkillListing, parts: string[]): boolean {
    const hay = [
      skill.skillName,
      skill.displayName,
      skill.description,
      skill.owner.displayName,
      skill.owner.alias,
      skill.owner.username,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return parts.every((part) => hay.includes(part));
  }

  function skillTitle(skill: SharedSkillListing): string {
    return skill.displayName || skill.skillName;
  }

  function clearSearch(): void {
    query = "";
    searchInput?.focus();
  }

  async function openPreview(skill: SharedSkillListing): Promise<void> {
    preview = skill;
    previewContent = "";
    previewError = "";
    renameValue = "";
    previewLoading = true;
    try {
      const data = await api<{ content: string }>(
        `/api/skill-share/available/${encodeURIComponent(skill.id)}`,
      );
      previewContent = data.content;
    } catch (err) {
      previewError = (err as Error).message;
    } finally {
      previewLoading = false;
    }
  }

  function closePreview(): void {
    if (learningId) return;
    preview = null;
    previewContent = "";
    previewError = "";
    renameValue = "";
  }

  async function learn(
    skill: SharedSkillListing,
    opts: { newName?: string; updateSlug?: string; overwriteModified?: boolean } = {},
  ): Promise<void> {
    if (learningId) return;
    if (!repoConfigured) {
      notify("먼저 설정에서 내 지식 저장소를 연결해 주세요.", "warn");
      goView("settings", "knowledge");
      return;
    }
    // overwriteModified 재시도는 직전에 이미 danger 확인을 받았으므로 재확인 생략.
    if (!opts.overwriteModified) {
      const confirmed = await confirmAction(
        opts.updateSlug
          ? `"${opts.updateSlug}" 스킬을 @${skill.owner.username}의 최신 버전으로 업데이트할까요? 기존 내용을 덮어쓰고 커밋됩니다.`
          : `@${skill.owner.username}의 "${skillTitle(skill)}" 스킬을 전수받을까요? 내 지식 저장소에 복사되고 커밋됩니다.`,
        opts.updateSlug
          ? { title: "스킬을 업데이트할까요?", confirmLabel: "업데이트" }
          : { title: "스킬을 전수받을까요?", confirmLabel: "전수받기" },
      );
      if (!confirmed) return;
    }
    learningId = skill.id;
    try {
      const result = await api<{ slug: string; needsSelection: boolean; updated: boolean }>(
        "/api/skill-share/learn",
        {
          method: "POST",
          body: JSON.stringify({
            id: skill.id,
            ...(opts.newName ? { newName: opts.newName } : {}),
            ...(opts.updateSlug ? { updateSlug: opts.updateSlug } : {}),
            ...(opts.overwriteModified ? { overwriteModified: true } : {}),
          }),
        },
      );
      notify(
        result.updated
          ? `"${result.slug}" 스킬을 최신 버전으로 업데이트했습니다. 다음 대화부터 적용돼요.`
          : `"${result.slug}" 스킬을 전수받았습니다. 다음 대화부터 아바타가 사용할 수 있어요.` +
              (result.needsSelection ? " (지식 저장소의 스킬 선택 목록에서 켜야 합니다)" : ""),
        "ok",
      );
      preview = null;
      renameValue = "";
      // origin/해시가 바뀌었으니 두 목록 모두 새로고침 (업데이트 배지 해소).
      void loadMine();
      void load();
    } catch (err) {
      const message = (err as Error).message;
      // 전수 후 커스텀한 사본: 덮어쓸지 사용자에게 danger 확인 후 재시도.
      if (opts.updateSlug && /전수 후 수정/.test(message)) {
        learningId = null;
        const overwrite = await confirmAction(
          `"${opts.updateSlug}" 스킬은 전수받은 뒤 수정한 스킬입니다. 업데이트하면 수정 내용이 최신 공유 버전으로 덮어써져요 (저장소 이력에는 남습니다). 덮어쓸까요?`,
          { title: "수정한 스킬을 덮어쓸까요?", confirmLabel: "덮어쓰기", tone: "danger" },
        );
        if (overwrite) {
          await learn(skill, { ...opts, overwriteModified: true });
        } else {
          notify("두 버전을 모두 보관하려면 미리보기에서 다른 이름으로 전수받으세요.", "info");
        }
        return;
      }
      notify(`전수 실패: ${message}`, "warn");
      // 이름 충돌은 새 이름으로 바로 재시도할 수 있게 미리보기 모달로 안내.
      if (/이미 있습니다/.test(message) && !preview) {
        void openPreview(skill);
      }
      if (/이미 있습니다/.test(message)) {
        queueMicrotask(() => renameInput?.focus());
      }
    } finally {
      learningId = null;
    }
  }

  // 구독 해지: 출처 마커를 삭제해 원본 업데이트 추적을 끊는다 (스킬은 유지).
  async function unlinkOrigin(skill: MySkill): Promise<void> {
    if (!skill.origin) return;
    const confirmed = await confirmAction(
      `"${skill.name}" 스킬의 원본 연결을 끊을까요? 앞으로 @${skill.origin.ownerUsername}의 업데이트 알림을 받지 않아요. 스킬 내용은 그대로 남습니다.`,
      { title: "원본 연결을 끊을까요?", confirmLabel: "연결 끊기", tone: "danger" },
    );
    if (!confirmed) return;
    try {
      await api("/api/skill-share/unlink", {
        method: "POST",
        body: JSON.stringify({ slug: skill.slug }),
      });
      notify(`"${skill.name}" 스킬의 원본 연결을 끊었습니다. 이제 완전한 내 스킬이에요.`, "ok");
      void loadMine();
      void load();
    } catch (err) {
      notify(`연결 끊기 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function setShared(skill: MySkill, next: boolean): Promise<void> {
    try {
      if (next) {
        await api("/api/skill-share/share", {
          method: "POST",
          body: JSON.stringify({ skill: skill.slug }),
        });
        notify(`"${skill.name}" 스킬을 공유했습니다. 같은 그룹 동료에게 보여요.`, "ok");
      } else {
        await api(`/api/skill-share/share/${encodeURIComponent(skill.slug)}`, { method: "DELETE" });
        notify(`"${skill.name}" 스킬 공유를 해제했습니다.`, "ok");
      }
      mySkills = mySkills.map((item) =>
        item.slug === skill.slug ? { ...item, shared: next } : item,
      );
    } catch (err) {
      notify(`공유 설정 실패: ${(err as Error).message}`, "warn");
      throw err; // Toggle이 이전 상태를 유지하도록 다시 던진다.
    }
  }
</script>

<header class="view-header">
  <div>
    <h1>스킬 배우기</h1>
    <p>동료 아바타의 스킬을 전수받고, 내 스킬을 공유하세요</p>
  </div>
  <button class="linkish" type="button" disabled={loading || mineLoading} on:click={refresh}>
    <Icon name="refresh" size={15} />
    새로고침
  </button>
</header>

<div class="view-body scroll-thin" aria-busy={loading}>
  <div class="skills-content">
  <div class="explore-search-bar">
    <Icon name="sparkles" />
    <input
      id="skills-search"
      class="explore-search"
      type="search"
      placeholder="스킬 이름·설명·공유한 사람으로 검색"
      aria-label="공유된 스킬 검색"
      aria-describedby="skills-results-status"
      bind:this={searchInput}
      bind:value={query}
    />
    {#if displayQuery}
      <button class="msg-act explore-search-clear" type="button" aria-label="검색어 지우기" title="검색어 지우기" on:click={clearSearch}>
        <Icon name="close" />
      </button>
    {/if}
  </div>
  <div class="sr-only" id="skills-results-status" role="status" aria-live="polite">{resultStatus}</div>

  <section class="skill-section" aria-labelledby="skills-learnable-title">
    <div class="skill-section-head">
      <h2 id="skills-learnable-title">공유된 스킬</h2>
      {#if !loading && !error}<span class="skill-count">{filtered.length}</span>{/if}
    </div>
    {#if loading}
      <div class="muted pad" role="status">불러오는 중…</div>
    {:else if error}
      <div class="warn-box" role="alert">
        공유된 스킬을 불러오지 못했습니다: {error}
        <button class="linkish" type="button" on:click={() => load()}>다시 시도</button>
      </div>
    {:else if !learnable.length}
      <div class="empty-note">
        아직 공유된 스킬이 없습니다. 같은 그룹 동료가 스킬을 공유하면 여기에 보여요.
        대화 중에 아바타에게 "공유된 스킬 찾아줘"라고 요청할 수도 있습니다.
      </div>
    {:else if !filtered.length}
      <div class="empty-note">
        "{displayQuery}"에 맞는 스킬이 없습니다.
        <button class="linkish small" type="button" on:click={clearSearch}>검색어 지우기</button>
      </div>
    {:else}
      <div class="skill-grid" aria-label={displayQuery ? `${displayQuery} 검색 결과` : "공유된 스킬 목록"}>
        {#each listingViews as view (view.skill.id)}
          {@const skill = view.skill}
          <div class="skill-card" class:busy={learningId === skill.id} aria-busy={learningId === skill.id}>
            <div class="sk-head">
              <strong class="sk-name">{skillTitle(skill)}</strong>
              {#if view.own}
                <span class="tag accent">나</span>
              {/if}
              {#if skill.displayName && skill.displayName !== skill.skillName}
                <span class="tag">{skill.skillName}</span>
              {/if}
              {#if skill.learnCount > 0}
                <span class="tag accent" title={`지금까지 ${skill.learnCount}번 전수된 스킬`}>전수 {skill.learnCount}회</span>
              {/if}
              {#if view.updateAvailable}
                <span class="tag write" title="전수받은 후 원본이 업데이트됐어요">업데이트 있음</span>
              {:else if view.copy}
                <span class="tag" title={`"${view.copy.slug}"로 전수받은 스킬`}>전수받음</span>
              {/if}
            </div>
            {#if skill.description}
              <p class="sk-desc">{skill.description}</p>
            {:else}
              <p class="sk-desc muted">설명이 없습니다.</p>
            {/if}
            <div class="sk-owner">
              <AvatarImage user={skill.owner} size={22} alt="" />
              <span class="sk-owner-name">{skill.owner.alias || skill.owner.displayName}</span>
              <span class="sk-owner-handle">@{skill.owner.username}</span>
              <span class="sk-time">{timeLabel(skill.updatedAt)}</span>
            </div>
            <div class="sk-actions">
              <button class="linkish small" type="button" disabled={Boolean(learningId)} on:click={() => openPreview(skill)}>
                미리보기
              </button>
              {#if view.updateAvailable && view.copy}
                <button
                  class="primary small"
                  type="button"
                  disabled={Boolean(learningId)}
                  aria-label={`${skillTitle(skill)} 스킬 업데이트 받기`}
                  on:click={() => learn(skill, { updateSlug: view.copy!.slug })}
                >
                  {learningId === skill.id ? "업데이트 중…" : "업데이트 받기"}
                </button>
              {:else if !view.own && !view.copy}
                <button
                  class="primary small"
                  type="button"
                  disabled={Boolean(learningId)}
                  aria-label={`${skillTitle(skill)} 스킬 전수받기`}
                  on:click={() => learn(skill)}
                >
                  {learningId === skill.id ? "전수 중…" : "전수받기"}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="skill-section" aria-labelledby="skills-mine-title">
    <div class="skill-section-head">
      <h2 id="skills-mine-title">내 아바타의 스킬 공유</h2>
      {#if !mineLoading && !mineError && repoConfigured}<span class="skill-count">{sharedCount}/{mySkills.length} 공유 중</span>{/if}
    </div>
    {#if mineLoading}
      <div class="muted pad" role="status">불러오는 중…</div>
    {:else if mineError}
      <div class="warn-box" role="alert">
        내 스킬 목록을 불러오지 못했습니다: {mineError}
        <button class="linkish" type="button" on:click={() => loadMine()}>다시 시도</button>
      </div>
    {:else if !repoConfigured}
      <div class="empty-note">
        지식 저장소를 연결하면 아바타의 스킬을 공유하고 전수받을 수 있어요.
        <button class="linkish small" type="button" on:click={() => goView("settings", "knowledge")}>지식 저장소 연결하기</button>
      </div>
    {:else if !mySkills.length}
      <div class="empty-note">
        아직 지식 저장소에 스킬이 없습니다. 대화에서 아바타에게 "○○ 스킬 만들어줘"라고
        요청하면 스킬을 만들 수 있어요.
      </div>
    {:else}
      {#if mySkills.length > 8}
        <div class="sk-mine-search">
          <input
            type="search"
            placeholder="내 스킬 검색"
            aria-label="내 스킬 검색"
            bind:value={mineQuery}
          />
        </div>
      {/if}
      <div class="skill-mine-panel">
        {#each mineFiltered as skill (skill.slug)}
          <div class="skill-mine-row">
            <div class="sk-mine-meta">
              <div class="sk-mine-title">
                <strong>{skill.name}</strong>
                {#if skill.name !== skill.slug}<span class="tag">{skill.slug}</span>{/if}
                {#if skill.learnCount > 0}
                  <span class="tag accent" title={`동료가 지금까지 ${skill.learnCount}번 전수받았어요`}>전수 {skill.learnCount}회</span>
                {/if}
              </div>
              {#if skill.origin}
                <span class="sk-mine-desc">@{skill.origin.ownerUsername}의 {skill.origin.skillName}에서 전수받음</span>
              {/if}
              {#if skill.description}<span class="sk-mine-desc">{skill.description}</span>{/if}
            </div>
            <div class="sk-mine-actions">
              {#if skill.origin}
                <button
                  class="linkish small"
                  type="button"
                  title={`@${skill.origin.ownerUsername}의 업데이트 추적을 중단합니다 (스킬은 유지)`}
                  aria-label={`${skill.name} 원본 연결 끊기`}
                  on:click={() => unlinkOrigin(skill)}
                >연결 끊기</button>
              {/if}
              <Toggle
                on={skill.shared}
                label={`${skill.name} 공유`}
                onChange={(next) => setShared(skill, next)}
              />
            </div>
          </div>
        {:else}
          <div class="skill-mine-row"><span class="sk-mine-desc">"{mineQuery.trim()}"에 맞는 스킬이 없습니다.</span></div>
        {/each}
      </div>
      <p class="sk-share-hint">공유한 스킬은 같은 그룹 동료(아바타 공유가 켜진 그룹)에게만 보입니다.</p>
    {/if}
  </section>
  </div>
</div>

{#if preview}
  {@const previewView = listingViews.find((v) => v.skill.id === preview!.id)}
  {@const previewOwn = preview.ownerUserId === myUserId}
  {@const previewUpdateSlug =
    previewView?.updateAvailable && previewView.copy ? previewView.copy.slug : null}
  <Modal cardClass="skill-preview-card" ariaLabelledby="skill-preview-title" on:close={closePreview}>
    <h2 id="skill-preview-title">{skillTitle(preview)}</h2>
    <div class="sk-owner sk-preview-owner">
      <AvatarImage user={preview.owner} size={22} alt="" />
      <span class="sk-owner-name">{preview.owner.alias || preview.owner.displayName}</span>
      <span class="sk-owner-handle">@{preview.owner.username}</span>
      {#if previewOwn}<span class="tag accent">나</span>{/if}
      {#if preview.learnCount > 0}
        <span class="tag accent">전수 {preview.learnCount}회</span>
      {/if}
      {#if previewUpdateSlug}<span class="tag write">업데이트 있음</span>{/if}
    </div>
    {#if preview.description}<p class="sk-desc sk-preview-desc">{preview.description}</p>{/if}
    {#if previewLoading}
      <div class="muted pad" role="status">스킬 내용을 불러오는 중…</div>
    {:else if previewError}
      <div class="warn-box" role="alert">{previewError}</div>
    {:else}
      <pre class="sk-preview-content scroll-thin">{previewContent}</pre>
    {/if}
    {#if !previewOwn}
      <label class="field sk-rename-field">
        <span>다른 이름으로 전수 (선택)</span>
        <input
          type="text"
          placeholder={preview.skillName}
          aria-label="전수받을 새 스킬 이름"
          bind:this={renameInput}
          bind:value={renameValue}
          disabled={Boolean(learningId)}
        />
      </label>
    {/if}
    <div class="sk-actions sk-preview-actions">
      <button class="linkish" type="button" disabled={Boolean(learningId)} on:click={closePreview}>닫기</button>
      {#if !previewOwn}
        {#if previewUpdateSlug && !renameValue.trim()}
          <button
            class="primary"
            type="button"
            disabled={Boolean(learningId) || previewLoading || Boolean(previewError)}
            on:click={() => preview && learn(preview, { updateSlug: previewUpdateSlug })}
          >
            {learningId ? "업데이트 중…" : "업데이트 받기"}
          </button>
        {:else}
          <button
            class="primary"
            type="button"
            disabled={Boolean(learningId) || previewLoading || Boolean(previewError)}
            on:click={() => preview && learn(preview, { newName: renameValue.trim() || undefined })}
          >
            {learningId ? "전수 중…" : "전수받기"}
          </button>
        {/if}
      {/if}
    </div>
  </Modal>
{/if}

<style>
  /* Explore-family layout (docs/DESIGN.md §3): content column capped like the
     search bar, sections directly on the canvas (no card-in-card), grid density
     tokens matching .avatar-grid — card padding --s-5, grid gap --s-4. */
  .skills-content {
    max-width: 1100px;
    margin: 0 auto;
  }
  .skill-section {
    margin-top: var(--s-6);
  }
  .skill-section:first-of-type {
    margin-top: 0;
  }
  .skill-section-head {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    margin: 0 0 var(--s-3);
  }
  .skill-section-head h2 {
    margin: 0;
    font-size: var(--t-md);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .skill-count {
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--muted);
  }

  .skill-grid {
    --pad-card: var(--s-5);
    --gap-stack: var(--s-4);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--gap-stack);
    align-items: stretch;
  }
  .skill-card {
    display: flex;
    flex-direction: column;
    gap: var(--s-2-5);
    padding: var(--pad-card);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--panel);
    min-width: 0;
  }
  .skill-card.busy {
    opacity: 0.7;
  }
  .sk-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    min-width: 0;
  }
  .sk-name {
    font-size: var(--t-md);
    font-weight: 700;
    letter-spacing: -0.01em;
    word-break: break-all;
  }
  .sk-desc {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-soft);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* Owner row is anchored to the card bottom so short cards keep their
     attribution + actions aligned across the grid row. */
  .sk-owner {
    display: flex;
    align-items: center;
    gap: var(--s-1-5);
    margin-top: auto;
    padding-top: var(--s-1);
    font-size: var(--t-xs);
    color: var(--muted);
    min-width: 0;
  }
  .sk-owner-name {
    font-weight: 600;
    font-size: var(--t-sm);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sk-owner-handle {
    white-space: nowrap;
  }
  .sk-time {
    margin-left: auto;
    white-space: nowrap;
  }
  .sk-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
  }

  .sk-mine-search {
    margin-bottom: var(--s-2);
  }
  .sk-mine-search input {
    width: min(320px, 100%);
  }
  .skill-mine-panel {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--panel);
    overflow: hidden;
  }
  .skill-mine-row {
    display: flex;
    align-items: center;
    gap: var(--s-4);
    padding: var(--s-3) var(--s-4);
  }
  .skill-mine-row + .skill-mine-row {
    border-top: 1px solid var(--line-soft);
  }
  .sk-mine-meta {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--s-0-5);
    min-width: 0;
  }
  .sk-mine-title {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    font-size: var(--t-base);
  }
  .sk-mine-desc {
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .sk-mine-actions {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-shrink: 0;
  }
  .sk-share-hint {
    margin: var(--s-2) var(--s-1) 0;
    font-size: var(--t-xs);
    color: var(--muted);
  }

  .sk-preview-owner {
    margin: var(--s-1) 0 0;
    padding-top: 0;
  }
  .sk-preview-desc {
    margin: var(--s-2) 0 0;
  }
  .sk-preview-content {
    max-height: 320px;
    margin-top: var(--s-3);
    overflow: auto;
    padding: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--bg-subtle);
    font-size: var(--t-xs);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .sk-rename-field {
    margin-top: var(--s-3);
  }
  .sk-preview-actions {
    margin-top: var(--s-4);
  }
  :global(.skill-preview-card) {
    width: min(680px, calc(100vw - 2 * var(--s-4)));
  }
</style>
