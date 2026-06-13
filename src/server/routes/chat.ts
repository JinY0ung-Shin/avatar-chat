import crypto from "node:crypto";
import fs from "node:fs";
import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { listSkillsInRoots, loadAgentPluginRoots, loadKnowledgeRepoMemory } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import type { AgentConversationMessage, AgentResponse, StoredMessage } from "../types.js";
import { runAgentStream } from "../agent/index.js";
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
import { apiError, resolveAvatarSkillSources, safeString, type RouterDeps } from "./_shared.js";

interface ChatSlashExpansion {
  message: string;
  error?: string;
  ownerOnly?: boolean;
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
    });
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
    res.json({ ok: true });
  });

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

    // Validate BEFORE switching to SSE so failures stay plain JSON.
    if (!displayMessage && !greeting) {
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

    const suppliedConversationId = safeString(req.body?.conversationId);
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

    const runId = crypto.randomUUID();
    const regenerate = req.body?.regenerate === true;
    const chatStart = Date.now();
    if (regenerate) {
      store.dropLastAssistant(req.user!.id, conversationId);
    }
    // Resume the conversation's prior SDK session so the model keeps its context
    // across turns. A greeting is ephemeral (never persisted), and a regenerate
    // re-runs the same turn — both start a fresh session to avoid duplicating
    // history in the transcript.
    const resumeSessionId =
      greeting || regenerate
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
    if (!greeting) {
      store.touchConversation(req.user!.id, conversationId, avatar.id, displayMessage);
      // Persist the owner's group-knowledge selection now that the row exists, so
      // it survives reload and applies to later turns until changed again.
      if (requestedGroupKnowledgeOff) {
        store.setConversationGroupKnowledgeOff(req.user!.id, conversationId, requestedGroupKnowledgeOff);
      }
      if (!regenerate) {
        store.addMessage(conversationId, { role: "user", content: displayMessage });
      }
    }
    // The SDK session id this run reports (init event); persisted on success so
    // the next turn can resume it.
    let runSessionId: string | null = null;
    // Accumulate the main-agent text as it streams, so the cancel/error paths can
    // persist the partial the user already watched (not an empty "(중지됨)" stub).
    let streamedText = "";
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
          cwd: workspaceDir,
          resumeSessionId,
          conversationHistory,
          viewerUserId: req.user!.id,
          viewerName: req.user!.displayName,
          viewerIsOwner,
          knowledgeMemory,
          // Elevated tool permissions for the owner OR a trusted user. The tool
          // gate denies everyone else, so auto-approving the elevated path is safe.
          elevated: viewerIsOwner || store.isTrustedFor(req.user!.id, avatar.id),
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
        },
        abortController,
      );

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
        store.addMessage(conversationId, { role: "assistant", content });
      }
      emitRunEvent(runId, "error", { error: detail });
    } finally {
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
