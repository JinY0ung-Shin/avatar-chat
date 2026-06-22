<script lang="ts">
  import { afterUpdate, onMount, tick } from "svelte";
  import ActivityTree from "../components/ActivityTree.svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import CapabilitiesPanel from "../components/CapabilitiesPanel.svelte";
  import CanvasPanel from "../components/CanvasPanel.svelte";
  import Icon from "../components/Icon.svelte";
  import PromptModal from "../components/PromptModal.svelte";
  import { activePane, appState, newId, notify, readState, updateState } from "../lib/state";
  import {
    PLUGIN_STATUS_LABELS,
    addConversationToSplit,
    attachActiveRun,
    closePane,
    newChat,
    regenerate,
    respondPlanReview,
    selectConversation,
    sendMessage,
    startChatWith,
    stopPane,
  } from "../lib/chat";
  import { api } from "../lib/api";
  import { autosize, clickOutside, copyText, downscaleImageToDataUrl, enhanceMarkdown, readFileAsDataUrl } from "../lib/dom";
  import { loadAvatars, loadConversations } from "../lib/loaders";
  import { routeFromHash } from "../lib/nav";
  import { formatUsageLabel, renderMarkdown, timeLabel } from "../lib/format";
  import { menuCommandsForPane, filterSlashCommands, type SlashCommand } from "../lib/slash";
  import type { AgentActivity, AvatarSummary, ChatPane, ImageMediaType, MessageAttachment, PendingImage, SkillInfo, StoredMessage } from "../lib/types";
  import { DEFAULT_MODEL_TIER } from "../../../server/modelTiers";
  import { DEFAULT_EFFORT_LEVEL } from "../../../server/effortLevels";
  import {
    DEFAULT_MCP_TOOL_GROUPS,
    MCP_TOOL_GROUPS,
    normalizeMcpToolGroups,
    type McpToolGroupId,
  } from "../../../shared/mcpToolGroups";

  let transcriptEls: Record<string, HTMLDivElement> = {};
  let splitAvatarId = "";
  // Slash autocomplete: which pane it's open for + the selected index.
  let slashPaneId = "";
  let slashIndex = 0;
  let physicalKeyboard = false;
  // Per-pane group-knowledge dropdown open state.
  let gkOpenPaneId = "";
  // Per-pane MCP tool-group checkbox panel open state.
  let mcpToolsOpenPaneId = "";
  // Per-pane mobile composer settings disclosure state.
  let composerSettingsOpenPaneId = "";
  // Plan-approval: which pane is in "수정 요청" (reject-with-feedback) mode, and its draft.
  let planRejectPaneId = "";
  let planFeedback = "";

  function approvePlan(pane: ChatPane): void {
    void respondPlanReview(pane.id, "approved");
  }
  function startRejectPlan(pane: ChatPane): void {
    planRejectPaneId = pane.id;
    planFeedback = "";
  }
  function cancelRejectPlan(): void {
    planRejectPaneId = "";
    planFeedback = "";
  }
  async function submitRejectPlan(pane: ChatPane): Promise<void> {
    const feedback = planFeedback;
    cancelRejectPlan();
    await respondPlanReview(pane.id, "rejected", feedback);
  }

  onMount(async () => {
    try {
      const route = routeFromHash();
      await loadConversations();
      await loadAvatars();
      if (route.view === "chat" && route.arg && activePane()?.conversationId !== route.arg) {
        await selectConversation(route.arg);
        return;
      }
        const pane = activePane();
        if (pane) {
          await attachActiveRun(pane.id);
        }
    } catch (err) {
      notify(`대화 목록을 불러오지 못했습니다: ${(err as Error).message}`, "warn");
    }
  });

  // Auto-scroll uses scroll DIRECTION, not a programmatic-scroll flag, to tell a
  // genuine user scroll-up from our own auto-scroll. Only a user can DECREASE
  // `scrollTop`; `stickToBottom` and streamed content growth never do. The old
  // flag+rAF guard relied on the programmatic scroll's `scroll` event landing
  // before the next frame — but under fast streaming the browser coalesces/defers
  // scroll events, so a late one would read a stale "not near bottom" and flip
  // `stickBottom` off for good, permanently killing auto-scroll. Tracking the last
  // scrollTop per pane and only disengaging on a real upward move is race-free.
  let lastScrollTop: Record<string, number> = {};

  function stickToBottom(item: ChatPane) {
    const el = transcriptEls[item.id];
    // Bail once the user has scrolled up (stickBottom===false) — even mid-stream,
    // so a reader who scrolls back to re-read isn't yanked to the bottom by the
    // next delta. This bail no longer risks "locking auto-scroll off for good":
    // the false-disengage it used to guard against is gone now that the scroll
    // container has `overflow-anchor:none` (the browser no longer repositions
    // scrollTop behind our back) and onTranscriptScroll only disengages on a
    // genuine upward gesture (never on a coalesced/intermediate read while sticky).
    if (!el || item.stickBottom === false) return;
    el.scrollTop = el.scrollHeight;
    lastScrollTop[item.id] = el.scrollTop;
  }

  afterUpdate(() => {
    for (const item of panes) stickToBottom(item);
  });

  // `afterUpdate` only re-pins at the instant the store changes — but the
  // streaming bubble keeps GROWING afterward: the activity tree (skills/tools
  // loading), plugin chips, status spinner, lazy images and markdown all settle
  // their height asynchronously, below that instant. A ResizeObserver re-pins on
  // every content-size change (and on viewport shrink when the composer grows),
  // so auto-scroll tracks that late growth instead of leaving the new rows just
  // out of view — which is what made it feel like it "doesn't scroll" at all.
  // Re-pinning only moves scrollTop down, so the direction-based handler above
  // never mistakes it for a user scroll, and it never disturbs a user who has
  // scrolled up (stickToBottom bails when stickBottom === false).
  function autostick(node: HTMLElement, item: ChatPane) {
    let current = item;
    const inner = node.querySelector<HTMLElement>(".transcript-inner");
    const ro = new ResizeObserver(() => stickToBottom(current));
    ro.observe(node);
    if (inner) ro.observe(inner);
    return {
      update(next: ChatPane) {
        current = next;
      },
      destroy() {
        ro.disconnect();
      },
    };
  }

  $: panes = $appState.chatPanes;
  $: pane = panes.find((item) => item.id === $appState.activePaneId) ?? panes[0] ?? null;
  $: splitClass = panes.length <= 1 ? "single" : $appState.chatLayout;
  // Split-add options: ALL visible avatars (duplicates allowed — you can run
  // several parallel conversations with the same avatar, incl. your own), with
  // the open panes' avatars unioned in as a fallback so your own avatar is always
  // selectable even before discovery loads.
  $: splitOptions = (() => {
    const byId = new Map<string, { id: string; alias?: string; displayName?: string; username?: string }>();
    for (const item of panes) if (item.avatar?.id) byId.set(item.avatar.id, item.avatar);
    for (const avatar of $appState.avatars) if (avatar?.id) byId.set(avatar.id, avatar);
    return [...byId.values()];
  })();
  $: if (splitOptions.length && !splitOptions.some((avatar) => avatar.id === splitAvatarId)) {
    splitAvatarId = splitOptions[0].id;
  } else if (!splitOptions.length && splitAvatarId) {
    splitAvatarId = "";
  }

  $: user = $appState.user;
  // Desktop / physical keyboard → Enter sends; touch-only → button sends.
  $: finePointer = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)").matches : true;
  $: enterSends = finePointer || physicalKeyboard;

  function isOwnPane(item: ChatPane): boolean {
    return Boolean(item.avatar.isOwn || item.avatar.id === user?.id);
  }

  function eligibleGroups(item: ChatPane) {
    return isOwnPane(item) ? (user?.groups || []).filter((g) => g.knowledgeRepoConfigured) : [];
  }

  function hasModelPicker(): boolean {
    return Boolean($appState.bootstrap?.modelSelection && !$appState.bootstrap.modelSelection.locked);
  }

  function hasEffortPicker(): boolean {
    return Boolean($appState.bootstrap?.effortSelection);
  }

  function hasComposerControls(item: ChatPane): boolean {
    return hasModelPicker() || hasEffortPicker() || eligibleGroups(item).length > 0 || MCP_TOOL_GROUPS.length > 0;
  }

  function modelTierLabel(item: ChatPane): string {
    const tierId = item.modelTier ?? DEFAULT_MODEL_TIER;
    return $appState.bootstrap?.modelSelection?.tiers.find((tier) => tier.id === tierId)?.label ?? tierId;
  }

  function effortLabel(item: ChatPane): string {
    const levelId = item.effort ?? $appState.bootstrap?.effortSelection?.default ?? DEFAULT_EFFORT_LEVEL;
    return $appState.bootstrap?.effortSelection?.levels.find((level) => level.id === levelId)?.label ?? levelId;
  }

  function groupKnowledgeLabel(item: ChatPane): string {
    const groups = eligibleGroups(item);
    if (!groups.length) return "";
    const onCount = groups.filter((g) => !(item.groupKnowledgeOff || []).includes(g.id)).length;
    return `그룹 ${onCount}/${groups.length}`;
  }

  function selectedMcpToolGroups(item: ChatPane): McpToolGroupId[] {
    const selected = item.mcpToolGroups ?? DEFAULT_MCP_TOOL_GROUPS;
    return normalizeMcpToolGroups(selected);
  }

  function mcpToolsLabel(item: ChatPane): string {
    return `도구 ${selectedMcpToolGroups(item).length}/${MCP_TOOL_GROUPS.length}`;
  }

  function composerSettingsSummary(item: ChatPane): string {
    const parts: string[] = [];
    if (hasModelPicker()) parts.push(modelTierLabel(item));
    if (hasEffortPicker()) parts.push(`강도 ${effortLabel(item)}`);
    const groupLabel = groupKnowledgeLabel(item);
    if (groupLabel) parts.push(groupLabel);
    parts.push(mcpToolsLabel(item));
    return parts.join(" · ");
  }

  function toggleComposerSettings(item: ChatPane) {
    const closing = composerSettingsOpenPaneId === item.id;
    composerSettingsOpenPaneId = closing ? "" : item.id;
    if (closing && gkOpenPaneId === item.id) gkOpenPaneId = "";
    if (closing && mcpToolsOpenPaneId === item.id) mcpToolsOpenPaneId = "";
  }

  function toggleMcpToolsPanel(item: ChatPane) {
    const closing = mcpToolsOpenPaneId === item.id;
    mcpToolsOpenPaneId = closing ? "" : item.id;
    if (!closing && gkOpenPaneId === item.id) gkOpenPaneId = "";
  }

  function toggleGroupKnowledgePanel(item: ChatPane) {
    const closing = gkOpenPaneId === item.id;
    gkOpenPaneId = closing ? "" : item.id;
    if (!closing && mcpToolsOpenPaneId === item.id) mcpToolsOpenPaneId = "";
  }

  async function submit(item: ChatPane) {
    closeSlash();
    const message = item.draft;
    // On desktop, restore focus to the composer so the user can keep typing while
    // the response streams (the send button / touch tap moves focus off it). On
    // mobile, do the opposite: blur the textarea so the soft keyboard drops away
    // after sending instead of staying up over the conversation.
    const pending = sendMessage(item.id, message);
    if (isMobileViewport()) blurComposer(item.id);
    else focusComposer(item.id);
    await pending;
    await tick();
  }

  function isMobileViewport(): boolean {
    return window.matchMedia?.("(max-width: 860px)").matches ?? false;
  }

  function blurComposer(paneId: string) {
    const el = document.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] textarea`);
    el?.blur();
  }

  /* ---- image attachments ---- */
  const MAX_COMPOSER_IMAGES = 6;
  // Long-edge cap before upload (Claude's recommended max; also keeps payloads small).
  const IMAGE_MAX_DIM = 1568;
  const ACCEPTED_IMAGE_TYPES: ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  // Downscale to IMAGE_MAX_DIM via canvas (re-encoding to the same family). GIFs
  // are kept verbatim so animation survives (still size-capped server-side). The
  // decode/downscale (a CSP-sensitive `data:` URL load) lives in downscaleImageToDataUrl.
  async function resizeImageForChat(file: File): Promise<{ dataUrl: string; mediaType: ImageMediaType }> {
    const type: ImageMediaType = (ACCEPTED_IMAGE_TYPES as string[]).includes(file.type) ? (file.type as ImageMediaType) : "image/png";
    if (type === "image/gif") {
      const sourceDataUrl = await readFileAsDataUrl(file);
      return { dataUrl: sourceDataUrl, mediaType: "image/gif" };
    }
    const out = type === "image/jpeg" ? "image/jpeg" : type === "image/webp" ? "image/webp" : "image/png";
    const dataUrl = await downscaleImageToDataUrl(file, IMAGE_MAX_DIM, { outputType: out });
    // The browser may emit PNG if it can't encode the requested type — trust the prefix.
    const mediaType = (/^data:(image\/[a-z+]+);/.exec(dataUrl)?.[1] as ImageMediaType) || "image/png";
    return { dataUrl, mediaType };
  }

  async function addImages(item: ChatPane, files: FileList | File[] | null | undefined) {
    if (!files) return;
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const current = readState().chatPanes.find((p) => p.id === item.id);
    const room = MAX_COMPOSER_IMAGES - (current?.pendingImages?.length || 0);
    if (room <= 0) {
      notify(`이미지는 최대 ${MAX_COMPOSER_IMAGES}장까지 첨부할 수 있습니다.`, "warn");
      return;
    }
    const accepted: PendingImage[] = [];
    for (const file of list.slice(0, room)) {
      try {
        const { dataUrl, mediaType } = await resizeImageForChat(file);
        accepted.push({ id: newId(), dataUrl, name: file.name || "image", mediaType });
      } catch {
        notify(`'${file.name || "이미지"}'를 불러오지 못했습니다.`, "warn");
      }
    }
    if (list.length > room) notify(`이미지는 최대 ${MAX_COMPOSER_IMAGES}장까지 첨부할 수 있습니다.`, "warn");
    if (!accepted.length) return;
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.pendingImages = [...(target.pendingImages || []), ...accepted];
    });
  }

  async function onPickImages(event: Event, item: ChatPane) {
    const input = event.currentTarget as HTMLInputElement;
    await addImages(item, input.files);
    input.value = ""; // allow re-picking the same file
  }

  function onComposerPaste(event: ClipboardEvent, item: ChatPane) {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    // Prefer items (covers screenshots/copied images), fall back to files (some
    // browsers only populate one of the two for a pasted image).
    const fromItems = Array.from(clipboard.items || [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    const fromFiles = Array.from(clipboard.files || []).filter((f) => f.type.startsWith("image/"));
    const files = (fromItems.length ? fromItems : fromFiles).filter(
      (f, i, arr) => arr.findIndex((g) => g.name === f.name && g.size === f.size) === i,
    );
    if (files.length) {
      event.preventDefault();
      void addImages(item, files);
    }
  }

  function removePendingImage(item: ChatPane, id: string) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.pendingImages = (target.pendingImages || []).filter((img) => img.id !== id);
    });
  }

  // Live (just-sent) bubbles render from the locally-held data URL; on reload it
  // falls back to the owner-scoped serving endpoint.
  function imageSrc(message: StoredMessage, att: MessageAttachment, item: ChatPane): string {
    return (
      item.localImages?.[att.id] ||
      `/api/conversations/${encodeURIComponent(message.conversationId)}/images/${encodeURIComponent(att.id)}`
    );
  }

  /* ---- slash autocomplete ---- */
  function slashQuery(text: string): string | null {
    if (typeof text !== "string" || text.startsWith("//")) return null;
    const match = /^\/([A-Za-z0-9_-]*)$/.exec(text);
    return match ? match[1].toLowerCase() : null;
  }
  function slashMatches(item: ChatPane): SlashCommand[] {
    const query = slashQuery(item.draft);
    if (query === null || item.streaming) return [];
    return filterSlashCommands(menuCommandsForPane(item), query);
  }

  // Skill entries in the slash menu are populated from the avatar's installed
  // skills, fetched once (lazily) the first time the menu opens for a pane. The
  // result is stored on the pane so slashMatches stays reactive via the store.
  const skillsInFlight = new Set<string>();
  async function ensureSkills(item: ChatPane) {
    if (item.skillsLoaded || skillsInFlight.has(item.id) || !item.avatar?.id) return;
    skillsInFlight.add(item.id);
    try {
      const result = await api<{ skills: SkillInfo[] }>(`/api/avatars/${encodeURIComponent(item.avatar.id)}/skills`);
      updateState((state) => {
        const target = state.chatPanes.find((p) => p.id === item.id);
        if (target) {
          target.skills = result.skills || [];
          target.skillsLoaded = true;
        }
      });
    } catch {
      // Soft-fail: the menu still shows built-in commands. Mark loaded so we don't
      // retry on every keystroke; a fresh pane (e.g. reload) gets another chance.
      updateState((state) => {
        const target = state.chatPanes.find((p) => p.id === item.id);
        if (target) target.skillsLoaded = true;
      });
    } finally {
      skillsInFlight.delete(item.id);
    }
  }
  function closeSlash() {
    slashPaneId = "";
    slashIndex = 0;
  }
  function applySlash(item: ChatPane, cmd: SlashCommand) {
    closeSlash();
    if (cmd.action === "new") {
      setDraft(item.id, "");
      newChat(item.id);
      return;
    }
    // Skill entries aren't typeable as a raw "/command" (names can contain ":"),
    // so we send the expanded instruction that names the skill instead.
    if (cmd.kind === "skill") {
      setDraft(item.id, cmd.prompt ? cmd.prompt("") : "");
      void submit(item);
      return;
    }
    if (cmd.requiresArgs) {
      setDraft(item.id, `/${cmd.name} `);
      focusComposer(item.id);
      return;
    }
    setDraft(item.id, `/${cmd.name}`);
    void submit(item);
  }
  function completeSlash(item: ChatPane, cmd: SlashCommand) {
    // Tab on a skill drops its instruction into the composer (editable) instead of
    // sending, so the user can append details before pressing Enter.
    if (cmd.kind === "skill") {
      setDraft(item.id, cmd.prompt ? `${cmd.prompt("")} ` : "");
      focusComposer(item.id);
      return;
    }
    setDraft(item.id, `/${cmd.name}${cmd.requiresArgs ? " " : ""}`);
    focusComposer(item.id);
  }

  function onComposerKeydown(event: KeyboardEvent, item: ChatPane) {
    if (/^(Key|Digit|Numpad|Arrow|F\d)/.test(event.code || "")) physicalKeyboard = true;
    const matches = slashPaneId === item.id ? slashMatches(item) : [];
    if (matches.length) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "Home") slashIndex = 0;
        else if (event.key === "End") slashIndex = matches.length - 1;
        else slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applySlash(item, matches[Math.min(slashIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        completeSlash(item, matches[Math.min(slashIndex, matches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
    }
    if (!enterSends) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      // While a response is streaming we can't send yet — let Enter insert a
      // newline so the user can compose the next message instead of swallowing it.
      if (item.streaming) return;
      event.preventDefault();
      void submit(item);
    }
  }

  function onComposerInput(event: Event, item: ChatPane) {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    setDraft(item.id, value);
    if (slashQuery(value) !== null && !item.streaming) {
      slashPaneId = item.id;
      slashIndex = 0;
      void ensureSkills(item);
    } else if (slashPaneId === item.id) {
      closeSlash();
    }
  }

  function focusComposer(paneId: string) {
    void tick().then(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] textarea`);
      el?.focus();
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function setDraft(paneId: string, value: string) {
    updateState((state) => {
      const target = state.chatPanes.find((item) => item.id === paneId);
      if (target) target.draft = value;
    });
  }

  function useStarter(item: ChatPane, text: string) {
    setActive(item.id);
    setDraft(item.id, text);
    focusComposer(item.id);
  }

  function copyMessage(message: StoredMessage, event: MouseEvent) {
    void copyText(message.content || message.response?.text || "", event.currentTarget as HTMLButtonElement);
  }

  function editMessage(item: ChatPane, message: StoredMessage) {
    setActive(item.id);
    setDraft(item.id, message.content || "");
    focusComposer(item.id);
    notify("메시지를 입력창에 불러왔습니다. 수정 후 보내기를 누르세요.", "info");
  }

  function setActive(paneId: string) {
    updateState((state) => {
      state.activePaneId = paneId;
      state.currentAvatar = state.chatPanes.find((item) => item.id === paneId)?.avatar || state.currentAvatar;
    });
  }

  function onTranscriptScroll(event: Event, item: ChatPane) {
    const el = event.currentTarget as HTMLDivElement;
    const prev = lastScrollTop[item.id];
    const top = el.scrollTop;
    lastScrollTop[item.id] = top;
    // Disengage ONLY on a genuine user scroll-UP. Only a real gesture decreases
    // scrollTop; our `stickToBottom` pin and streamed content-growth never do.
    // The handler used to ALSO re-engage on any downward move / arrival at the
    // bottom via a ternary — but that read `nearBottom` every event, and under
    // fast SSE deltas the browser coalesces scroll events so a late one fired
    // with a stale scrollHeight, computed `nearBottom === false`, and flipped
    // `stickBottom` off for good. Splitting the two intents removes that race:
    // an upward move (and ONLY that) hands control to the user; we never touch
    // `stickBottom` on the down/grow path while still sticky, so no stale read
    // can disengage us. A 5px deadzone (was 2px) absorbs sub-pixel jitter and
    // any residual scroll-anchor micro-shift. Skip no-op store writes — scroll
    // fires rapidly while streaming and updateState recomputes + notifies.
    const scrolledUp = prev !== undefined && top < prev - 5;
    if (scrolledUp) {
      if (item.stickBottom) {
        updateState((state) => {
          const target = state.chatPanes.find((p) => p.id === item.id);
          if (target) target.stickBottom = false;
        });
      }
    } else if (item.stickBottom === false) {
      // Already disengaged and the user is scrolling back DOWN toward the
      // bottom — re-engage once they reach it (this is also the path the FAB's
      // `scrollToBottom` relies on settling into).
      const nearBottom = el.scrollHeight - top - el.clientHeight < 120;
      if (nearBottom) {
        updateState((state) => {
          const target = state.chatPanes.find((p) => p.id === item.id);
          if (target) target.stickBottom = true;
        });
      }
    }
  }

  function scrollToBottom(item: ChatPane) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.stickBottom = true;
    });
    const el = transcriptEls[item.id];
    if (el) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop[item.id] = el.scrollTop;
    }
  }

  async function addSplitPane() {
    const avatar = splitOptions.find((item) => item.id === splitAvatarId);
    if (!avatar) return;
    if (panes.length >= 4) {
      notify("분할 대화는 최대 4개까지 가능합니다.", "warn");
      return;
    }
    await startChatWith(avatar as AvatarSummary, true);
  }

  // Drop target for a conversation dragged from the rail's "내 대화" list.
  // Mirrors the MIME set in Shell.svelte's onConvDragStart.
  const CONV_DND_MIME = "application/x-noah-conversation";
  let dropActive = false;

  function isConvDrag(event: DragEvent): boolean {
    return Boolean(event.dataTransfer?.types?.includes(CONV_DND_MIME));
  }
  function onWorkbenchDragOver(event: DragEvent) {
    if (!isConvDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    dropActive = true;
  }
  function onWorkbenchDragLeave(event: DragEvent) {
    // Only clear when leaving the workbench itself, not when crossing children.
    if (event.currentTarget === event.target) dropActive = false;
  }
  async function onWorkbenchDrop(event: DragEvent) {
    if (!isConvDrag(event)) return;
    event.preventDefault();
    dropActive = false;
    const conversationId = event.dataTransfer?.getData(CONV_DND_MIME);
    if (!conversationId) return;
    try {
      await addConversationToSplit(conversationId);
    } catch (err) {
      notify(`분할에 추가하지 못했습니다: ${(err as Error).message}`, "warn");
    }
  }

  async function setGroupKnowledge(item: ChatPane, groupId: string, on: boolean) {
    const off = new Set(item.groupKnowledgeOff || []);
    if (on) off.delete(groupId);
    else off.add(groupId);
    const next = [...off];
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.groupKnowledgeOff = next;
      if (state.user) state.user.groupKnowledgeOffDefault = [...next];
    });
    const label = eligibleGroups(item).find((g) => g.id === groupId)?.name || "그룹";
    notify(`"${label}" 그룹 지식을 ${on ? "사용" : "사용 해제"}했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/group-knowledge-default", { method: "PUT", body: JSON.stringify({ off: next }) }).catch((err) =>
      notify(`그룹 지식 기본값을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  // Model tier picked in the composer. Like the group-knowledge toggle it lives on
  // the pane and rides the next chat POST (which persists it per-conversation), AND
  // writes through to the owner's remembered default so the choice seeds the next
  // new conversation. The picker has no "default" option — every value is a real
  // tier (the default is Opus, applied server-side when never chosen).
  function setModelTier(item: ChatPane, tier: string) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.modelTier = tier;
      if (state.user) state.user.modelDefault = tier;
    });
    const label = $appState.bootstrap?.modelSelection?.tiers.find((t) => t.id === tier)?.label;
    notify(`모델을 ${label ?? tier}(으)로 바꿨어요. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ model: tier }) }).catch((err) =>
      notify(`기본 모델을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  // Reasoning effort, mirroring setModelTier: lives on the pane, rides the next chat
  // POST (per-conversation), and writes through to the remembered per-user default.
  // Every value is a real level (the default is "높음"/high when never chosen).
  function setEffort(item: ChatPane, effort: string) {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.effort = effort;
      if (state.user) state.user.effortDefault = effort;
    });
    const label = $appState.bootstrap?.effortSelection?.levels.find((e) => e.id === effort)?.label;
    notify(`사고 강도를 ${label ?? effort}(으)로 바꿨어요. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ effort }) }).catch((err) =>
      notify(`기본 사고 강도를 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  function setMcpToolGroup(item: ChatPane, groupId: McpToolGroupId, on: boolean) {
    const current = new Set(selectedMcpToolGroups(item));
    if (on) current.add(groupId);
    else current.delete(groupId);
    const next = MCP_TOOL_GROUPS.map((group) => group.id).filter((id) => current.has(id));
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === item.id);
      if (target) target.mcpToolGroups = next;
      if (state.user) state.user.mcpToolGroupsDefault = [...next];
    });
    const label = MCP_TOOL_GROUPS.find((group) => group.id === groupId)?.labelKo ?? groupId;
    notify(`"${label}" MCP 도구를 ${on ? "사용" : "사용 해제"}했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ mcpToolGroups: next }) }).catch((err) =>
      notify(`기본 MCP 도구 설정을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  function messageText(message: StoredMessage) {
    return message.response?.text || message.response?.summary || message.content;
  }
  function runtimeBadge(message: StoredMessage): string | null {
    const runtime = message.response?.runtime;
    if (runtime === "local") return "로컬";
    if (message.response?.summary === "오류" || message.response?.summary === "중지됨") return message.response.summary;
    return null;
  }
  // "도구 N개 · 태스크 N개 · 에이전트 N개 <suffix>" from the three counts, or
  // emptyLabel when all are zero. Shared by the live + completed activity labels.
  function activityCountLabel(toolCount: number, taskCount: number, agentCount: number, suffix: string, emptyLabel: string): string {
    const parts: string[] = [];
    if (toolCount) parts.push(`도구 ${toolCount}개`);
    if (taskCount) parts.push(`태스크 ${taskCount}개`);
    if (agentCount) parts.push(`에이전트 ${agentCount}개`);
    return parts.length ? `${parts.join(" · ")} ${suffix}` : emptyLabel;
  }
  function activitySummary(item: ChatPane): string {
    const toolCount = item.liveTools.filter((t) => t.kind === "tool").length;
    const taskCount = item.liveTasks.length;
    const agentCount = item.liveAgents.filter((a) => !a.isMain).length;
    return activityCountLabel(toolCount, taskCount, agentCount, "진행 중", "작업 중…");
  }

  // Activity-tree snapshot kept on a COMPLETED assistant message, so the tool/agent
  // runs stay visible after the response finishes (collapsed by default).
  function completedActivity(message: StoredMessage) {
    const activity = message.response?.activity;
    return activity && (activity.tools.length || activity.tasks?.length) ? activity : null;
  }
  function completedActivityLabel(activity: AgentActivity): string {
    const toolCount = activity.tools.filter((t) => t.kind === "tool").length;
    const taskCount = (activity.tasks?.length || 0) + activity.tools.filter((t) => t.kind === "task").length;
    const agentCount = activity.agents.filter((a) => !a.isMain).length;
    return activityCountLabel(toolCount, taskCount, agentCount, "사용함", "작업 내역");
  }
</script>

{#snippet transcript(item: ChatPane)}
  <div class="chat-body">
    <div
      class="transcript scroll-thin"
      bind:this={transcriptEls[item.id]}
      use:autostick={item}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-busy={item.streaming ? "true" : "false"}
      on:scroll={(event) => onTranscriptScroll(event, item)}
    >
      <div class="transcript-inner">
        {#if !item.messages.length && !item.streaming}
          {@const own = isOwnPane(item)}
          <div class="empty-state">
            <AvatarImage user={item.avatar} size={72} alt="" />
            <div class="hero">
              <h3>{item.avatar.displayName}와(과) 대화</h3>
              <p>{item.avatar.bio || (item.avatar.elevated || own ? "무엇이든 물어보세요." : "무엇이든 물어보세요. 이 아바타의 도구는 읽기 전용으로 실행됩니다.")}</p>
            </div>
            <div class="starter-prompts" role="group" aria-label="시작 프롬프트">
              {#each (item.avatar.elevated || own ? ["내가 지금 맡길 수 있는 일을 3가지로 제안해줘.", "이 대화에서 필요한 배경 정보를 먼저 물어봐줘.", "반복 업무로 만들 만한 루틴을 같이 설계해줘."] : ["이 아바타가 잘 아는 분야를 요약해줘.", "내 질문에 답하기 전에 필요한 맥락을 물어봐줘.", "관련된 지식을 바탕으로 핵심만 정리해줘."]) as text}
                <button class="starter-prompt" type="button" on:click={() => useStarter(item, text)}>{text}</button>
              {/each}
            </div>
          </div>
        {/if}

        {#each item.messages as message, index (message.id || `${message.role}-${message.createdAt}-${index}`)}
          <div class={`message ${message.role}`}>
            <div class="msg-role">
              <span class="role-dot"></span>
              <span>{message.role === "user" ? "나" : item.avatar.displayName}</span>
              {#if message.createdAt}<time class="msg-time" datetime={message.createdAt}>{timeLabel(message.createdAt)}</time>{/if}
            </div>
            <div class={`bubble ${message.response?.summary === "오류" ? "errored" : ""}`}>
              {#if message.role === "assistant"}
                {@const activity = completedActivity(message)}
                {#if runtimeBadge(message)}
                  <div class="response-meta"><span class="meta-badge">{runtimeBadge(message)}</span></div>
                {/if}
                {#if activity}
                  <details class="activity-live activity-done">
                    <summary><span class="activity-summary-text">{completedActivityLabel(activity)}</span></summary>
                    <div class="agent-activity">
                      <ActivityTree agentId="main" agents={activity.agents} tools={activity.tools} tasks={activity.tasks || []} />
                    </div>
                  </details>
                {/if}
                {#if message.response?.thinking}
                  <details class="thinking-card">
                    <summary class="thinking-card-head"><span class="thinking-card-badge">생각 과정</span></summary>
                    <div class="md thinking-card-body" use:enhanceMarkdown={message.response.thinking}>{@html renderMarkdown(message.response.thinking)}</div>
                  </details>
                {/if}
                {#if message.response?.plan}
                  <details class="plan-card" open>
                    <summary class="plan-card-head"><span class="plan-card-badge">계획</span><span class="plan-card-hint">계획 모드</span></summary>
                    <div class="md plan-card-body" use:enhanceMarkdown={message.response.plan}>{@html renderMarkdown(message.response.plan)}</div>
                  </details>
                {/if}
                <div class="md" use:enhanceMarkdown={messageText(message)}>{@html renderMarkdown(messageText(message))}</div>
              {:else}
                {#if message.attachments?.length}
                  <div class="msg-images">
                    {#each message.attachments as att (att.id)}
                      <a class="msg-image-link" href={imageSrc(message, att, item)} target="_blank" rel="noopener noreferrer">
                        <img class="msg-image" src={imageSrc(message, att, item)} alt={att.name || "첨부 이미지"} loading="lazy" />
                      </a>
                    {/each}
                  </div>
                {/if}
                {#if message.content}{message.content}{/if}
              {/if}
            </div>
            <div class="msg-actions">
              <button class="msg-act" type="button" aria-label="복사" title="복사" on:click={(event) => copyMessage(message, event)}><Icon name="copy" /></button>
              {#if message.role === "user"}
                <button class="msg-act" type="button" aria-label="편집" title="편집 후 다시 보내기" on:click={() => editMessage(item, message)}><Icon name="edit" /></button>
              {:else if index === item.messages.length - 1 && !item.streaming}
                <button class="msg-act regen" type="button" aria-label="다시 생성" title="다시 생성" on:click={() => regenerate(item.id)}><Icon name="refresh" /></button>
              {/if}
            </div>
          </div>
        {/each}

        {#if item.streaming}
          <div class="message assistant" aria-live="off">
            <div class="msg-role">
              <span class="role-dot"></span>
              <span>{item.avatar.displayName}</span>
            </div>
            <div class="bubble">
              {#if item.liveAgents.length}
                <details class="activity-live" open>
                  <summary><span class="activity-summary-text">{activitySummary(item)}</span></summary>
                  <div class="agent-activity">
                    <ActivityTree agentId="main" agents={item.liveAgents} tools={item.liveTools} tasks={item.liveTasks} />
                  </div>
                </details>
              {/if}
              {#if item.liveThinking}
                <details class="thinking-card" open>
                  <summary class="thinking-card-head"><span class="thinking-card-badge">생각 과정</span></summary>
                  <div class="md thinking-card-body" use:enhanceMarkdown={item.liveThinking}>{@html renderMarkdown(item.liveThinking)}</div>
                </details>
              {/if}
              {#if item.livePlan}
                <details class="plan-card" open>
                  <summary class="plan-card-head"><span class="plan-card-badge">계획</span><span class="plan-card-hint">{item.planReview ? "승인 대기 중" : "계획 모드"}</span></summary>
                  <div class="md plan-card-body" use:enhanceMarkdown={item.livePlan}>{@html renderMarkdown(item.livePlan)}</div>
                  {#if item.planReview}
                    <div class="plan-actions">
                      {#if planRejectPaneId === item.id}
                        <textarea
                          class="plan-feedback"
                          rows="2"
                          placeholder="수정할 점을 알려주세요 (선택)"
                          bind:value={planFeedback}
                          disabled={item.planReviewSubmitting}
                        ></textarea>
                        <div class="plan-actions-row">
                          <button class="btn btn-ghost btn-sm" type="button" disabled={item.planReviewSubmitting} on:click={cancelRejectPlan}>취소</button>
                          <button class="btn btn-primary btn-sm" type="button" disabled={item.planReviewSubmitting} on:click={() => submitRejectPlan(item)}>수정 요청 보내기</button>
                        </div>
                      {:else}
                        <div class="plan-actions-row">
                          <button class="btn btn-ghost btn-sm" type="button" disabled={item.planReviewSubmitting} on:click={() => startRejectPlan(item)}>수정 요청</button>
                          <button class="btn btn-primary btn-sm" type="button" disabled={item.planReviewSubmitting} on:click={() => approvePlan(item)}>승인</button>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </details>
              {:else if item.planPending}
                <div class="plan-card plan-card-pending">
                  <div class="plan-card-head"><span class="plan-card-badge">계획</span><span class="plan-card-hint">계획을 작성하는 중…</span><span class="plan-card-spin" aria-hidden="true"></span></div>
                </div>
              {/if}
              {#if item.liveText}
                <div class="md" use:enhanceMarkdown={item.liveText}>{@html renderMarkdown(item.liveText)}<span class="stream-caret" aria-hidden="true"></span></div>
              {/if}
              <div class="stream-status">
                <span class="spinner"></span>
                <span class="label">{item.liveStatus || "응답 생성 중…"}</span>
              </div>
              {#if item.livePlugins.length}
                <div class="plugin-chips">
                  {#each item.livePlugins as chip (chip.name)}
                    <span class="plugin-chip" data-status={chip.status}>
                      <span class="pc-dot"></span>
                      <span class="pc-text">{chip.name} · {PLUGIN_STATUS_LABELS[chip.status] || chip.status}</span>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
    {#if item.stickBottom === false}
      <button class="scroll-bottom" type="button" aria-label="맨 아래로" title="맨 아래로" on:click={() => scrollToBottom(item)}><Icon name="arrow-down" /></button>
    {/if}
  </div>
{/snippet}

{#snippet composer(item: ChatPane, compact: boolean, index: number)}
  <footer class="composer">
    <div class="composer-inner">
      <form class="composer-form" on:submit|preventDefault={() => submit(item)}>
        {#if slashPaneId === item.id}
          {@const matches = slashMatches(item)}
          {#if matches.length}
            <div class="slash-menu" role="listbox" aria-label="슬래시 명령">
              <div class="slash-menu-head">슬래시 명령</div>
              {#each matches as cmd, i}
                <button
                  class="slash-option"
                  class:active={i === Math.min(slashIndex, matches.length - 1)}
                  type="button"
                  role="option"
                  aria-selected={i === slashIndex ? "true" : "false"}
                  on:mousedown|preventDefault={() => {}}
                  on:click={() => applySlash(item, cmd)}
                >
                  <span class="slash-option-command">
                    /{cmd.name}{cmd.argsLabel ? ` ${cmd.argsLabel}` : ""}
                    {#if cmd.kind === "skill"}<span class="slash-option-tag">스킬{cmd.source && cmd.source !== "default" ? ` · ${cmd.source}` : ""}</span>{/if}
                  </span>
                  <span class="slash-option-main"><strong>{cmd.title}</strong><span>{cmd.description}</span></span>
                </button>
              {/each}
            </div>
          {/if}
        {/if}
        {#if item.pendingImages?.length}
          <div class="composer-attachments" aria-label="첨부한 이미지">
            {#each item.pendingImages as img (img.id)}
              <div class="composer-thumb">
                <img src={img.dataUrl} alt={img.name} />
                <button
                  class="composer-thumb-remove"
                  type="button"
                  aria-label="이미지 제거"
                  title="제거"
                  disabled={item.streaming}
                  on:click={() => removePendingImage(item, img.id)}
                >
                  <Icon name="close" />
                </button>
              </div>
            {/each}
          </div>
        {/if}
        <div class="composer-box">
          <label class="composer-attach" class:disabled={item.streaming} title="이미지 첨부" aria-label="이미지 첨부">
            <Icon name="image" />
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              disabled={item.streaming}
              on:change={(event) => onPickImages(event, item)}
            />
          </label>
          <!-- Intentionally NOT disabled while streaming: disabling blurs the
               textarea (focus loss after every send) and blocks composing the
               next message. Sending mid-stream is already prevented (Enter is
               gated below; the button is a Stop button), so leaving it editable
               only lets the user keep focus + draft the follow-up. -->
          <textarea
            rows="1"
            placeholder={item.streaming ? "응답을 기다리는 중… (다음 메시지를 미리 작성할 수 있어요)" : `${item.avatar.displayName}에게 메시지…`}
            value={item.draft}
            use:autosize={item.draft}
            on:input={(event) => onComposerInput(event, item)}
            on:keydown={(event) => onComposerKeydown(event, item)}
            on:paste={(event) => onComposerPaste(event, item)}
          ></textarea>
          <button
            class="send-button"
            class:is-stop={item.streaming}
            type="button"
            aria-label={item.streaming ? "응답 중지" : "보내기"}
            title={item.streaming ? "응답 중지" : "보내기"}
            on:click={() => (item.streaming ? stopPane(item.id) : submit(item))}
          >
            <Icon name={item.streaming ? "stop" : "send"} />
          </button>
        </div>
        <div class="composer-hint">
          {#if compact}
            <span>대화 {index + 1}</span>
          {:else if enterSends}
            <span>Enter 전송 · <kbd>Shift+Enter</kbd> 줄바꿈</span>
          {:else}
            <span>보내기 버튼으로 전송</span>
          {/if}
          {#if hasComposerControls(item) || formatUsageLabel(item.usage)}
            <span class="composer-meta">
              {#if hasComposerControls(item)}
                <button
                  class="composer-settings-btn"
                  type="button"
                  aria-expanded={composerSettingsOpenPaneId === item.id ? "true" : "false"}
                  title="이 대화의 모델, 사고 강도, 지식, MCP 도구를 설정합니다"
                  on:click={() => toggleComposerSettings(item)}
                >
                  <Icon name="gear" size={16} />
                  <span class="composer-settings-label">설정</span>
                  <span class="composer-settings-summary">{composerSettingsSummary(item)}</span>
                </button>
                <span class="composer-controls" class:open={composerSettingsOpenPaneId === item.id}>
                  {#if $appState.bootstrap?.modelSelection && !$appState.bootstrap.modelSelection.locked}
                    <select
                      class="composer-model-select"
                      aria-label="이 대화에 사용할 모델"
                      title="이 대화에서 다음 메시지부터 사용할 모델을 고릅니다"
                      value={item.modelTier ?? DEFAULT_MODEL_TIER}
                      on:change={(event) => setModelTier(item, event.currentTarget.value)}
                    >
                      {#each $appState.bootstrap.modelSelection.tiers as tier (tier.id)}
                        <option value={tier.id} title={tier.model ? `${tier.description}\n(${tier.model})` : tier.description}>
                          {tier.label}{tier.model ? ` · ${tier.model}` : ""}
                        </option>
                      {/each}
                    </select>
                  {/if}
                  {#if $appState.bootstrap?.effortSelection}
                    <select
                      class="composer-model-select"
                      aria-label="이 대화에 사용할 사고 강도(effort)"
                      title="이 대화에서 다음 메시지부터 모델이 들이는 사고/추론 강도를 고릅니다"
                      value={item.effort ?? $appState.bootstrap.effortSelection.default ?? DEFAULT_EFFORT_LEVEL}
                      on:change={(event) => setEffort(item, event.currentTarget.value)}
                    >
                      {#each $appState.bootstrap.effortSelection.levels as level (level.id)}
                        <option value={level.id} title={level.description}>강도: {level.label}</option>
                      {/each}
                    </select>
                  {/if}
                  {#if eligibleGroups(item).length}
                    {@const groups = eligibleGroups(item)}
                    {@const onCount = groups.filter((g) => !(item.groupKnowledgeOff || []).includes(g.id)).length}
                    <button
                      class="composer-gk-btn"
                      type="button"
                      aria-expanded={gkOpenPaneId === item.id ? "true" : "false"}
                      title="이 대화에서 다음 메시지부터 사용할 그룹 지식을 고릅니다"
                      on:click={() => toggleGroupKnowledgePanel(item)}
                    >그룹 지식 {onCount}/{groups.length}</button>
                  {/if}
                  <button
                    class="composer-tools-btn"
                    type="button"
                    aria-expanded={mcpToolsOpenPaneId === item.id ? "true" : "false"}
                    title="이 대화에서 다음 메시지부터 사용할 MCP 도구 묶음을 고릅니다"
                    on:click={() => toggleMcpToolsPanel(item)}
                  >MCP 도구 {selectedMcpToolGroups(item).length}/{MCP_TOOL_GROUPS.length}</button>
                </span>
              {/if}
              {#if formatUsageLabel(item.usage)}
                <span class="composer-usage">{formatUsageLabel(item.usage)}</span>
              {/if}
            </span>
          {/if}
        </div>
      </form>
      {#if gkOpenPaneId === item.id && eligibleGroups(item).length}
        <div
          class="composer-gk-panel"
          role="group"
          aria-label="이 대화에서 사용할 그룹 지식"
          use:clickOutside={{ onOutside: () => (gkOpenPaneId = ""), ignore: ".composer-gk-btn" }}
        >
          <div class="composer-gk-title">이 대화에서 사용할 그룹 지식</div>
          {#each eligibleGroups(item) as group (group.id)}
            <label class="composer-gk-item">
              <input
                type="checkbox"
                checked={!(item.groupKnowledgeOff || []).includes(group.id)}
                on:change={(event) => setGroupKnowledge(item, group.id, event.currentTarget.checked)}
              />
              <span>{group.name}</span>
            </label>
          {/each}
        </div>
      {/if}
      {#if mcpToolsOpenPaneId === item.id}
        <div
          class="composer-tools-panel"
          role="group"
          aria-label="이 대화에서 사용할 MCP 도구"
          use:clickOutside={{ onOutside: () => (mcpToolsOpenPaneId = ""), ignore: ".composer-tools-btn" }}
        >
          <div class="composer-tools-title">이 대화에서 사용할 MCP 도구</div>
          {#each MCP_TOOL_GROUPS as group (group.id)}
            <label class="composer-tools-item">
              <input
                type="checkbox"
                checked={selectedMcpToolGroups(item).includes(group.id)}
                on:change={(event) => setMcpToolGroup(item, group.id, event.currentTarget.checked)}
              />
              <span>
                <strong>{group.labelKo}</strong>
                <small>{group.descriptionKo}</small>
              </span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  </footer>
{/snippet}

{#snippet splitControls()}
  <div class="split-controls" role="group" aria-label="분할 대화">
    {#if panes.length > 1}
      {#each ["vertical", "horizontal", "grid"] as layout}
        <button
          type="button"
          class="split-btn"
          class:active={$appState.chatLayout === layout}
          aria-label={layout === "vertical" ? "좌우 분할" : layout === "horizontal" ? "상하 분할" : "격자 분할"}
          aria-pressed={$appState.chatLayout === layout ? "true" : "false"}
          on:click={() => updateState((state) => (state.chatLayout = layout as typeof state.chatLayout))}
        >
          <Icon name={layout === "vertical" ? "columns" : layout === "horizontal" ? "rows" : "grid"} />
        </button>
      {/each}
    {/if}
    <select class="split-avatar-select" bind:value={splitAvatarId} disabled={!splitOptions.length || panes.length >= 4} aria-label="분할로 추가할 아바타">
      {#if splitOptions.length}
        {#each splitOptions as av}
          <option value={av.id}>{av.alias || av.displayName || av.username}</option>
        {/each}
      {:else}
        <option value="">추가할 아바타 없음</option>
      {/if}
    </select>
    <button class="split-add" type="button" title="대화 추가 (분할)" aria-label="대화 추가 (분할)" disabled={!splitOptions.length || panes.length >= 4} on:click={addSplitPane}>
      <Icon name="plus" />
    </button>
  </div>
{/snippet}

{#if !pane}
  <header class="view-header">
    <div>
      <h1>대화</h1>
      <p>탐색에서 아바타를 골라 대화를 시작하세요</p>
    </div>
  </header>
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="view-body" class:drop-active={dropActive} on:dragover={onWorkbenchDragOver} on:dragleave={onWorkbenchDragLeave} on:drop={onWorkbenchDrop}>
    <div class="empty-state">
      <div class="hero">
        <h3>아직 선택한 아바타가 없어요</h3>
        <p>탐색 탭에서 대화할 아바타를 골라 보세요. 왼쪽 대화 목록에서 대화를 끌어와 열 수도 있어요.</p>
      </div>
    </div>
  </div>
{:else if panes.length > 1}
  <header class="view-header chat-head">
    <div class="header-left">
      <div class="title">
        <h1>분할 대화</h1>
        <p>최대 4개의 대화를 동시에 진행할 수 있습니다.</p>
      </div>
    </div>
    <div class="chat-head-actions">
      {@render splitControls()}
      <button class="ghost-sm" type="button" disabled={pane.streaming} on:click={() => newChat(pane.id)}>새 대화</button>
    </div>
  </header>

  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class={`chat-workbench ${splitClass}`}
    class:drop-active={dropActive}
    on:dragover={onWorkbenchDragOver}
    on:dragleave={onWorkbenchDragLeave}
    on:drop={onWorkbenchDrop}
  >
    {#each panes as item, index (item.id)}
      <section
        class="chat-col chat-pane compact"
        class:active={item.id === pane.id}
        data-pane={item.id}
        role="button"
        tabindex="0"
        on:click={() => setActive(item.id)}
        on:keydown={(event) => {
          if (event.key === "Enter" || event.key === " ") setActive(item.id);
        }}
      >
        <div class="pane-head">
          <div class="pane-title">
            <AvatarImage user={item.avatar} size={30} alt="" />
            <div>
              <strong>대화 {index + 1}</strong>
              <span>{item.avatar.alias || item.avatar.displayName}</span>
            </div>
          </div>
          <div class="pane-actions">
            <button class="ghost-sm" type="button" disabled={item.streaming} on:click|stopPropagation={() => newChat(item.id)}>새 대화</button>
            <button class="msg-act" type="button" aria-label="대화 창 닫기" disabled={panes.length <= 1} on:click|stopPropagation={() => closePane(item.id)}>
              <Icon name="close" />
            </button>
          </div>
        </div>
        {@render transcript(item)}
        {@render composer(item, true, index)}
        <PromptModal paneId={item.id} />
      </section>
    {/each}
  </div>
{:else}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="chat-layout" class:drop-active={dropActive} on:dragover={onWorkbenchDragOver} on:dragleave={onWorkbenchDragLeave} on:drop={onWorkbenchDrop}>
    <section class="chat-col chat-pane active" data-pane={pane.id}>
      <header class="view-header chat-head">
        <div class="header-left">
          <div class="chat-avatar">
            <AvatarImage user={pane.avatar} size={36} alt="" />
            <div>
              <h1 class="ca-name">{pane.avatar.alias || pane.avatar.displayName}</h1>
              <div class="ca-handle">@{pane.avatar.username}{pane.avatar.elevated ? "" : " · 읽기 전용"}</div>
            </div>
          </div>
        </div>
        <div class="chat-head-actions">
          {@render splitControls()}
          <button class="ghost-sm" type="button" disabled={pane.streaming} on:click={() => newChat(pane.id)}>새 대화</button>
        </div>
      </header>
      {@render transcript(pane)}
      {@render composer(pane, false, 0)}
      <PromptModal paneId={pane.id} />
    </section>
    {#if pane.canvases?.length}
      <CanvasPanel {pane} />
    {/if}
    <CapabilitiesPanel avatar={pane.avatar} />
  </div>
{/if}

<style>
  /* Plan-mode plan card (ExitPlanMode). A distinct, collapsible card inside the
     assistant bubble that surfaces the proposed plan — shown live while the turn
     streams and persisted on the finished message (response.plan). */
  .plan-card {
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--line);
    border-left: 3px solid var(--accent);
    border-radius: var(--r-md);
    background: var(--surface-2);
    margin: var(--s-2) 0;
    overflow: hidden;
  }
  .plan-card-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    cursor: pointer;
    list-style: none;
    user-select: none;
    font-size: 0.85rem;
    min-width: 0;
  }
  .plan-card-head::-webkit-details-marker {
    display: none;
  }
  .plan-card-badge {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
    letter-spacing: 0.02em;
  }
  .plan-card-hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .plan-card-body {
    padding: 0 var(--s-3) var(--s-2);
    min-width: 0;
    max-width: 100%;
  }
  /* Inline approve / reject controls shown on a live plan card while the avatar
     waits for the owner's approval (interactive plan mode). */
  .plan-actions {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    padding: 0 var(--s-3) var(--s-3);
  }
  .plan-actions-row {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
  }
  .plan-feedback {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--panel);
    color: var(--text);
    padding: var(--s-2);
    font: inherit;
    font-size: 0.85rem;
  }
  /* Placeholder shown between EnterPlanMode and ExitPlanMode: the avatar is
     composing the plan in the background (tool rows are suppressed for plan
     tools), so without this the turn looks stalled. */
  .plan-card-pending .plan-card-head {
    cursor: default;
  }
  /* Self-contained spinner: the base `.spinner` rule is scoped to `.stream-status`,
     so this placeholder (outside it) must style its own. `spin` is a global keyframe. */
  .plan-card-spin {
    margin-left: auto;
    flex: none;
    width: 13px;
    height: 13px;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  /* Reasoning (extended-thinking) view. Deliberately muted and secondary to the
     answer — collapsed by default on completed bubbles, expanded live so the user
     sees the chain of thought stream (esp. while the answer text is still empty). */
  .thinking-card {
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--line);
    border-left: 3px solid var(--muted);
    border-radius: var(--r-md);
    background: var(--surface-2);
    margin: var(--s-2) 0;
    overflow: hidden;
  }
  .thinking-card-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    cursor: pointer;
    list-style: none;
    user-select: none;
    font-size: 0.85rem;
    min-width: 0;
  }
  .thinking-card-head::-webkit-details-marker {
    display: none;
  }
  /* Chevron affordance (right when closed, down when open) — the badge alone
     doesn't read as expandable on a collapsed card. */
  .thinking-card-head::after {
    content: "";
    margin-left: auto;
    flex: none;
    width: 6px;
    height: 6px;
    border-right: 2px solid var(--muted);
    border-bottom: 2px solid var(--muted);
    transform: rotate(-45deg);
    transition: transform 0.15s ease;
  }
  .thinking-card[open] .thinking-card-head::after {
    transform: rotate(45deg);
  }
  .thinking-card-badge {
    font-size: 0.7rem;
    font-weight: 700;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--line);
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  .thinking-card-body {
    padding: 0 var(--s-3) var(--s-2);
    min-width: 0;
    max-width: 100%;
    color: var(--muted);
    font-size: 0.92em;
  }
</style>
