<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api";
  import { loadInboxData } from "../lib/loaders";
  import { goView } from "../lib/nav";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { formatDate } from "../lib/format";
  import { selectConversation } from "../lib/chat";
  import type { AvatarNotification, KnowledgeRequest } from "../lib/types";

  let loading = true;
  let error = "";

  onMount(load);

  $: unread = $appState.notifications.filter((item) => !item.readAt);
  $: openRequests = $appState.knowledgeRequests.filter((item) => item.status === "open");
  $: visibleNotifications = $appState.inboxFilter === "unread" ? unread : $appState.notifications;
  $: showRequests = $appState.inboxFilter === "all" || $appState.inboxFilter === "requests";
  $: showNotifications = $appState.inboxFilter === "all" || $appState.inboxFilter === "unread";

  async function load() {
    loading = true;
    error = "";
    try {
      await loadInboxData();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function markRead(notification: AvatarNotification) {
    if (notification.readAt) return;
    replaceState({
      notifications: $appState.notifications.map((item) => (item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item)),
    });
    api(`/api/me/notifications/${encodeURIComponent(notification.id)}/read`, { method: "PATCH" }).catch(() => load());
  }

  async function deleteNotification(notification: AvatarNotification) {
    await api(`/api/me/notifications/${encodeURIComponent(notification.id)}`, { method: "DELETE" });
    replaceState({ notifications: $appState.notifications.filter((item) => item.id !== notification.id) });
  }

  async function readAll() {
    await api("/api/me/notifications/read-all", { method: "POST" });
    await load();
  }

  async function clearAll() {
    if (!window.confirm("모든 알림을 삭제할까요?")) return;
    await api("/api/me/notifications", { method: "DELETE" });
    await load();
  }

  async function resolveRequest(request: KnowledgeRequest) {
    await api(`/api/me/knowledge/requests/${encodeURIComponent(request.id)}`, { method: "DELETE" });
    replaceState({ knowledgeRequests: $appState.knowledgeRequests.filter((item) => item.id !== request.id) });
    notify("지식 요청을 처리 완료로 정리했습니다.", "ok");
  }

  async function openConversation(notification: AvatarNotification) {
    if (!notification.conversationId) return;
    await markRead(notification);
    goView("chat");
    await selectConversation(notification.conversationId);
  }
</script>

<header class="view-header">
  <div>
    <h1>알림</h1>
    <p>아바타가 남긴 알림과 지식 요청을 확인하세요</p>
  </div>
  <div class="header-actions">
    <button class="ghost-sm" type="button" on:click={readAll} disabled={!unread.length}>모두 읽음</button>
    <button class="ghost-sm" type="button" on:click={clearAll} disabled={!$appState.notifications.length}>알림 비우기</button>
  </div>
</header>

<div class="view-body scroll-thin">
  <div class="tabbar compact">
    {#each [
      { id: "all", label: `전체 ${$appState.notifications.length + openRequests.length}` },
      { id: "unread", label: `안 읽음 ${unread.length}` },
      { id: "requests", label: `지식 요청 ${openRequests.length}` },
    ] as item}
      <button type="button" class:active={$appState.inboxFilter === item.id} on:click={() => updateState((state) => (state.inboxFilter = item.id as any))}>{item.label}</button>
    {/each}
  </div>

  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if error}
    <div class="warn-box">
      알림을 불러오지 못했습니다: {error}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else}
    {#if showRequests}
      <section class="settings-card">
        <h3>지식 요청</h3>
        {#if !openRequests.length}
          <div class="empty-note">열린 지식 요청이 없습니다.</div>
        {:else}
          <div class="inbox-list">
            {#each openRequests as request (request.id)}
              <article class="inbox-item">
                <div class="inbox-icon"><Icon name="book" /></div>
                <div>
                  <strong>{request.askerName || "동료"}의 질문</strong>
                  <p>{request.question}</p>
                  <span class="muted">{formatDate(request.createdAt)}</span>
                </div>
                <button class="primary small" type="button" on:click={() => resolveRequest(request)}>처리 완료</button>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}

    {#if showNotifications}
      <section class="settings-card">
        <h3>알림</h3>
        {#if !visibleNotifications.length}
          <div class="empty-note">표시할 알림이 없습니다.</div>
        {:else}
          <div class="inbox-list">
            {#each visibleNotifications as notification (notification.id)}
              <article class="inbox-item" class:unread={!notification.readAt}>
                <div class="inbox-icon"><Icon name="bell" /></div>
                <div>
                  <strong>{notification.title}</strong>
                  <p>{notification.message}</p>
                  <span class="muted">{notification.avatarDisplayName} · {formatDate(notification.createdAt)}</span>
                </div>
                <div class="button-row">
                  {#if notification.conversationId}
                    <button class="ghost-sm" type="button" on:click={() => openConversation(notification)}>결과 보기</button>
                  {/if}
                  <button class="ghost-sm" type="button" on:click={() => markRead(notification)} disabled={Boolean(notification.readAt)}>읽음</button>
                  <button class="danger small" type="button" on:click={() => deleteNotification(notification)}>삭제</button>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>
