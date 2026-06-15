import crypto from "node:crypto";
import fs from "node:fs";
import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { listSkillsInRoots, loadAgentPluginRoots, loadKnowledgeRepoMemory } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import { ensureGitRepoClone, gitRepoContextFor, gitRepoClonePath } from "../gitRepos.js";
import { acquireActiveRepo, releaseActiveRepo } from "../activeRepoLock.js";
import type { AgentConversationMessage, AgentImageInput, AgentResponse, CanvasArtifact, StoredMessage } from "../types.js";
import {
  decodeChatImages,
  deleteConversationImages,
  readChatImages,
  resolveStoredImage,
  saveChatImages,
  MAX_CHAT_IMAGES_PER_MESSAGE,
} from "../chatImages.js";
import { runAgentStream } from "../agent/index.js";
import { isModelTier } from "../modelTiers.js";
import {
  attachRunClient,
  awaitResponse,
  cancelRun,
  closeRun,
  emitRunEvent,
  getActiveRun,
  getActiveRunForConversation,
  isRunCancelled,
  openRun,
  submitResponse,
  CANCELLED,
} from "../agent/runRegistry.js";
import { workspaceDirFor } from "../workspace.js";
import { apiError, isSafePathId, resolveAvatarSkillSources, safeString, type RouterDeps } from "./_shared.js";

interface ChatSlashExpansion {
  message: string;
  error?: string;
  ownerOnly?: boolean;
}

// Validate + size-cap a client-sent activity-tree snapshot before persisting it on
// a message (the client owns the humanized labels; we only sanitize/bound it so a
// bad/huge payload can't bloat the stored response JSON). Returns null when empty.
function sanitizeActivity(raw: unknown): AgentResponse["activity"] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { agents?: unknown; tools?: unknown; tasks?: unknown };
  const cap = (s: unknown, max: number): string => (typeof s === "string" ? s.slice(0, max) : "");
  const agents = (Array.isArray(obj.agents) ? obj.agents : []).slice(0, 60).map((a) => {
    const node = a as Record<string, unknown>;
    const status = cap(node.status, 16);
    return {
      id: cap(node.id, 80),
      parentId: cap(node.parentId, 80),
      label: cap(node.label, 300),
      status: (status === "done" || status === "failed" ? status : "done") as "running" | "done" | "failed",
      isMain: node.isMain === true,
    };
  });
  const rawTools = (Array.isArray(obj.tools) ? obj.tools : []).slice(0, 300);
  const legacyTaskRows = rawTools.filter((t) => cap((t as Record<string, unknown>).kind, 16) === "task");
  const tools = rawTools.filter((t) => cap((t as Record<string, unknown>).kind, 16) !== "task").map((t) => {
    const row = t as Record<string, unknown>;
    const kind = cap(row.kind, 16);
    const status = cap(row.status, 16);
    return {
      id: cap(row.id, 80),
      agentId: cap(row.agentId, 80) || "main",
      kind: (kind === "blocked" ? kind : "tool") as "tool" | "blocked",
      label: cap(row.label, 300),
      detail: row.detail ? cap(row.detail, 400) : undefined,
      status: (["done", "failed", "blocked"].includes(status) ? status : "done") as "running" | "done" | "failed" | "blocked",
    };
  });
  const tasks = [...(Array.isArray(obj.tasks) ? obj.tasks : []), ...legacyTaskRows].slice(0, 200).map((t) => {
    const row = t as Record<string, unknown>;
    const status = cap(row.status, 16);
    return {
      id: cap(row.id, 80),
      agentId: cap(row.agentId, 80) || "main",
      label: cap(row.label, 300),
      detail: row.detail ? cap(row.detail, 400) : undefined,
      status: (status === "failed" ? "failed" : status === "running" ? "running" : "done") as "running" | "done" | "failed",
    };
  });
  if (!tools.length && !tasks.length) return null;
  return { agents, tools, tasks };
}

// Agent-facing (the user only ever sees the literal "/learn" in their bubble;
// this expanded instruction goes to the model), so it is written in English.
// The avatar still REPLIES in the user's language per buildPrompt.
const LEARN_SLASH_PROMPT = [
  "Review this conversation session and update my knowledge repository with only the knowledge that is worth reusing later.",
  "",
  "If there are important facts, decisions, repeatable procedures, project rules, or ways the user said they prefer to work, capture them in the appropriate file or skill and commit them.",
  "Also record clearly and explicitly what you (this avatar) CAN and CANNOT do right now — your current capabilities, the tools/repositories/skills you have connected, and any known limitations or things you were unable to do this session — so future sessions act on an accurate self-picture instead of guessing.",
  "Do not save small talk, anything already stored, or anything not useful long-term. Then briefly tell me what you saved and what you deliberately skipped and why.",
].join("\n");

