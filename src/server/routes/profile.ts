import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { listSkillsInRoots } from "../plugins.js";
import { normalizeHashtags } from "../store.js";
import type { AvatarVisibility } from "../types.js";
import {
  apiError,
  avatarDir,
  isAvatarVisibility,
  resolveAvatarSkillSources,
  runHeadlessAvatarPrompt,
  safeString,
  AVATAR_MIME_EXT,
  EXT_MIME,
  MAX_AVATAR_BYTES,
  type RouterDeps,
} from "./_shared.js";

// ---- Profile ---------------------------------------------------------
export function createProfileRouter({ config, store }: RouterDeps): Router {
  const router = Router();

  router.patch("/api/me", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const patch: {
      displayName?: string;
      alias?: string;
      bio?: string;
      persona?: string;
      intro?: string;
      hashtags?: string[];
      visibility?: AvatarVisibility;
    } = {};
    if (typeof req.body?.displayName === "string") patch.displayName = req.body.displayName;
    if (typeof req.body?.alias === "string") patch.alias = req.body.alias;
    if (typeof req.body?.bio === "string") patch.bio = req.body.bio;
    if (typeof req.body?.persona === "string") patch.persona = req.body.persona;
    if (typeof req.body?.intro === "string") patch.intro = req.body.intro;
    // Accept an array of tag strings; updateProfile normalizes/caps it.
    if (Array.isArray(req.body?.hashtags)) {
      patch.hashtags = req.body.hashtags.filter((t: unknown): t is string => typeof t === "string");
    }
    if (isAvatarVisibility(req.body?.visibility)) patch.visibility = req.body.visibility;
    const user = store.updateProfile(req.user!.id, patch);
    res.json({ user });
  });

  // Typeahead for the group member-add picker: match by username OR display name.
  // Excludes self. Used by the group management UIs (managing group membership is
  // how trust/elevation is granted — see Store.isTrustedFor).
  router.get("/api/me/users/search", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const q = safeString(req.query?.q);
    res.json({ users: q ? store.searchUsers(q, req.user!.id) : [] });
  });

  // Generate a first-person self-introduction for the owner's avatar. The
  // avatar inspects its own persona + skills and writes a short blurb the owner
  // then reviews/edits before saving (this endpoint does NOT persist it). Runs
  // headless and read-only, like a routine — no human is mid-conversation.
  router.post("/api/me/intro/generate", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const avatar = store.resolveChatAvatar(req.user!.id, req.user!.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }

    // The local runtime loads no plugins and can't introspect skills; return a
    // deterministic placeholder so the feature still works offline/in tests.
    if (config.agentRuntime === "local") {
      const name = avatar.alias || avatar.displayName;
      res.json({ intro: `안녕하세요, ${name}입니다. 무엇이든 편하게 물어보세요.` });
      return;
    }

    // Resolve plugin roots and their skills exactly like the skills endpoint,
    // so the intro reflects what the avatar can actually do.
    const { sourced, enabledPlugins, pluginRoots } = await resolveAvatarSkillSources(
      store,
      avatar,
      config,
      true,
    );
    const skills = await listSkillsInRoots(sourced);

    // Describe the avatar's equipment so it can ground the intro in reality
    // rather than inventing capabilities.
    const skillLines = skills.length
      ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n")
      : "(no skills registered)";
    const pluginLines = enabledPlugins.length
      ? enabledPlugins.map((p) => `- ${p.label || p.repo}`).join("\n")
      : "(no plugins connected)";
    const personaLine = avatar.persona?.trim()
      ? `\n\nReference persona/instructions:\n${avatar.persona.trim()}`
      : "";
    const message =
      "You are writing a short self-introduction. It is the intro a conversation partner (a colleague) will read before they start talking to you.\n\n" +
      "Based on the information below, write the introduction in the first person, centered on 'what you can help with'. " +
      "Ground concrete capabilities in the skills and tools you have, but do not exaggerate.\n\n" +
      "**Write the introduction in Korean.** Output in Markdown. Start with a short one- or two-sentence greeting paragraph, then " +
      "organize your main capabilities as a bullet list (`- `). Write each bullet as a single line about 'what you can help with', " +
      "and use bold (`**`) to emphasize key keywords where helpful. Do not use Markdown headings (`#`), code blocks, or wrapping quotes — " +
      "output only the introduction body.\n\n" +
      `Available skills:\n${skillLines}\n\nConnected plugins:\n${pluginLines}${personaLine}`;

    const result = await runHeadlessAvatarPrompt(
      store,
      config,
      avatar,
      "intro",
      message,
      pluginRoots,
      "intro generation failed",
      req.user!.id,
    );
    if (!result.ok) {
      apiError(res, 502, "소개글 생성 중 오류가 발생했습니다.");
      return;
    }
    const intro = result.raw.trim();
    if (!intro) {
      apiError(res, 502, "소개글을 생성하지 못했습니다. 다시 시도해 주세요.");
      return;
    }
    res.json({ intro });
  });

  // Generate capability hashtags (역량 해시태그) for the owner's avatar, mirroring
  // intro/generate: the avatar inspects its persona + skills and proposes a short
  // set of searchable tags the owner reviews/edits before saving (NOT persisted
  // here). Runs headless + read-only, like a routine.
  router.post("/api/me/hashtags/generate", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const avatar = store.resolveChatAvatar(req.user!.id, req.user!.id);
    if (!avatar) {
      apiError(res, 404, "아바타를 찾을 수 없습니다.");
      return;
    }

    // The local runtime can't introspect skills; return a deterministic
    // placeholder so the feature still works offline/in tests.
    if (config.agentRuntime === "local") {
      res.json({ hashtags: ["업무지원", "질문답변"] });
      return;
    }

    // Resolve plugin roots + skills exactly like intro/generate, so the tags
    // reflect what the avatar can actually do.
    const { sourced, enabledPlugins, pluginRoots } = await resolveAvatarSkillSources(
      store,
      avatar,
      config,
      true,
    );
    const skills = await listSkillsInRoots(sourced);

    const skillLines = skills.length
      ? skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n")
      : "(no skills registered)";
    const pluginLines = enabledPlugins.length
      ? enabledPlugins.map((p) => `- ${p.label || p.repo}`).join("\n")
      : "(no plugins connected)";
    const personaLine = avatar.persona?.trim()
      ? `\n\nReference persona/instructions:\n${avatar.persona.trim()}`
      : "";
    const message =
      "You are creating 'capability hashtags' for searching and categorizing yourself. These tags help colleagues find what you can do by keyword on the discovery screen.\n\n" +
      "Based on the information below, create 5–12 hashtags representing the core capabilities, domains, and tools you can actually help with. " +
      "Ground them in the skills, plugins, and persona you have, and do not invent capabilities you lack.\n\n" +
      "Output format: output only the hashtags on a single line separated by spaces. Each tag starts with `#` and contains no spaces (join multiple words together or connect them with hyphens). " +
      "Default to Korean, but widely used technical terms may be written in English. Output only the hashtag line — no explanatory sentences, lists, or code blocks.\n" +
      "Example: #코드리뷰 #파이썬 #데이터분석 #기술문서작성\n\n" +
      `Available skills:\n${skillLines}\n\nConnected plugins:\n${pluginLines}${personaLine}`;

    const result = await runHeadlessAvatarPrompt(
      store,
      config,
      avatar,
      "hashtags",
      message,
      pluginRoots,
      "hashtag generation failed",
      req.user!.id,
    );
    if (!result.ok) {
      apiError(res, 502, "해시태그 생성 중 오류가 발생했습니다.");
      return;
    }
    // Prefer explicit "#tag" tokens; fall back to splitting the whole reply.
    const raw = result.raw;
    const tagged = [...raw.matchAll(/#([^\s#,，、]+)/g)].map((m) => m[1]);
    const hashtags = normalizeHashtags(tagged.length ? tagged : raw);
    if (hashtags.length === 0) {
      apiError(res, 502, "해시태그를 생성하지 못했습니다. 다시 시도해 주세요.");
      return;
    }
    res.json({ hashtags });
  });

  router.put("/api/me/avatar-image", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const image = typeof req.body?.image === "string" ? req.body.image : "";
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image);
    if (!match) {
      apiError(res, 400, "지원하는 이미지 형식은 png/jpeg/webp 입니다.");
      return;
    }
    const mime = match[1];
    const ext = AVATAR_MIME_EXT[mime];
    let buffer: Buffer;
    try {
      buffer = Buffer.from(match[2], "base64");
    } catch {
      apiError(res, 400, "이미지를 디코드할 수 없습니다.");
      return;
    }
    if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
      apiError(res, 400, "이미지 크기는 2MB 이하여야 합니다.");
      return;
    }
    const dir = avatarDir(config);
    fs.mkdirSync(dir, { recursive: true });
    // Remove any prior extension so stale files don't linger.
    for (const candidate of ["png", "jpg", "webp"]) {
      const prior = path.join(dir, `${req.user!.id}.${candidate}`);
      if (candidate !== ext && fs.existsSync(prior)) {
        fs.rmSync(prior, { force: true });
      }
    }
    fs.writeFileSync(path.join(dir, `${req.user!.id}.${ext}`), buffer);
    store.setAvatarExt(req.user!.id, ext);
    res.json({ ok: true, hasImage: true });
  });

  router.delete("/api/me/avatar-image", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const ext = store.getAvatarExt(req.user!.id);
    if (ext) {
      const file = path.join(avatarDir(config), `${req.user!.id}.${ext}`);
      fs.rmSync(file, { force: true });
    }
    store.setAvatarExt(req.user!.id, null);
    res.json({ ok: true, hasImage: false });
  });

  router.get("/api/users/:id/avatar-image", (req, res) => {
    const ext = store.getAvatarExt(req.params.id);
    if (!ext) {
      res.status(404).json({ error: "No avatar image" });
      return;
    }
    const file = path.join(avatarDir(config), `${req.params.id}.${ext}`);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "No avatar image" });
      return;
    }
    res.type(EXT_MIME[ext] ?? "application/octet-stream");
    res.sendFile(file);
  });

  return router;
}
