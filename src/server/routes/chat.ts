import crypto from "node:crypto";
import fs from "node:fs";
import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { listSkillsInRoots, loadAgentPluginRoots, loadKnowledgeRepoMemory } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import { configureGitRepoIdentity, ensureGitRepoClone, gitRepoContextFor, gitRepoClonePath } from "../gitRepos.js";
import { commitIdentityFor } from "../knowledgeRepo.js";
import { acquireActiveRepo, releaseActiveRepo } from "../activeRepoLock.js";
import { getWorkspaceRepo } from "../repoWorkspace.js";
import type { AgentConversationMessage, AgentImageInput, AgentResponse, StoredMessage } from "../types.js";
import { formatSubmission, MAX_CANVAS_CONTENT_CHARS } from "../agent/canvasTools.js";
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
import { isEffortLevel } from "../effortLevels.js";
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
  "Review this conversation session and identify the knowledge that is worth reusing later, so my knowledge repository can be updated.",
  "",
  "Look for important facts, decisions, repeatable procedures, project rules, or ways the user said they prefer to work, plus a clear and explicit record of what you (this avatar) CAN and CANNOT do right now — your current capabilities, the tools/repositories/skills you have connected, and any known limitations or things you were unable to do this session — so future sessions act on an accurate self-picture instead of guessing.",
  "Do not include small talk, anything already stored, or anything not useful long-term.",
  "",
  "The goal is NOT to file a reflection essay in some corner of the repo — it is to change what actually happens next time. So make every entry actionable and retrievable:",
  "- For any mistake, dead end, or thing that went wrong this session, do not just record what happened. Record it as a reusable recipe: the SYMPTOM (how it shows up), the ROOT CAUSE, and the CORRECTION (what to do instead next time) — so the same mistake is not repeated when this kind of work comes up again.",
  "- State the TRIGGER for each entry: which task, workflow, or situation should bring this knowledge back to mind in a future session. Phrase it with the words a future search would actually use (recall here is read-only search, so an entry that is not findable at the right moment is useless).",
  "- Prefer durable rules and 'do X instead of Y' guidance over one-off facts. If an entry cannot influence a future decision or action, it is probably not worth saving.",
  "",
  "IMPORTANT — ask before writing: do NOT write to or commit anything to the knowledge repository yet. First show me a concise summary of exactly what you propose to save (which file or skill each entry goes to, and the gist of each entry) and what you will deliberately skip and why, then ask me to confirm.",
  "Only after I approve should you write the entries and commit. If I ask for changes, adjust the proposal and confirm again before writing.",
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
    // The expansions below are agent-facing: the user only ever sees the literal
    // "/command" in the bubble (the client sends the literal; the server swaps in
    // these prompts for the model), so per the language split they are English.
    // The avatar still REPLIES in the user's language per buildPrompt. Only the
    // user-facing `error` strings stay Korean.
    case "summarize":
      return {
        message:
          "Summarize the conversation so far, grouped into key decisions, action items, and open questions.",
      };
    case "remember":
      return args
        ? {
            message: `Record the following into my knowledge repository so you can answer the same question in the future.\n\n${args}`,
            ownerOnly: true,
          }
        : { message, error: "/remember 뒤에 저장할 내용을 입력해 주세요.", ownerOnly: true };
    case "routine":
      return args
        ? {
            message: `Create a routine that runs the following task on a recurring schedule. If an execution time (KST) is written below, use it as-is; otherwise ask me for it first.\n\n${args}`,
            ownerOnly: true,
          }
        : { message, error: "/routine 뒤에 작업 내용을 입력해 주세요.", ownerOnly: true };
    case "find":
      return args
        ? { message: `Find and recommend a colleague avatar better suited to this request.\n\n${args}` }
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

/** A non-blocking canvas submission/edit delivered as a normal /api/chat/stream turn. */
interface CanvasSubmissionInput {
  canvasId: string;
  values?: Record<string, unknown>;
  editedContent?: string;
}