export function expandChatSlashCommand(message: string): ChatSlashExpansion {
  const trimmed = message.trim();
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return { message };
  }

  const command = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  switch (command) {
    case "learn":
      // Text typed after "/learn" is forwarded as an extra focus hint for what to
      // capture (e.g. "/learn 보안 설정 위주로"), appended to the standing instruction.
      return {
        message: args
          ? `${LEARN_SLASH_PROMPT}\n\nThe user added this focus for what to learn or record this time:\n${args}`
          : LEARN_SLASH_PROMPT,
        ownerOnly: true,
      };
    case "summarize":
      return { message: "지금까지의 대화를 핵심 결정사항, 해야 할 일, 열린 질문으로 나눠 요약해줘." };
    case "remember":
      return args
        ? {
            message: `다음 내용을 내 지식 저장소에 기록해서 앞으로 같은 질문에 답할 수 있게 해줘.\n\n${args}`,
            ownerOnly: true,
          }
        : { message, error: "/remember 뒤에 저장할 내용을 입력해 주세요.", ownerOnly: true };
    case "routine":
      return args
        ? {
            message: `다음 작업을 정기적으로 실행하는 루틴을 만들어줘. 실행 시각(KST 기준)이 아래에 적혀 있으면 그대로 쓰고, 없으면 먼저 물어봐줘.\n\n${args}`,
            ownerOnly: true,
          }
        : { message, error: "/routine 뒤에 작업 내용을 입력해 주세요.", ownerOnly: true };
    case "find":
      return args
        ? { message: `이 요청에 더 적합한 팀원 아바타가 있는지 찾아보고 추천해줘.\n\n${args}` }
        : { message, error: "/find 뒤에 요청 내용을 입력해 주세요." };
    case "new":
      return { message, error: "/new는 입력창의 슬래시 메뉴에서 새 대화로 실행해 주세요." };
    default:
      return { message };
  }
}

// User-facing (Korean) messages for image-upload validation failures.
const CHAT_IMAGE_ERROR: Record<string, string> = {
  TOO_MANY: `이미지는 한 번에 최대 ${MAX_CHAT_IMAGES_PER_MESSAGE}장까지 첨부할 수 있습니다.`,
  BAD_FORMAT: "지원하는 이미지 형식은 png/jpeg/webp/gif 입니다.",
  DECODE_FAILED: "이미지를 디코드할 수 없습니다.",
  EMPTY: "빈 이미지는 첨부할 수 없습니다.",
  TOO_LARGE: "이미지 한 장의 크기는 5MB 이하여야 합니다.",
};

function prepareSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function isEmptyStoppedAssistant(message: StoredMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.trim() === "(중지됨)" &&
    message.response?.summary === "중지됨" &&
    !message.response.text?.trim()
  );
}

export function conversationHistoryForPrompt(messages: StoredMessage[]): AgentConversationMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") {
      return [];
    }
    if (!message.content.trim() || isEmptyStoppedAssistant(message)) {
      return [];
    }
    return [{ role: message.role, content: message.content }];
  });
}

