<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import InboxKnowledgeRow from "./InboxKnowledgeRow.svelte";
  import { api } from "../lib/api";
  import { loadInboxData } from "../lib/loaders";
  import { goView } from "../lib/nav";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { timeLabel } from "../lib/format";
  import { openSeededChat, selectConversation } from "../lib/chat";
  import type { AvatarNotification, KnowledgeRequest } from "../lib/types";

  type Filter = "all" | "unread" | "requests" | "notifications";
  type InboxItem =
    | { kind: "request"; at: string; request: KnowledgeRequest }
    | { kind: "notification"; at: string; notification: AvatarNotification };

  let loading = true;
  // Per-backend load failures (null when that backend loaded). Partial failures
  // still render whatever did load, with a warn-box listing the failed backends.
  let requestsError: string | null = null;
  let notificationsError: string | null = null;
  let routinesError: string | null = null;
  // True only when EVERYTHING failed — then we blank the list and show retry.
  let hardError = false;

  // Per-item busy flags (delete in flight) so a row can show aria-busy + disable.
  let busyIds = new Set<string>();
  let bulkBusy = false; // read-all / clear-all in flight

  onMount(load);

  $: openRequests = $appState.knowledgeRequests.filter((r) => r.status === "open");
  $: notifications = $appState.notifications;
  $: unread = notifications.filter((n) => !n.readAt);

  // Merged, reverse-chronological list of both backends.
  $: items = [
    ...openRequests.map((r): InboxItem => ({ kind: "request", at: r.createdAt || "", request: r })),
    ...notifications.map((n): InboxItem => ({ kind: "notification", at: n.createdAt || "", notification: n })),
  ].sort((a, b) => (b.at || "").localeCompare(a.at || ""));

  $: filter = $appState.inboxFilter as Filter;
  $: filtered =
    filter === "requests"
      ? items.filter((item) => item.kind === "request")
      : filter === "unread"
        ? items.filter((item) => item.kind === "notification" && !item.notification.readAt)
        : filter === "notifications"
          ? items.filter((item) => item.kind === "notification")
          : items;

  $: filters = [
    { id: "all" as Filter, label: `전체 ${openRequests.length + notifications.length}` },
    { id: "requests" as Filter, label: `정보 요청 ${openRequests.length}` },
    { id: "unread" as Filter, label: `읽지 않은 알림 ${unread.length}` },
    { id: "notifications" as Filter, label: `알림 ${notifications.length}` },
  ];

  $: loadWarnings = [
    requestsError ? "정보 요청" : null,
    notificationsError ? "아바타 알림" : null,
    routinesError ? "루틴 결과 링크" : null,
  ].filter((x): x is string => Boolean(x));

  const emptyTexts: Record<Filter, string> = {
    all: "새 알림이나 정보 요청이 없습니다.",
    requests: "열린 정보 요청이 없습니다.",
    unread: "읽지 않은 알림이 없습니다.",
    notifications: "아바타 알림이 없습니다.",
  };
  $: emptyText =
    items.length && filter !== "all"
      ? `이 필터에 해당하는 항목이 없습니다. ${emptyTexts[filter] || ""}`.trim()
      : emptyTexts[filter] || emptyTexts.all;

  async function load() {
    loading = true;
    const result = await loadInboxData();
    requestsError = result.requestsError;
    notificationsError = result.notificationsError;
    routinesError = result.routinesError;
    hardError = Boolean(requestsError && notificationsError);
    loading = false;
  }

  // Reload after a mutation; throws on transient failure so callers can warn.
  async function refresh() {
    const result = await loadInboxData();
    requestsError = result.requestsError;
    notificationsError = result.notificationsError;
    routinesError = result.routinesError;
    if (result.requestsError || result.notificationsError) {
      throw new Error(result.notificationsError || result.requestsError || "목록 새로고침에 실패했습니다");
    }
  }

  function setBusy(id: string, on: boolean) {
    const next = new Set(busyIds);
    if (on) next.add(id);
    else next.delete(id);
    busyIds = next;
  }

  function setFilter(id: Filter) {
    updateState((state) => (state.inboxFilter = id));
  }
  function resetFilter() {
    updateState((state) => (state.inboxFilter = "all"));
  }

  function isRoutineConversation(conversationId: string | null | undefined): boolean {
    return Boolean(conversationId) && $appState.routineConversations.some((c) => c.id === conversationId);
  }

  // Mark a notification read: optimistic update + fire-and-forget PATCH, reload
  // on failure. Used by both the row click and the explicit handoffs.
  function markRead(notification: AvatarNotification, toast = false) {
    if (notification.readAt) return;
    replaceState({
      notifications: $appState.notifications.map((item) =>
        item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item,
      ),
    });
    if (toast) notify("알림을 읽었습니다.", "ok");
    api(`/api/me/notifications/${encodeURIComponent(notification.id)}/read`, { method: "PATCH" }).catch(() => load());
  }

  // Whole-row click → open a fresh chat with my own avatar seeded with the topic
  // (and mark read). Inner buttons handle themselves (guarded in the handler).
  function openNotificationChat(notification: AvatarNotification) {
    if (busyIds.has(notification.id)) return;
    markRead(notification);
    const seed = `다음은 네가 남긴 알림이야. 이 주제로 이어서 이야기하자.\n\n[${notification.title}]\n${notification.message}`;
    void openSeededChat(seed);
  }

  function onRowClick(event: MouseEvent, notification: AvatarNotification) {
    if (busyIds.has(notification.id)) return;
    if ((event.target as HTMLElement | null)?.closest("button")) return; // inner actions
    openNotificationChat(notification);
  }

  function onRowKeydown(event: KeyboardEvent, notification: AvatarNotification) {
    if (busyIds.has(notification.id)) return;
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openNotificationChat(notification);
    }
  }

  // Routine results route to the routines view; ordinary conversations open in chat.
  async function openResult(notification: AvatarNotification) {
    if (!notification.conversationId) return;
    markRead(notification);
    if (isRoutineConversation(notification.conversationId)) {
      goView("routines", notification.conversationId);
    } else {
      goView("chat");
      await selectConversation(notification.conversationId);
    }
  }

  async function deleteNotification(notification: AvatarNotification) {
    if (busyIds.has(notification.id)) return;
    setBusy(notification.id, true);
    try {
      await api(`/api/me/notifications/${encodeURIComponent(notification.id)}`, { method: "DELETE" });
    } catch (e) {
      setBusy(notification.id, false);
      notify(`삭제 실패: ${(e as Error).message}`);
      return;
    }
    try {
      await refresh();
      notify("알림을 삭제했습니다.", "ok");
    } catch (e) {
      setBusy(notification.id, false);
      notify(`알림은 삭제했지만 목록 새로고침에 실패했습니다: ${(e as Error).message}`, "warn");
      return;
    }
    setBusy(notification.id, false);
  }

  async function readAll() {
    const count = unread.length;
    if (!count || bulkBusy) return;
    bulkBusy = true;
    try {
      await api("/api/me/notifications/read-all", { method: "POST" });
    } catch (e) {
      bulkBusy = false;
      notify(`처리 실패: ${(e as Error).message}`);
      return;
    }
    try {
      await refresh();
      notify(`알림 ${count}개를 읽음 처리했습니다.`, "ok");
    } catch (e) {
      notify(`알림은 읽음 처리했지만 목록 새로고침에 실패했습니다: ${(e as Error).message}`, "warn");
    }
    bulkBusy = false;
  }

  async function clearAll() {
    const count = notifications.length;
    if (!count || bulkBusy) return;
    if (!window.confirm(`알림 ${count}개를 모두 삭제할까요? 정보 요청은 삭제되지 않습니다.`)) return;
    bulkBusy = true;
    try {
      await api("/api/me/notifications", { method: "DELETE" });
    } catch (e) {
      bulkBusy = false;
      notify(`삭제 실패: ${(e as Error).message}`);
      return;
    }
    try {
      await refresh();
      notify(`알림 ${count}개를 삭제했습니다.`, "ok");
    } catch (e) {
      notify(`알림은 삭제했지만 목록 새로고침에 실패했습니다: ${(e as Error).message}`, "warn");
    }
    bulkBusy = false;
  }