/** Parse + validate the optional `canvasSubmission` body field (#50). Null when absent/invalid. */
function parseCanvasSubmission(raw: unknown): CanvasSubmissionInput | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const canvasId = typeof obj.canvasId === "string" ? obj.canvasId.trim() : "";
  if (!canvasId) {
    return null;
  }
  const out: CanvasSubmissionInput = { canvasId };
  if (obj.values && typeof obj.values === "object" && !Array.isArray(obj.values)) {
    out.values = obj.values as Record<string, unknown>;
  }
  if (typeof obj.editedContent === "string" && obj.editedContent.trim()) {
    out.editedContent = obj.editedContent.slice(0, MAX_CANVAS_CONTENT_CHARS);
  }
  // Must carry at least one of values/editedContent to be meaningful.
  if (!out.values && !out.editedContent) {
    return null;
  }
  return out;
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
      // The user's chosen effort level for this conversation (null = SDK default),
      // so the composer picker restores on reload.
      selectedEffort: store.getConversationEffort(req.user!.id, conversationId),
      // Visual-canvas artifacts (current version of each) so the side panel rebuilds
      // on reload from the dedicated tables, not from message.response.canvases (#50).
      canvases: store.listCanvasArtifacts(req.user!.id, conversationId),
    });
  });

  // Canvas version history + non-destructive rollback (#50). User-initiated UI,
  // owner-gated in the store; not agent-facing.
  router.get("/api/chat/canvases/:id/versions", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ versions: store.listCanvasVersions(req.user!.id, req.params.id) });
  });

  router.post("/api/chat/canvases/:id/rollback", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) {
      apiError(res, 400, "잘못된 버전입니다.");
      return;
    }
    const artifact = store.rollbackCanvasArtifact(req.user!.id, req.params.id, version);
    if (!artifact) {
      apiError(res, 404, "캔버스 또는 버전을 찾을 수 없습니다.");
      return;
    }
    res.json({ canvas: artifact });
  });

  // Hard-delete a persisted canvas (closing its tab). Owner-gated in the store.
  router.delete("/api/chat/canvases/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ok = store.deleteCanvasArtifact(req.user!.id, req.params.id);
    if (!ok) {
      apiError(res, 404, "캔버스를 찾을 수 없습니다.");
      return;
    }
    res.json({ ok: true });
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
    let displayMessage = rawMessage;
    let agentMessage = slashExpansion.message;
    // Non-blocking canvas interaction (#50): a submission or content edit arrives as
    // a normal turn. The visible bubble is a short Korean summary; the agent gets a
    // formatted English message describing what the user did, referencing the canvas
    // id so the avatar can refine it in place with the same canvasId.
    const canvasSubmission = parseCanvasSubmission(req.body?.canvasSubmission);
    if (canvasSubmission) {
      const title = store.getCanvasArtifact(req.user!.id, canvasSubmission.canvasId)?.title?.trim();
      const ref = title
        ? `the canvas "${title}" (id: ${canvasSubmission.canvasId})`
        : `the canvas (id: ${canvasSubmission.canvasId})`;
      const parts: string[] = [];
      if (canvasSubmission.values) {
        parts.push(`On ${ref}, ${formatSubmission(canvasSubmission.values)}`);
      }
      if (canvasSubmission.editedContent) {
        parts.push(`The user edited ${ref} content to:\n${canvasSubmission.editedContent}`);
      }
      agentMessage = parts.join("\n\n") || `The user interacted with ${ref}.`;
      displayMessage = canvasSubmission.editedContent ? "캔버스를 수정해 보냈습니다." : "캔버스 응답을 보냈습니다.";
    }
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
    // The client owns this and sends it on each turn, so it works from a brand-new
    // chat (incl. the greeting) with no row yet. INTENTIONALLY per-conversation
    // ONLY — unlike groupKnowledgeOff there is NO per-user default column, so the
    // picker resets to the hardcoded server default for every new conversation
    // (the client seeds new panes from DEFAULT_MODEL_TIER, not a remembered choice).
    // This divergence is deliberate: model/effort is a per-turn knob, not a profile
    // preference, so we don't persist a per-user memory for it.
    const rawModel = safeString(req.body?.model);
    const requestedModel: string | null =
      req.body?.model === undefined || req.body?.model === null
        ? null
        : isModelTier(rawModel)
          ? rawModel
          : ""; // sent but not a known tier (incl. empty) → clear to default

    // Per-conversation reasoning effort, same client-owned, per-conversation-only
    // model as the tier above: a known level applies; "" clears back to the SDK
    // default; nothing sent → null = keep whatever is already stored. Like the tier,
    // there is NO per-user default — each new conversation resets to the SDK default
    // (the client seeds new panes from DEFAULT_EFFORT_LEVEL); this is intentional,
    // not a missing groupKnowledgeOff-style per-user memory.
    const rawEffort = safeString(req.body?.effort);
    const requestedEffort: string | null =
      req.body?.effort === undefined || req.body?.effort === null
        ? null
        : isEffortLevel(rawEffort)
          ? rawEffort
          : ""; // sent but not a known level (incl. empty) → clear to default

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

    // Working repository: the avatar opens one registered git repo (via
    // `mcp__git_repo__open_repo`) as the SDK cwd so it edits/tests with native
    // tools. The selection is held per conversation (repoWorkspace.ts) and read
    // here at turn start. Resolve + clone + take the per-clone serialization lock
    // BEFORE switching to SSE, so validation/contention failures stay plain JSON.
    // The clone path is server-side only and never returned to the client (only
    // the repo name). The elevated gate is belt-and-suspenders — open_repo is
    // itself elevated-only — in case trust changed since the repo was opened.
    const elevatedViewer = viewerIsOwner || store.isTrustedFor(req.user!.id, avatar.id);
    const requestedActiveRepo = elevatedViewer ? getWorkspaceRepo(conversationId) ?? "" : "";
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
        const owner = store.getUserById(avatar.id);
        await configureGitRepoIdentity(repoCtx, commitIdentityFor(store, {
          id: avatar.id,
          username: owner?.username ?? avatar.id,
          displayName: avatar.displayName,
          alias: avatar.alias,
        }));
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
      // Persist the chosen effort level (same semantics as the model tier above).
      if (requestedEffort !== null) {
        store.setConversationEffort(req.user!.id, conversationId, requestedEffort || null);
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
    // Visual-canvas artifacts (#50) now persist to the dedicated canvas tables as
    // they are shown (see the onCanvas handler), with version history — they no
    // longer ride the assistant message's response JSON.
    // The latest plan the avatar submitted via ExitPlanMode this turn (plan mode).
    // Persisted on the assistant response so the plan card rebuilds on reload, and
    // mirrored on the cancel/error paths like canvases. Latest plan of the turn wins.
    let latestPlan: string | null = null;
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
      // Effort for this turn: this turn's pick if sent ("" = reset to default),
      // else the stored value. Mirrors the model tier resolution above.
      const conversationEffort =
        requestedEffort === null
          ? store.getConversationEffort(req.user!.id, conversationId)
          : requestedEffort || null;
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
          // Lets in-process tools (open_repo/close_repo) key the working-repo
          // selection to this conversation.
          conversationId,
          // Working repository: the opened repo's clone becomes the cwd and the
          // per-conversation scratch dir is exposed as an additional writable dir.
          cwd: activeRepoCwd ?? workspaceDir,
          additionalDirs: activeRepoCwd ? [workspaceDir] : undefined,
          activeRepoName: activeRepoName ?? undefined,
          resumeSessionId,
          conversationHistory,
          images: requestImages.length ? requestImages : undefined,
          modelTier: conversationModelTier ?? undefined,
          effort: conversationEffort ?? undefined,
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
          // Plan mode: the avatar submitted a plan via ExitPlanMode. Surface it as
          // a dedicated plan card (display-only) and keep the latest one to persist
          // on the assistant response so it rebuilds on reload.
          onPlan: (event) => {
            latestPlan = event.plan;
            emitRunEvent(runId, "plan", { plan: event.plan });
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
            const { artifactId, title, content, contentType, controls, interaction, editable } = requestData;
            emitRunEvent(runId, "canvas", {
              runId,
              requestId,
              artifactId,
              title,
              content,
              contentType,
              // Pass controls WHENEVER present (not only when blocking) so an async
              // canvas's form still renders client-side.
              controls: controls ?? null,
              interaction: interaction ?? null,
              editable: Boolean(editable),
            });
            const record = (submittedValues?: Record<string, unknown>) => {
              // Persist to the dedicated canvas tables (version history). Refining
              // the same id appends a version; an unchanged re-show just refreshes
              // the submission. A greeting turn is ephemeral (never persisted), so
              // its canvases live only in the SSE stream, not the store.
              if (greeting) return;
              store.upsertCanvasArtifact(req.user!.id, conversationId, {
                artifactId,
                title,
                content,
                contentType,
                controls,
                submittedValues,
                interaction,
                editable,
              });
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

      // Canvases shown this turn are already persisted to the dedicated tables by
      // the onCanvas handler (with version history); they no longer ride the
      // response JSON. The live panel is driven by the SSE "canvas" events. (#50)
      // Carry the plan submitted this turn (plan mode) so the plan card persists
      // and rebuilds on reload, and rides the greeting's ephemeral done event.
      if (latestPlan) {
        response.plan = latestPlan;
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
            ...(latestPlan ? { plan: latestPlan } : {}),
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
        // Any canvas shown before the error is already persisted to the canvas
        // tables by the onCanvas handler. If a plan was submitted, carry it so the
        // plan card survives reload; text=content keeps the error bubble identical,
        // and a response is attached only when there's a plan (plain errors keep
        // their existing null-response shape).
        store.addMessage(conversationId, {
          role: "assistant",
          content,
          response: latestPlan
            ? {
                kind: "text",
                runtime: config.agentRuntime,
                summary: "오류",
                text: content,
                plan: latestPlan,
              }
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