export function createChatRouter({ config, store, observedModel, auditAs }: RouterDeps): Router {
  const router = Router();

  // ---- Discovery -------------------------------------------------------

  router.get("/api/avatars", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ avatars: store.listPublishedAvatars(req.user!.id) });
  });

  router.get("/api/avatars/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const avatar = store.getAvatar(req.user!.id, req.params.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }
    res.json({ avatar });
  });

  // List the skills an avatar can use, for the chat-screen capabilities panel.
  // Lazily resolves plugin roots (may clone), so it's a separate endpoint hit
  // only when the panel opens — not bundled into the avatar detail above.
  // Visibility mirrors getAvatar: must be an avatar visible to the viewer (or their own).
  router.get("/api/avatars/:id/skills", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const avatar = store.getAvatar(req.user!.id, req.params.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }
    // The local runtime loads no plugins/skills, so there's nothing to list.
    if (config.agentRuntime === "local") {
      res.json({ skills: [] });
      return;
    }
    const { sourced } = await resolveAvatarSkillSources(store, avatar, config, false);
    res.json({ skills: await listSkillsInRoots(sourced) });
  });

  // The owner's registered general git repos, for the active-repo-workspace
  // picker (#47). Returns name/repo/branch only — never the local clone path.
  router.get("/api/me/git-repos", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({
      repos: store.listGitRepos(req.user!.id).map((r) => ({ name: r.name, repo: r.repo, branch: r.branch })),
    });
  });

  // ---- Conversations & messages ---------------------------------------

  router.get("/api/conversations", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const avatarId = safeString(req.query.avatarId) || undefined;
    const kindRaw = safeString(req.query.kind);
    const kind = kindRaw === "routine" || kindRaw === "all" ? kindRaw : "chat";
    res.json({ conversations: store.listConversations(req.user!.id, avatarId, kind) });
  });

  router.get("/api/messages", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const conversationId = safeString(req.query.conversationId);
    if (!conversationId) {
      res.json({ messages: [] });
      return;
    }
    res.json({
      messages: store.listMessages(req.user!.id, conversationId),
      // Owner-only group-knowledge toggle state for this conversation (group ids
      // turned OFF). The client shows the toggle only for the owner's own avatar.
      groupKnowledgeOff: store.getConversationGroupKnowledgeOff(req.user!.id, conversationId),
      // The user's chosen model tier for this conversation (null = server default),
      // so the composer picker restores on reload.
      selectedModel: store.getConversationModel(req.user!.id, conversationId),
    });
  });

  // Persist the activity-tree snapshot (tools/agents the avatar ran) onto a stored
  // assistant message so the completed bubble keeps showing it after reload. The
  // client posts its already-humanized snapshot once the turn finishes.
  router.put("/api/messages/:id/activity", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ok = store.setMessageActivity(req.user!.id, req.params.id, sanitizeActivity(req.body?.activity));
    if (!ok) {
      apiError(res, 404, "메시지를 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  router.patch("/api/conversations/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const title = safeString(req.body?.title);
    const conversation = store.renameConversation(req.user!.id, req.params.id, title);
    if (!conversation) {
      apiError(res, 404, "대화를 찾을 수 없습니다.");
      return;
    }
    res.json({ conversation });
  });

  router.delete("/api/conversations", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ownerId = req.user!.id;
    const ids = store.listConversations(ownerId, undefined, "chat").map((conversation) => conversation.id);
    for (const id of ids) {
      const active = getActiveRunForConversation(ownerId, id);
      if (active) {
        cancelRun(active.runId, ownerId);
      }
    }
    const deletedIds = store.deleteChatConversations(ownerId);
    for (const id of deletedIds) {
      deleteConversationImages(config, id);
    }
    res.json({ ok: true, deleted: deletedIds.length, conversationIds: deletedIds });
  });

  router.delete("/api/conversations/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    // Cancel any in-flight run for this conversation first so it stops streaming
    // and its cancel/error path skips the (now-impossible) message persistence
    // instead of racing the row deletion. (lifecycle-03)
    const active = getActiveRunForConversation(req.user!.id, req.params.id);
    if (active) {
      cancelRun(active.runId, req.user!.id);
    }
    const removed = store.deleteConversation(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "대화를 찾을 수 없습니다.");
      return;
    }
    // Sweep the conversation's uploaded chat images (best effort).
    deleteConversationImages(config, req.params.id);
    res.json({ ok: true });
  });

  // Serve a chat-message image attachment. Owner-scoped: only the conversation's
  // owner may read its images (matches listMessages' ownership gate). The id is
  // validated against path traversal inside resolveStoredImage.
  router.get(
    "/api/conversations/:conversationId/images/:imageId",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const { conversationId, imageId } = req.params;
      if (store.conversationOwner(conversationId) !== req.user!.id) {
        apiError(res, 404, "이미지를 찾을 수 없습니다.");
        return;
      }
      const resolved = resolveStoredImage(config, conversationId, imageId);
      if (!resolved) {
        apiError(res, 404, "이미지를 찾을 수 없습니다.");
        return;
      }
      res.type(resolved.mediaType);
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.sendFile(resolved.path);
    },
  );

  // ---- Chat (SSE) ------------------------------------------------------

  router.post("/api/chat/stream", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const rawMessage = safeString(req.body?.message);
    const slashExpansion = expandChatSlashCommand(rawMessage);
    if (slashExpansion.error) {
      apiError(res, 400, slashExpansion.error);
      return;
    }
    // Show/store the literal command the user typed (e.g. "/learn"); feed the
    // EXPANDED prompt to the agent. So the bubble + persisted turn stay "/learn"
    // while the model receives the full instruction. For a normal (non-slash)
    // message the two are identical.
    const displayMessage = rawMessage;
    const agentMessage = slashExpansion.message;
    const avatarId = safeString(req.body?.avatarId);
    // Greeting: the owner opened a fresh chat with their own avatar and typed
    // nothing — the avatar speaks first (and reports pending info requests).
    const greeting = req.body?.greeting === true && req.user!.id === avatarId;

    // Image attachments on this turn (data URLs from the composer). Validate +
    // decode up front so a bad/oversized upload stays plain JSON (before SSE).
    // Ignored for a greeting (no user message). Bytes are written to disk in the
    // persist block below; the model is fed `requestImages` this turn.
    const decodedImagesResult = greeting ? { images: [] as never[] } : decodeChatImages(req.body?.images);
    if ("error" in decodedImagesResult) {
      apiError(res, 400, CHAT_IMAGE_ERROR[decodedImagesResult.error]);
      return;
    }
    const decodedImages = decodedImagesResult.images;

    // Validate BEFORE switching to SSE so failures stay plain JSON. A turn with
    // image attachments but no text is allowed (the images are the message).
    if (!displayMessage && !greeting && decodedImages.length === 0) {
      apiError(res, 400, "메시지를 입력해 주세요.");
      return;
    }
    if (!avatarId) {
      apiError(res, 400, "avatarId가 필요합니다.");
      return;
    }
    const avatar = store.resolveChatAvatar(req.user!.id, avatarId);
    if (!avatar) {
      apiError(res, 403, "이 아바타와 대화할 수 없습니다.");
      return;
    }
    // ownerOnly bites on a RAW `/command`: server-expanded commands (e.g. /learn)
    // arrive verbatim and DO match here, and so does a stale client / direct API
    // caller. Client-expanded commands arrive already-expanded and slip past — but
    // that's fine: this is a convenience guard, not the real boundary. The owner-only
    // EFFECTS (knowledge-repo writes, routine creation) run through `mcp__repo__*` /
    // routine APIs that owner-gate in their own handlers, so an expanded prompt from
    // a non-owner can't reach them.
    if (slashExpansion.ownerOnly && req.user!.id !== avatar.id) {
      apiError(res, 403, "이 명령은 내 아바타와의 대화에서만 사용할 수 있습니다.");
      return;
    }
    const viewerIsOwner = req.user!.id === avatar.id;
    // Owner-only per-conversation group-knowledge selection, chosen in the UI and
    // sent with the turn: the group ids turned OFF (skills + CLAUDE.md). The client
    // owns this state from the moment a chat starts, so no separate persist step is
    // needed; the server applies it this turn and stores it on the conversation.
    // Colleague turns ignore it (always all-on); null = client sent nothing → keep
    // whatever is already stored.
    const requestedGroupKnowledgeOff =
      viewerIsOwner && Array.isArray(req.body?.groupKnowledgeOff)
        ? (req.body.groupKnowledgeOff as unknown[]).filter((x): x is string => typeof x === "string")
        : null;

    // Per-conversation model tier chosen in the composer (all viewers, not just
    // the owner). A known tier alias applies; "" clears back to the server default;
    // anything else (incl. nothing sent) → null = keep whatever is already stored.
    // Like groupKnowledgeOff, the client owns this and sends it on each turn, so it
    // works from a brand-new chat (incl. the greeting) with no row yet.
    const rawModel = safeString(req.body?.model);
    const requestedModel: string | null =
      req.body?.model === undefined || req.body?.model === null
        ? null
        : isModelTier(rawModel)
          ? rawModel
          : ""; // sent but not a known tier (incl. empty) → clear to default

    const suppliedConversationId = safeString(req.body?.conversationId);
    if (suppliedConversationId && !isSafePathId(suppliedConversationId)) {
      apiError(res, 400, "대화 ID가 올바르지 않습니다.");
      return;
    }
    // Reject a supplied id that already belongs to ANOTHER user before any DB
    // write: otherwise touchConversation falls through to an INSERT that hits the
    // conversations PRIMARY KEY and throws (an unhandled rejection on Express 4).
    if (suppliedConversationId) {
      const owner = store.conversationOwner(suppliedConversationId);
      if (owner && owner !== req.user!.id) {
        apiError(res, 409, "사용할 수 없는 대화 ID입니다.");
        return;
      }
    }
    const conversationId = suppliedConversationId || crypto.randomUUID();
    const existingAvatarId = store.getConversationAvatarId(req.user!.id, conversationId);
    if (existingAvatarId && existingAvatarId !== avatar.id) {
      apiError(res, 409, "이 대화는 다른 아바타의 대화입니다.");
      return;
    }
    // A run is already streaming for this conversation. This POST carries a NEW
    // typed message; the old attach-and-replay path would silently swallow it
    // (never persisted, never echoed — the client would only mirror the FIRST
    // turn's answer). Reject so the client surfaces the error and keeps the text
    // in the composer. Reconnecting to WATCH an in-flight run uses the dedicated
    // GET /api/chat/runs/:runId/events path, not a second POST.
    const activeRun = getActiveRunForConversation(req.user!.id, conversationId);
    if (activeRun) {
      apiError(res, 409, "이미 이 대화의 응답을 생성 중입니다. 잠시 후 다시 시도해 주세요.");
      return;
    }

    // Active repo workspace (#47): owner/trusted viewers may open one registered
    // git repo as the SDK cwd so the avatar edits/tests it with native tools.
    // Resolve + clone + take the per-clone serialization lock BEFORE switching to
    // SSE, so validation/contention failures stay plain JSON. The clone path is
    // server-side only and never returned to the client (only the repo name).
    const elevatedViewer = viewerIsOwner || store.isTrustedFor(req.user!.id, avatar.id);
    const requestedActiveRepo = elevatedViewer ? safeString(req.body?.activeRepo) : "";
    let activeRepoCwd: string | null = null;
    let activeRepoName: string | null = null;
    let activeRepoLockPath: string | null = null;
    if (requestedActiveRepo) {
      const repoCtx = gitRepoContextFor(store, avatar.id, requestedActiveRepo, config);
      if (!repoCtx) {
        apiError(res, 400, "등록된 저장소를 찾을 수 없습니다. 먼저 저장소를 등록해 주세요.");
        return;
      }
      const clonePath = gitRepoClonePath(avatar.id, repoCtx.name, config);
      if (!acquireActiveRepo(clonePath, conversationId)) {
        apiError(res, 409, "이 저장소는 다른 대화에서 작업 중입니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      activeRepoLockPath = clonePath;
      try {
        // Ensure the clone exists WITHOUT syncing — a fetch/checkout here could
        // clobber native edits; sync stays an explicit mcp__git_repo__sync_repo.
        activeRepoCwd = await ensureGitRepoClone(repoCtx);
        activeRepoName = repoCtx.name;
      } catch (error) {
        releaseActiveRepo(clonePath, conversationId);
        apiError(res, 502, `저장소 작업공간을 열지 못했습니다: ${scrubGitError(error)}`);
        return;
      }
    }

    const runId = crypto.randomUUID();
    const regenerate = req.body?.regenerate === true;
    const chatStart = Date.now();
    if (regenerate) {
      store.dropLastAssistant(req.user!.id, conversationId);
    }
    const imageTurn = !greeting && !regenerate && decodedImages.length > 0;
    // Resume the conversation's prior SDK session so the model keeps its context
    // across turns. A greeting is ephemeral (never persisted), and a regenerate
    // re-runs the same turn — both start a fresh session to avoid duplicating
    // history in the transcript. Image turns also start fresh: the SDK receives
    // images through streaming input, and combining that with `resume` can drop
    // the structured image blocks before they reach the model.
    const resumeSessionId =
      greeting || regenerate || imageTurn
        ? undefined
        : store.getAgentSessionId(req.user!.id, conversationId) ?? undefined;
    // Inject prior context whenever there's no SDK session to resume. A greeting
    // has none. A regenerate deliberately starts a FRESH session (so the re-run
    // turn isn't duplicated in the transcript) but must STILL carry the
    // conversation so far — otherwise the model answers the regenerated turn
    // blind, AND the fresh session id is then persisted, so every later turn
    // would resume a context-less session too. (chat-01 / lifecycle-02)
    const conversationHistory =
      !greeting && !resumeSessionId
        ? conversationHistoryForPrompt(store.listMessages(req.user!.id, conversationId))
        : [];
    // On regenerate the trailing history entry is the user turn being re-run,
    // which is ALSO re-sent as `message` — drop it so it isn't duplicated.
    if (
      regenerate &&
      conversationHistory.length > 0 &&
      conversationHistory[conversationHistory.length - 1].role === "user"
    ) {
      conversationHistory.pop();
    }
    // Images fed to the model THIS turn. For a fresh send we save the uploads to
    // disk + record them on the user message; on regenerate the client doesn't
    // re-send images (it re-runs from a fresh SDK session), so re-read the prior
    // user turn's stored attachments so the re-run still sees them.
    let requestImages: AgentImageInput[] = [];
    if (!greeting) {
      store.touchConversation(req.user!.id, conversationId, avatar.id, displayMessage);
      // Persist the owner's group-knowledge selection now that the row exists, so
      // it survives reload and applies to later turns until changed again.
      if (requestedGroupKnowledgeOff) {
        store.setConversationGroupKnowledgeOff(req.user!.id, conversationId, requestedGroupKnowledgeOff);
      }
      // Persist the chosen model tier so it survives reload and applies to later
      // turns until changed. null = client sent nothing → leave the stored value.
      if (requestedModel !== null) {
        store.setConversationModel(req.user!.id, conversationId, requestedModel || null);
      }
      if (!regenerate) {
        const saved = saveChatImages(config, conversationId, decodedImages);
        requestImages = saved.images;
        store.addMessage(conversationId, {
          role: "user",
          content: displayMessage,
          attachments: saved.attachments,
        });
      } else {
        const priorMessages = store.listMessages(req.user!.id, conversationId);
        const lastUser = [...priorMessages].reverse().find((m) => m.role === "user");
        requestImages = readChatImages(config, conversationId, lastUser?.attachments);
      }
    }
    // The SDK session id this run reports (init event); persisted on success so
    // the next turn can resume it.
    let runSessionId: string | null = null;
    // Accumulate the main-agent text as it streams, so the cancel/error paths can
    // persist the partial the user already watched (not an empty "(중지됨)" stub).
    let streamedText = "";
    // Visual-canvas artifacts shown this turn (experimental `canvas` feature, #50),
    // persisted on the assistant message's response so the panel rebuilds on reload.
    const canvasArtifacts: CanvasArtifact[] = [];
    logger.info(
      { userId: req.user!.id, avatarId: avatar.id, conversationId, greeting, regenerate },
      "chat stream started",
    );

    const abortController = new AbortController();
    openRun(runId, req.user!.id, { conversationId, avatarId: avatar.id, abortController });
    prepareSse(res);
    if (!attachRunClient(runId, req.user!.id, res)) {
      res.end();
      closeRun(runId);
      if (activeRepoLockPath) {
        releaseActiveRepo(activeRepoLockPath, conversationId);
      }
      return;
    }
    emitRunEvent(runId, "open", { conversationId, avatarId: avatar.id, runId });

    try {
      // Load plugin roots (read-only): default plugins + the avatar's own + its
      // personal knowledge repo + group knowledge repos. Shared with the routine
      // scheduler via `loadAgentPluginRoots` so the two can't drift. Tolerate
      // clone/resolve fails.
      const pluginWarnings: string[] = [];
      // Owner-only per-conversation group-knowledge toggle: skip the OFF groups'
      // skills AND their CLAUDE.md. Use this turn's selection when the client sent
      // one (incl. a greeting before any row exists), else the stored set. Colleague
      // turns ignore the toggle (always ON).
      const disabledGroupIds = viewerIsOwner
        ? new Set(requestedGroupKnowledgeOff ?? store.getConversationGroupKnowledgeOff(req.user!.id, conversationId))
        : new Set<string>();
      // Model tier for this turn: this turn's pick if the client sent one ("" =
      // explicit reset to default), else the stored value. Greetings carry no row,
      // so read from `requestedModel` directly when sent. Ignored downstream when
      // ANTHROPIC_MODEL pins a model (env pin is a hard lock).
      const conversationModelTier =
        requestedModel === null
          ? store.getConversationModel(req.user!.id, conversationId)
          : requestedModel || null;
      const pluginRoots = await loadAgentPluginRoots(
        store,
        avatar.id,
        config,
        (warn) => pluginWarnings.push(warn),
        { disabledGroupIds },
      );
      // Standing CLAUDE.md memory (personal repo always; group repos gated by the
      // toggle). Read after plugin roots ensured the clones for this turn.
      const knowledgeMemory = await loadKnowledgeRepoMemory(store, avatar.id, config, {
        disabledGroupIds,
      });

      // Per-conversation workspace: each chat session gets an isolated cwd, scoped
      // under the avatar so sessions cannot mix files by accident.
      const workspaceDir = workspaceDirFor(config, avatar.id, conversationId);
      fs.mkdirSync(workspaceDir, { recursive: true });

      for (const warn of pluginWarnings) {
        emitRunEvent(runId, "status", { label: `플러그인 경고: ${warn}` });
      }

      const response = await runAgentStream(
        {
          message: agentMessage,
          avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias, persona: avatar.persona },
          // Active repo workspace (#47): the repo clone becomes the cwd and the
          // per-conversation scratch dir is exposed as an additional writable dir.
          cwd: activeRepoCwd ?? workspaceDir,
          additionalDirs: activeRepoCwd ? [workspaceDir] : undefined,
          activeRepoName: activeRepoName ?? undefined,
          resumeSessionId,
          conversationHistory,
          images: requestImages.length ? requestImages : undefined,
          modelTier: conversationModelTier ?? undefined,
          viewerUserId: req.user!.id,
          viewerName: req.user!.displayName,
          viewerIsOwner,
          knowledgeMemory,
          // Elevated tool permissions for the owner OR a trusted user. The tool
          // gate denies everyone else, so auto-approving the elevated path is safe.
          elevated: elevatedViewer,
          // WHY a non-owner viewer is elevated, when group co-membership is the
          // source: the shared group names surface in the prompt (META-COGNITION).
          trustedViaGroups:
            req.user!.id === avatar.id ? [] : store.sharedGroupNames(req.user!.id, avatar.id),
          autoApprove: true,
          greeting,
        },
        pluginRoots,
        config,
        store,
        {
          onDelta: (text) => {
            streamedText += text;
            emitRunEvent(runId, "delta", { text });
          },
          onStatus: (label) => {
            emitRunEvent(runId, "status", { label });
          },
          onModel: (model) => {
            observedModel.set(model);
          },
          onSessionId: (sessionId) => {
            runSessionId = sessionId;
          },
          onPlugin: (event) => {
            emitRunEvent(runId, "plugin", { status: event.status, name: event.name });
          },
          onToolStart: (event) => {
            emitRunEvent(runId, "tool", event);
          },
          onToolEnd: (event) => {
            emitRunEvent(runId, "tool_end", event);
          },
          onTaskStart: (event) => {
            emitRunEvent(runId, "task", event);
          },
          onTaskUpdate: (event) => {
            emitRunEvent(runId, "task_update", event);
          },
          onTaskEnd: (event) => {
            emitRunEvent(runId, "task_end", event);
          },
          onAgentStart: (event) => {
            emitRunEvent(runId, "agent", event);
          },
          onAgentEnd: (event) => {
            emitRunEvent(runId, "agent_end", event);
          },
          onBlocked: (event) => {
            emitRunEvent(runId, "blocked", event);
          },
          // Interactive permission prompt (owner only — see claudeAgent).
          onPermission: async (requestData) => {
            const requestId = crypto.randomUUID();
            emitRunEvent(runId, "permission", { runId, requestId, ...requestData });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              return { behavior: "deny" };
            }
            return (answer as { behavior: "allow" }).behavior === "allow"
              ? { behavior: "allow" }
              : { behavior: "deny" };
          },
          // AskUserQuestion (and other request_user_dialog kinds).
          onQuestion: async (requestData) => {
            const requestId = crypto.randomUUID();
            emitRunEvent(runId, "question", {
              runId,
              requestId,
              dialogKind: requestData.dialogKind,
              payload: requestData.payload,
            });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              return { behavior: "cancelled" };
            }
            const reply = answer as { cancelled?: boolean; result?: unknown };
            if (reply?.cancelled) {
              return { behavior: "cancelled" };
            }
            return { behavior: "completed", result: reply?.result };
          },
          // Visual canvas (experimental `canvas` feature, #50). Mirror the
          // question wiring: emit the artifact over SSE, and when controls were
          // declared (awaitInput) park the run until the user submits via
          // /api/chat/respond. Always record the artifact so it persists.
          onCanvas: async (requestData) => {
            const requestId = crypto.randomUUID();
            const { artifactId, title, content, contentType, controls } = requestData;
            emitRunEvent(runId, "canvas", {
              runId,
              requestId,
              artifactId,
              title,
              content,
              contentType,
              controls: controls ?? null,
            });
            const record = (submittedValues?: Record<string, unknown>) => {
              // Upsert by id: a same-`canvasId` update within this turn replaces the
              // earlier version so the persisted artifact reflects its final state
              // (mirrors the client's upsert-by-id in handleCanvas/canvasesFromMessages).
              const entry: CanvasArtifact = { id: artifactId, title, content, contentType, controls, submittedValues };
              const idx = canvasArtifacts.findIndex((c) => c.id === artifactId);
              if (idx >= 0) canvasArtifacts[idx] = entry;
              else canvasArtifacts.push(entry);
            };
            if (!requestData.awaitInput) {
              record();
              return { behavior: "shown" };
            }
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              record();
              return { behavior: "cancelled" };
            }
            const reply = answer as { cancelled?: boolean; values?: Record<string, unknown> };
            if (reply?.cancelled) {
              record();
              return { behavior: "cancelled" };
            }
            record(reply?.values ?? {});
            return { behavior: "submitted", values: reply?.values ?? {} };
          },
        },
        abortController,
      );

      // Carry any canvases shown this turn on the response so they persist with
      // the assistant message and rebuild on reload (and ride the greeting's
      // ephemeral done event for the live panel). (#50)
      if (canvasArtifacts.length) {
        response.canvases = canvasArtifacts;
      }

      // A greeting is ephemeral: it streams to the screen but is NOT persisted,
      // so opening a fresh chat doesn't litter the history with greeting-only
      // conversations. The conversation starts saving on the owner's first real
      // message.
      if (greeting) {
        emitRunEvent(runId, "done", {
          message: {
            role: "assistant",
            content: response.text || response.summary,
            response,
            createdAt: new Date().toISOString(),
          },
          response,
        });
        return;
      }

      // Remember this run's SDK session so the next turn resumes its context.
      if (runSessionId) {
        store.setAgentSessionId(req.user!.id, conversationId, runSessionId);
      }
      // The conversation may have been deleted mid-run; skip persistence (the FK
      // on messages would reject the insert) and just signal completion.
      const assistantMessage =
        store.conversationOwner(conversationId) === req.user!.id
          ? store.addMessage(conversationId, {
              role: "assistant",
              content: response.text || response.summary,
              response,
            })
          : null;
      auditAs(req, "chat", `chat with ${avatar.displayName} (${response.runtime})`);
      logger.info(
        { userId: req.user!.id, avatarId: avatar.id, conversationId, runtime: response.runtime, durationMs: Date.now() - chatStart },
        "chat completed",
      );

      emitRunEvent(runId, "done", { message: assistantMessage, response });
    } catch (error) {
      if (isRunCancelled(runId)) {
        if (!greeting) {
          // Clear the persisted SDK session: the aborted run's transcript is
          // incomplete, so the NEXT turn rebuilds context from stored messages
          // (which now include this cancelled turn's user message + partial)
          // instead of resuming a half-written session that omits it. (chat-02)
          store.setAgentSessionId(req.user!.id, conversationId, null);
          // Keep whatever the model already streamed before the stop. The client's
          // finalizeStopped keeps it on screen, so the persisted record must carry
          // it too — otherwise the visible answer is gone on the next reload/revisit.
          const response: AgentResponse = {
            kind: "text",
            runtime: config.agentRuntime,
            summary: "중지됨",
            text: streamedText,
            ...(canvasArtifacts.length ? { canvases: canvasArtifacts } : {}),
          };
          // Skip the insert if the conversation was deleted mid-run (FK would reject).
          const stopped =
            store.conversationOwner(conversationId) === req.user!.id
              ? store.addMessage(conversationId, {
                  role: "assistant",
                  content: streamedText || "(중지됨)",
                  response,
                })
              : null;
          emitRunEvent(runId, "cancelled", { message: stopped, response });
        } else {
          emitRunEvent(runId, "cancelled", { message: null });
        }
        return;
      }
      // Scrub before logging too: a git auth failure carries the token in its
      // argv (`http.extraHeader`), which pino's `err` serializer would emit.
      const detail = scrubGitError(error);
      logger.error(
        { detail, userId: req.user!.id, avatarId: avatar.id, conversationId, durationMs: Date.now() - chatStart },
        "chat error",
      );
      auditAs(req, "chat", detail, "error");
      if (!greeting && store.conversationOwner(conversationId) === req.user!.id) {
        // Clear the session for the same reason as the cancel path (chat-02), and
        // don't discard the partial the user already watched stream — keep it
        // alongside the error so a reload shows what the live view showed.
        store.setAgentSessionId(req.user!.id, conversationId, null);
        const content = streamedText ? `${streamedText}\n\n${detail}` : detail;
        // If the turn showed canvases before erroring, persist them so they
        // survive reload (mirrors the cancel path). text=content keeps the error
        // bubble identical to before; a response is only attached when there's a
        // canvas to carry, so plain errors keep their existing (null-response) shape.
        store.addMessage(conversationId, {
          role: "assistant",
          content,
          response: canvasArtifacts.length
            ? { kind: "text", runtime: config.agentRuntime, summary: "오류", text: content, canvases: canvasArtifacts }
            : undefined,
        });
      }
      emitRunEvent(runId, "error", { error: detail });
    } finally {
      if (activeRepoLockPath) {
        releaseActiveRepo(activeRepoLockPath, conversationId);
      }
      closeRun(runId);
    }
  });

  router.get("/api/chat/runs", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const conversationId = safeString(req.query.conversationId);
    if (!conversationId) {
      apiError(res, 400, "conversationId가 필요합니다.");
      return;
    }
    res.json({ run: getActiveRunForConversation(req.user!.id, conversationId) });
  });

  router.get("/api/chat/runs/:runId/events", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const runId = safeString(req.params.runId);
    const run = getActiveRun(runId, req.user!.id);
    if (!run) {
      apiError(res, 404, "진행 중인 실행을 찾을 수 없습니다.");
      return;
    }
    const lastEventId = Number(req.get("Last-Event-ID") || req.query.since || 0);
    prepareSse(res);
    if (!attachRunClient(runId, req.user!.id, res, Number.isFinite(lastEventId) ? lastEventId : 0)) {
      res.end();
    }
  });

  router.post("/api/chat/runs/:runId/cancel", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const runId = safeString(req.params.runId);
    if (!cancelRun(runId, req.user!.id)) {
      apiError(res, 404, "진행 중인 실행을 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
  });

  // Answer an interactive prompt (permission / AskUserQuestion) raised mid-run.
  // The run stream stays open on a separate request; this delivers the reply.
  router.post("/api/chat/respond", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const runId = safeString(req.body?.runId);
    const requestId = safeString(req.body?.requestId);
    if (!runId || !requestId) {
      apiError(res, 400, "runId와 requestId가 필요합니다.");
      return;
    }
    // The value is consumed by onPermission/onQuestion as an object
    // ({behavior} | {cancelled} | {result}); reject a non-object up front.
    const value = req.body?.value;
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      apiError(res, 400, "응답 형식이 올바르지 않습니다.");
      return;
    }
    const delivered = submitResponse(runId, requestId, req.user!.id, value);
    if (!delivered) {
      apiError(res, 404, "처리할 수 없는 응답입니다(만료되었거나 권한 없음).");
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
