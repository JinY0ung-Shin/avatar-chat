import type {
  AgentRequest,
  AgentResponse,
  AgentUsage,
  ExternalAgentConfig,
} from "../types.js";
import type { AgentEvents } from "./events.js";
import { isRecord } from "./agentUtils.js";
import {
  createLoopState,
  createTextFoldState,
  dispatchSdkMessage,
  finalizeTurnUsage,
  foldPendingText,
  resultErrorMessage,
} from "./sdkMessageHandlers.js";

const MAX_SSE_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_TEXT = 1_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;
export const EXTERNAL_SDK_MESSAGE_SCHEMA = "claude-agent-sdk-message-v1";
const MAX_PROBE_BODY_BYTES = 1024 * 1024;
// The catalog feeds an admin-UI picker; cap what an external server can inject.
const MAX_PROBE_MODEL_IDS = 50;
const MAX_PROBE_MODEL_ID_LENGTH = 200;

export interface ExternalGatewayProbeResult {
  ok: true;
  latencyMs: number;
  modelsCount: number;
  modelAvailable: boolean | null;
  /** Gateway-advertised Claude model ids (deduped, size-capped) for the admin model picker. */
  models: string[];
}

type ExternalTimeoutKind = "connect" | "idle" | "total";

const EXTERNAL_TIMEOUT_MESSAGE: Record<ExternalTimeoutKind, string> = {
  connect: "외부 에이전트 연결 시간이 초과되었습니다.",
  idle: "외부 에이전트 응답 대기 시간이 초과되었습니다.",
  total: "외부 에이전트 최대 실행 시간을 초과했습니다.",
};

interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(block: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length && event === "message") return null;
  return { event, data: data.join("\n") };
}

async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  // Abort must interrupt a PENDING read deterministically. Relying on undici to
  // reject the in-flight `reader.read()` when the request signal aborts is a
  // race it sometimes loses (observed as the idle/total deadline firing yet the
  // run hanging forever on a quiet socket), so the read is raced against the
  // signal explicitly and the loop rejects itself with the abort reason — the
  // caller's catch then maps it through `timeoutKind` exactly as before.
  let onAbort: (() => void) | undefined;
  const abortedForever: Promise<never> | undefined = signal
    ? new Promise<never>((_, reject) => {
        const rejectWithReason = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error(String(signal.reason ?? "aborted")),
          );
        if (signal.aborted) {
          rejectWithReason();
          return;
        }
        onAbort = rejectWithReason;
        signal.addEventListener("abort", rejectWithReason, { once: true });
      })
    : undefined;
  // Never raced (stream ends first) → this promise's rejection is unobserved;
  // pre-attach a no-op handler so it can't surface as an unhandled rejection.
  abortedForever?.catch(() => undefined);
  try {
    while (true) {
      const { done, value } = abortedForever
        ? await Promise.race([reader.read(), abortedForever])
        : await reader.read();
      if (done) {
        finished = true;
        buffer += decoder.decode();
      } else {
        if (value.byteLength > 0) onActivity?.();
        buffer += decoder.decode(value, { stream: true });
      }
      // Gateway output is UTF-8 SSE. Normalizing CRLF keeps boundary detection
      // simple while preserving newlines inside multi-line data fields.
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        if (Buffer.byteLength(block, "utf8") > MAX_SSE_FRAME_BYTES) {
          throw new Error("외부 에이전트 스트림 이벤트가 허용 크기를 초과했습니다.");
        }
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(block);
        if (frame) yield frame;
        boundary = buffer.indexOf("\n\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_FRAME_BYTES) {
        throw new Error("외부 에이전트 스트림 이벤트가 허용 크기를 초과했습니다.");
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame) yield frame;
    }
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function decodeJson(data: string, event: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new Error(`외부 에이전트의 ${event} 이벤트가 올바른 JSON이 아닙니다.`);
  }
}

/**
 * Korean-lead an upstream gateway message. The detail is kept for diagnosis but
 * never becomes the whole user-facing text — upstream sends English.
 */
function upstreamFailure(text: string): string {
  const detail = text.trim().slice(0, MAX_ERROR_TEXT);
  return detail
    ? `외부 에이전트 실행에 실패했습니다: ${detail}`
    : "외부 에이전트 실행에 실패했습니다.";
}

function externalError(data: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    return upstreamFailure(data);
  }
  if (typeof decoded === "string") return upstreamFailure(decoded);
  if (!isRecord(decoded)) return upstreamFailure("");
  const nested = isRecord(decoded.error) ? decoded.error : undefined;
  const message =
    (typeof decoded.error === "string" && decoded.error) ||
    (typeof decoded.message === "string" && decoded.message) ||
    (typeof nested?.message === "string" && nested.message) ||
    "";
  return upstreamFailure(message);
}

function gatewayModelsUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const suffix = "/v1/agents/messages";
  if (!url.pathname.endsWith(suffix)) {
    throw new Error("외부 에이전트 endpoint가 /v1/agents/messages 형식이 아닙니다.");
  }
  url.pathname = `${url.pathname.slice(0, -suffix.length)}/v1/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function limitedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROBE_BODY_BYTES) {
    throw new Error("Gateway 모델 응답이 허용 크기를 초과했습니다.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROBE_BODY_BYTES) {
        throw new Error("Gateway 모델 응답이 허용 크기를 초과했습니다.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Side-effect-free gateway/auth check. It intentionally calls the authenticated
 * model catalog instead of running an agent turn, because the real stateless
 * endpoint may execute tools. A successful result verifies reachability and the
 * bearer credential; normal chat still validates the SSE contract end-to-end.
 */
export async function probeExternalAgentGateway(
  external: ExternalAgentConfig,
  timeoutMs = 5_000,
): Promise<ExternalGatewayProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Gateway 연결 확인 시간이 초과되었습니다.")),
    timeoutMs,
  );
  const started = Date.now();
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (external.apiKey) headers.Authorization = `Bearer ${external.apiKey}`;
    const response = await fetch(gatewayModelsUrl(external.endpoint), {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Gateway 연결 확인에 실패했습니다 (HTTP ${response.status}).`);
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Gateway가 JSON 모델 목록을 반환하지 않았습니다.");
    }
    const text = await limitedResponseText(response);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new Error("Gateway 모델 목록이 올바른 JSON이 아닙니다.");
    }
    if (!isRecord(decoded) || !Array.isArray(decoded.data)) {
      throw new Error("Gateway 모델 목록 형식이 올바르지 않습니다.");
    }
    const modelIds = decoded.data
      .filter(isRecord)
      .filter((item) => item.backend === "claude")
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string");
    if (!modelIds.length) {
      throw new Error("Gateway에서 사용 가능한 Claude 모델을 찾지 못했습니다.");
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      modelsCount: modelIds.length,
      modelAvailable: external.model ? modelIds.includes(external.model) : null,
      models: [...new Set(modelIds)]
        .filter((id) => id.length <= MAX_PROBE_MODEL_ID_LENGTH)
        .slice(0, MAX_PROBE_MODEL_IDS),
    };
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Invoke a server-configured external `/v1/agents/messages` endpoint. The
 * gateway is conversation-stateless: Noah sends the complete stored text
 * transcript plus the current turn on every request.
 */
