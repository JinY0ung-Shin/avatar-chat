import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { createRateLimiter } from "../rateLimit.js";
import { decodeSttAudio, transcribeAudio } from "../stt.js";
import { apiError, type RouterDeps } from "./_shared.js";

// ---- Speech-to-text --------------------------------------------------
export function createSttRouter({ config, store }: RouterDeps): Router {
  const router = Router();

  // One mic click costs a 15MB upload plus an upstream GPU decode, so this is
  // keyed per authenticated USER, not per ip: on a shared corporate NAT an
  // ip-keyed bucket would let one talkative user throttle a whole office.
  // In-memory, single-process, bypassed under NODE_ENV=test (see rateLimit.ts).
  const sttLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    keyFn: (req) => (req as AuthenticatedRequest).user?.id ?? req.ip ?? "?",
    message: "요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.",
  });

  // requireAuth runs BEFORE the limiter so `keyFn` has a user id to key on.
  router.post("/api/stt", requireAuth(store), sttLimiter, async (req: AuthenticatedRequest, res) => {
    if (!config.sttUrl) {
      apiError(res, 503, "음성 인식이 아직 설정되지 않았어요.");
      return;
    }
    const decoded = decodeSttAudio(req.body?.audio);
    if ("error" in decoded) {
      apiError(
        res,
        400,
        decoded.error === "TOO_LARGE"
          ? "녹음이 너무 커요. 짧게 나눠서 시도해 주세요."
          : "지원하지 않는 오디오 형식이에요.",
      );
      return;
    }
    const result = await transcribeAudio(config, decoded.audio);
    if (!result.ok) {
      // The upstream detail (status, body, timeout) is server-side only: the user
      // gets one Korean line, the operator gets what to fix.
      logger.warn({ userId: req.user!.id, detail: result.detail }, "stt transcription failed");
      apiError(res, 502, "음성 인식 서비스에 연결할 수 없어요.");
      return;
    }
    res.json({ text: result.text });
  });

  return router;
}