</script>

<header class="view-header">
  <div>
    <h1>알림</h1>
    <p>아바타가 남긴 알림과 동료의 정보 요청을 한곳에서 확인하세요</p>
  </div>
  <div class="head-actions">
    {#if unread.length}
      <button class="ghost-sm" type="button" disabled={bulkBusy} on:click={readAll}>
        {bulkBusy ? "처리 중…" : "알림 모두 읽음"}
      </button>
    {/if}
    {#if notifications.length}
      <button class="ghost-sm danger" type="button" disabled={bulkBusy} on:click={clearAll}>알림 비우기</button>
    {/if}
  </div>
</header>

<div class="view-body scroll-thin inbox-body">
  {#if loading}
    <div class="muted pad">불러오는 중…</div>
  {:else if hardError}
    <div class="warn-box">
      알림을 불러오지 못했습니다: {notificationsError || requestsError || "네트워크 오류"}
      <button class="linkish" type="button" on:click={load}>다시 시도</button>
    </div>
  {:else}
    <div class="inbox-wrap">
      <section class="settings-card">
        <div class="panel-section-head">
          <div>
            <h3>알림</h3>
            <p class="muted">알림을 누르면 그 주제로 내 아바타와 대화할 수 있고, 휴지통으로 삭제합니다. ‘정보 요청’은 답을 적어 보내면 아바타가 지식 저장소에 기록합니다.</p>
          </div>
        </div>

        {#if loadWarnings.length}
          <div class="warn-box inbox-load-warning">
            일부 항목({loadWarnings.join(" · ")})을 불러오지 못했습니다. 표시된 목록은 일부만 최신일 수 있습니다.
            <button class="linkish" type="button" on:click={load}>다시 시도</button>
          </div>
        {/if}

        <div class="inbox-filter seg-control" role="radiogroup" aria-label="알림 필터">
          {#each filters as f}
            <button
              class="seg-btn"
              class:active={filter === f.id}
              type="button"
              role="radio"
              aria-checked={filter === f.id ? "true" : "false"}
              tabindex={filter === f.id ? 0 : -1}
              on:click={() => setFilter(f.id)}
            >{f.label}</button>
          {/each}
        </div>

        <div class="inbox-list">
          {#if !filtered.length}
            <div class="empty-note">
              {emptyText}
              {#if items.length && filter !== "all"}
                <button class="linkish small" type="button" on:click={resetFilter}>전체 보기</button>
              {/if}
            </div>
          {:else}
            {#each filtered as item (item.kind === "request" ? `r:${item.request.id}` : `n:${item.notification.id}`)}
              {#if item.kind === "request"}
                <InboxKnowledgeRow request={item.request} {refresh} />
              {:else}
                {@const n = item.notification}
                <div
                  class="notification-row clickable"
                  class:unread={!n.readAt}
                  role="button"
                  tabindex="0"
                  aria-label={`알림 열기: ${n.title}`}
                  aria-busy={busyIds.has(n.id) ? "true" : "false"}
                  title="알림 주제로 대화 열기"
                  on:click={(e) => onRowClick(e, n)}
                  on:keydown={(e) => onRowKeydown(e, n)}
                >
                  <div class="pr-main">
                    <div class="inbox-row-head">
                      <span class="inbox-chip note">알림</span>
                      <strong>{n.title}</strong>
                    </div>
                    <div class="pr-sub">{n.avatarDisplayName} · {timeLabel(n.createdAt)}</div>
                    <p>{n.message}</p>
                  </div>
                  <div class="kr-actions">
                    {#if isRoutineConversation(n.conversationId)}
                      <button class="ghost-sm" type="button" on:click={() => openResult(n)}>결과 보기</button>
                    {/if}
                    <button
                      class="msg-act danger"
                      type="button"
                      aria-label="알림 삭제"
                      title="알림 삭제"
                      disabled={busyIds.has(n.id)}
                      on:click={() => deleteNotification(n)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </div>
              {/if}
            {/each}
          {/if}
        </div>
      </section>
    </div>
  {/if}
</div>
