<script lang="ts">
  import AvatarImage from "./AvatarImage.svelte";
  import AdminPasswordResetModal from "./AdminPasswordResetModal.svelte";
  import { api } from "../lib/api";
  import { appState, notify } from "../lib/state";
  import { timeLabel } from "../lib/format";
  import type { AdminUserDetail, AdminUserSummary } from "../lib/types";

  export let user: AdminUserSummary;
  export let reload: () => Promise<void>;

  let expanded = false;
  let loading = false;
  let loadError = "";
  let detail: AdminUserDetail | null = null;
  let busy = false;
  let showPasswordModal = false;

  $: isMe = user.id === $appState.user?.id;
  $: isAdmin = user.roles?.includes("admin");
  $: willHide = user.visibility !== "private";

  async function toggle() {
    if (expanded) {
      expanded = false;
      return;
    }
    expanded = true;
    if (detail) return;
    await loadDetail();
  }

  async function loadDetail() {
    loading = true;
    loadError = "";
    try {
      const d = await api<{ user: AdminUserDetail }>(`/api/admin/users/${encodeURIComponent(user.id)}`);
      detail = d.user;
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function run(fn: () => Promise<void>, errLabel: string, successLabel = "") {
    busy = true;
    try {
      await fn();
    } catch (err) {
      busy = false;
      notify(`${errLabel}: ${(err as Error).message}`);
      return;
    }
    try {
      await reload();
      if (successLabel) notify(successLabel, "ok");
    } catch (err) {
      notify(`작업은 완료됐지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      busy = false;
    }
  }

  function toggleRole() {
    const verb = isAdmin ? "해제" : "부여";
    if (!window.confirm(`${user.displayName}(@${user.username})님의 관리자 권한을 ${verb}할까요?`)) return;
    run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(user.id)}/roles`, {
          method: "POST",
          body: JSON.stringify({ role: "admin", grant: !isAdmin }),
        }).then(() => undefined),
      "권한 변경 실패",
      `${user.displayName}님의 관리자 권한을 ${verb}했습니다.`,
    );
  }

  function toggleVisibility() {
    run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(user.id)}/visibility`, {
          method: "PUT",
          body: JSON.stringify({ visibility: willHide ? "private" : "public" }),
        }).then(() => undefined),
      "공개 설정 실패",
      `${user.displayName}님의 공개 범위를 ${willHide ? "비공개" : "공개"}로 전환했습니다.`,
    );
  }

  function toggleSuspend() {
    if (!user.suspended && !window.confirm(`${user.displayName} 계정을 정지할까요?\n로그인과 활성 세션이 즉시 차단됩니다.`)) return;
    run(
      () =>
        api(`/api/admin/users/${encodeURIComponent(user.id)}/suspend`, {
          method: "POST",
          body: JSON.stringify({ suspended: !user.suspended }),
        }).then(() => undefined),
      "상태 변경 실패",
      `${user.displayName} 계정을 ${user.suspended ? "활성화" : "정지"}했습니다.`,
    );
  }

  function forceLogout() {
    run(
      async () => {
        const r = await api<{ revoked?: number }>(`/api/admin/users/${encodeURIComponent(user.id)}/logout`, { method: "POST" });
        notify(`세션 ${r.revoked ?? 0}개를 종료했습니다.`, "ok");
      },
      "로그아웃 실패",
    );
  }

  function deleteUser() {
    if (!window.confirm(`${user.displayName}(@${user.username}) 계정을 삭제할까요?\n이 사용자의 아바타·대화·설정이 모두 영구 삭제되며 되돌릴 수 없습니다.`)) return;
    run(
      () => api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "DELETE" }).then(() => undefined),
      "삭제 실패",
      `${user.displayName} 계정을 삭제했습니다.`,
    );
  }

  const detailItems = (d: AdminUserDetail) => [
    { k: "시작한 대화", v: d.conversationsStarted },
    { k: "받은 대화", v: d.conversationsReceived },
    { k: "플러그인", v: d.pluginCount },
    { k: "루틴", v: `${d.routinesActive}/${d.routinesTotal}` },
    { k: "시크릿", v: d.secretCount },
    { k: "활성 세션", v: d.activeSessions },
    { k: "미응답 질문", v: d.openRequests },
    { k: "GIT_TOKEN", v: d.gitTokenSet ? "있음" : "없음" },
    { k: "지식 저장소", v: d.knowledgeRepoSet ? "연결됨" : "없음" },
  ];
</script>

<div class="admin-user" class:is-suspended={user.suspended}>
  <div class="admin-row">
    <AvatarImage user={user} size={40} alt="" />
    <div class="ar-main">
      <strong>{user.displayName}</strong>
      <div class="muted">@{user.username} · 가입 {timeLabel(user.createdAt)} · 최근 {user.lastSeenAt ? timeLabel(user.lastSeenAt) : "기록 없음"}</div>
    </div>
    <div class="ar-tags">
      <span class="tag {isAdmin ? 'write' : 'read'}">{isAdmin ? "관리자" : "일반 사용자"}</span>
      {#if user.visibility === "public"}<span class="tag accent">공개</span>{/if}
      {#if user.visibility === "group"}<span class="tag">그룹 공개</span>{/if}
      {#if user.visibility === "private"}<span class="tag">비공개</span>{/if}
      {#if user.suspended}<span class="tag danger">정지</span>{/if}
      {#if user.activeSessions}<span class="tag read">세션 {user.activeSessions}</span>{/if}
      {#if isMe}<span class="tag">나</span>{/if}
    </div>
    <div class="ar-actions">
      <button
        class="ghost-sm"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? `${user.displayName} 사용자 관리 접기` : `${user.displayName} 사용자 관리 열기`}
        title={expanded ? `${user.displayName} 사용자 관리 접기` : `${user.displayName} 사용자 관리 열기`}
        on:click={toggle}
      >{expanded ? "접기" : "관리"}</button>
    </div>
  </div>

  {#if expanded}
    <div class="ar-detail">
      {#if loading}
        <div class="muted">불러오는 중…</div>
      {:else if loadError}
        <div class="warn-box">
          불러오기 실패: {loadError}
          <button class="linkish" type="button" on:click={loadDetail}>다시 시도</button>
        </div>
      {:else if detail}
        <div class="ud-grid">
          {#each detailItems(detail) as it}
            <div class="ud-item">
              <span class="ud-val">{it.v ?? 0}</span>
              <span class="ud-key muted">{it.k}</span>
            </div>
          {/each}
        </div>
        <div class="ud-actions" aria-busy={busy}>
          <button class="ghost-sm" type="button" disabled={isMe || busy} on:click={toggleRole}>{isAdmin ? "관리자 해제" : "관리자 지정"}</button>
          <button class="ghost-sm" type="button" disabled={busy} on:click={toggleVisibility}>{willHide ? "비공개로 전환" : "공개로 전환"}</button>
          <button class="ghost-sm {user.suspended ? '' : 'danger'}" type="button" disabled={isMe || busy} on:click={toggleSuspend}>{user.suspended ? "활성화" : "정지"}</button>
          <button class="ghost-sm" type="button" disabled={busy} on:click={() => (showPasswordModal = true)}>비밀번호 재설정</button>
          <button class="ghost-sm" type="button" disabled={busy} on:click={forceLogout}>강제 로그아웃</button>
          <button class="ghost-sm danger" type="button" disabled={isMe || busy} on:click={deleteUser}>삭제</button>
          {#if isMe}
            <p class="muted ud-self-note">자기 자신에게는 권한 해제·정지·삭제를 적용할 수 없습니다.</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if showPasswordModal}
  <AdminPasswordResetModal user={user} on:close={() => (showPasswordModal = false)} on:done={reload} />
{/if}