export async function runExternalAgent(
  request: Pick<AgentRequest, "message" | "conversationHistory">,
  external: ExternalAgentConfig,
  events: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (external.apiKey) {
    headers.Authorization = `Bearer ${external.apiKey}`;
  }
  const messages = [
    ...(request.conversationHistory ?? []).map(({ role, content }) => ({
      role,
      content,
    })),
    { role: "user" as const, content: request.message },
  ];

  const upstreamController = new AbortController();
  let timeoutKind: ExternalTimeoutKind | null = null;
  let connectTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  const connectTimeoutMs =
    external.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = external.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = external.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  const abortForTimeout = (kind: ExternalTimeoutKind): void => {
    if (upstreamController.signal.aborted) return;
    timeoutKind = kind;
    upstreamController.abort(new Error(EXTERNAL_TIMEOUT_MESSAGE[kind]));
  };
  const armTimer = (
    current: NodeJS.Timeout | undefined,
    delayMs: number,
    kind: ExternalTimeoutKind,
  ): NodeJS.Timeout => {
    if (current) clearTimeout(current);
    const timer = setTimeout(() => abortForTimeout(kind), delayMs);
    timer.unref();
    return timer;
  };
  const forwardAbort = (): void => {
    if (!upstreamController.signal.aborted) {
      upstreamController.abort(abortController?.signal.reason);
    }
  };
  if (abortController?.signal.aborted) {
    forwardAbort();
  } else {
    abortController?.signal.addEventListener("abort", forwardAbort, {
      once: true,
    });
  }

  events.onStatus?.("외부 에이전트에 연결 중…");
  connectTimer = armTimer(undefined, connectTimeoutMs, "connect");
  totalTimer = armTimer(undefined, totalTimeoutMs, "total");

  try {
    const response = await fetch(external.endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal: upstreamController.signal,
      body: JSON.stringify({
        agent: external.agent || "claude",
        ...(external.model ? { model: external.model } : {}),
        ...(external.system || external.persona
          ? { system: external.system || external.persona }
          : {}),
        messages,
        stream: true,
      }),
    });
    clearTimeout(connectTimer);
    connectTimer = undefined;
    if (!response.ok) {
      // Do not surface the upstream body: it may include implementation details.
      throw new Error(
        `외부 에이전트 요청에 실패했습니다 (HTTP ${response.status}).`,
      );
    }
    if (!response.body) {
      throw new Error("외부 에이전트가 빈 스트림을 반환했습니다.");
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("외부 에이전트가 SSE 스트림이 아닌 응답을 반환했습니다.");
    }

    // An external SDK init envelope can contain a session_id, but this endpoint is
    // deliberately stateless. Suppress onSessionId so chat.ts never persists it as
    // a resumable local SDK session. All other existing Noah event handling is shared
    // — the spread carries the host's onTextFold through, so interim narration folds
    // into the reasoning view here exactly as it does on a local run.
    const externalEvents: AgentEvents = { ...events, onSessionId: undefined };
    const loopState = createLoopState();
    const assistantChunks: string[] = [];
    const deltaChunks: string[] = [];
    const textFold = createTextFoldState();
    let resultText = "";
    let resultErrorSubtype = "";
    let runUsage: AgentUsage | undefined;
    let contextTokens: number | undefined;
    let sawStart = false;
    let sawStop = false;
    const noteActivity = (): void => {
      idleTimer = armTimer(idleTimer, idleTimeoutMs, "idle");
    };
    noteActivity();

    for await (const frame of readSseFrames(
      response.body,
      noteActivity,
      upstreamController.signal,
    )) {
      if (frame.event === "message_start") {
        const start = decodeJson(frame.data, frame.event);
        const schema = isRecord(start) ? start.schema : undefined;
        if (schema !== EXTERNAL_SDK_MESSAGE_SCHEMA) {
          throw new Error(
            typeof schema === "string"
              ? `지원하지 않는 외부 에이전트 이벤트 스키마입니다: ${schema.slice(0, 120)}`
              : "외부 에이전트 스트림에 이벤트 스키마가 없습니다.",
          );
        }
        sawStart = true;
        events.onStatus?.("응답 생성 중…");
        continue;
      }
      if (frame.event === "message_stop") {
        if (!sawStart) {
          throw new Error(
            "외부 에이전트 스트림에 message_start 이벤트가 없습니다.",
          );
        }
        sawStop = true;
        break;
      }
      if (frame.event === "error") {
        throw new Error(externalError(frame.data));
      }
      if (frame.event !== "sdk_message") {
        continue;
      }
      if (!sawStart) {
        throw new Error(
          "외부 에이전트가 message_start 전에 SDK 이벤트를 보냈습니다.",
        );
      }
      const decoded = decodeJson(frame.data, frame.event);
      if (!isRecord(decoded)) {
        throw new Error("외부 에이전트의 sdk_message 이벤트가 객체가 아닙니다.");
      }
      if (
        decoded.type === "error" ||
        (decoded.type !== "result" && decoded.is_error === true)
      ) {
        const message =
          (typeof decoded.error_message === "string" &&
            decoded.error_message) ||
          (typeof decoded.message === "string" && decoded.message) ||
          "";
        throw new Error(upstreamFailure(message));
      }
      const dispatched = dispatchSdkMessage(decoded, externalEvents, loopState);
      if (dispatched.delta) {
        // First delta of a NEW text block → the narration so far is superseded
        // and demotes to the reasoning view (see foldPendingText).
        foldPendingText(textFold, assistantChunks, deltaChunks, externalEvents, false);
        deltaChunks.push(dispatched.delta);
      }
      if (dispatched.assistantText) {
        assistantChunks.push(dispatched.assistantText);
      }
      if (dispatched.contextTokens !== undefined) {
        contextTokens = dispatched.contextTokens;
      }
      if (dispatched.resultText) resultText = dispatched.resultText;
      if (dispatched.errorSubtype) resultErrorSubtype = dispatched.errorSubtype;
      if (dispatched.usage) runUsage = dispatched.usage;
    }

    if (!sawStart) {
      throw new Error("외부 에이전트 스트림에 message_start 이벤트가 없습니다.");
    }
    if (!sawStop) {
      throw new Error(
        sawStart
          ? "외부 에이전트 스트림이 완료 이벤트 없이 종료되었습니다."
          : "외부 에이전트 스트림 형식이 올바르지 않습니다.",
      );
    }
    if (runUsage) runUsage = finalizeTurnUsage(runUsage, contextTokens);

    // Fold everything but the last block (a gateway that streams no text deltas
    // never hit the trigger above), so the answer is the LAST text block and the
    // narration before it rides `response.thinking` instead.
    foldPendingText(textFold, assistantChunks, deltaChunks, externalEvents, true);
    const partialText =
      assistantChunks.slice(textFold.chunkIndex).join("\n\n").trim() ||
      deltaChunks.slice(textFold.deltaIndex).join("").trim();
    const text =
      partialText ||
      resultText ||
      (resultErrorSubtype
        ? resultErrorMessage(resultErrorSubtype)
        : "외부 에이전트 응답이 비어 있습니다.");
    return {
      kind: "text",
      runtime: "external",
      summary: "외부 에이전트 실행이 완료되었습니다.",
      text,
      ...(runUsage ? { usage: runUsage } : {}),
    };
  } catch (error) {
    if (timeoutKind) {
      throw new Error(EXTERNAL_TIMEOUT_MESSAGE[timeoutKind], { cause: error });
    }
    throw error;
  } finally {
    if (connectTimer) clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    abortController?.signal.removeEventListener("abort", forwardAbort);
  }
}
