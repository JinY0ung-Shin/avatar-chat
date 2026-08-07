import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import {
  BROWSER_EXTENSION_MIN_COMPATIBLE,
  browserExtensionId,
  browserExtensionOrigins,
  browserExtensionVersion,
  buildBrowserExtensionZip,
  listBrowserExtensionFiles,
  matchPatternForOrigin,
} from "../browserExtensionBundle.js";
import { apiError, type RouterDeps } from "./_shared.js";

// ---- Browser-bridge extension ------------------------------------------------
// Install/update surface for the browser bridge. Auth-only, NOT admin-gated:
// browser control is a general capability — any user may drive their OWN
// browser from a chat with their OWN avatar. The run-time gate lives in
// claudeAgent/browserTools (owner-of-avatar, interactive, never group-agent),
// and a group's tool policy can still switch the `browser` group off entirely.

/**
 * The Noah address THIS request came in on, as an extension match pattern.
 * `x-forwarded-proto` is honoured because the deployment sits behind a reverse
 * proxy, where `req.protocol` reports the internal hop as http and would stamp
 * the bundle with an origin the browser never uses.
 */
function requestOriginPatterns(req: AuthenticatedRequest): string[] {
  const host = req.get("x-forwarded-host") || req.get("host");
  if (!host) return [];
  const proto = (req.get("x-forwarded-proto") || req.protocol || "http").split(",")[0].trim();
  const pattern = matchPatternForOrigin(`${proto}://${host}`);
  return pattern ? [pattern] : [];
}

/** What the downloaded bundle will actually accept: shipped list + this address. */
function effectiveExtensionOrigins(req: AuthenticatedRequest): string[] {
  const shipped = browserExtensionOrigins();
  const merged = [...shipped];
  for (const pattern of requestOriginPatterns(req)) {
    if (!merged.includes(pattern)) merged.push(pattern);
  }
  return merged;
}

export function createBrowserExtensionRouter(deps: RouterDeps): Router {
  const { config, store } = deps;
  const router = Router();

  // The install package's metadata plus the id it will register under.
  router.get("/api/browser-extension", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({
      extensionId: browserExtensionId(),
      // The pinned manifest `key` makes the id identical on every unpacked
      // install, so the client's bridge target needs no per-user configuration.
      origins: effectiveExtensionOrigins(req),
      // The bundled build's version: what the chat composer badge compares the
      // INSTALLED extension against to say "재다운로드 필요".
      version: browserExtensionVersion(),
      // Installs at or above this floor stay green even when they differ from
      // `version` — the badge only demands an update on a real contract break.
      minCompatibleVersion: BROWSER_EXTENSION_MIN_COMPATIBLE,
      // Corp-policy install-location notice, opt-in via
      // BROWSER_BRIDGE_MULTIMEDIA_NOTICE (default hidden).
      multimediaNotice: config.browserBridgeMultimediaNotice,
    });
  });

  // The bundle as individual files for the page-driven one-click update: the
  // settings page writes these into the user's unpacked-extension folder via
  // File System Access, then asks the extension to reload itself — no zip, no
  // manual folder swap. Stamped with the request origin like the zip.
  router.get(
    "/api/browser-extension.files",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      try {
        res.json({
          version: browserExtensionVersion(),
          files: listBrowserExtensionFiles(undefined, requestOriginPatterns(req)),
        });
      } catch (error) {
        logger.error({ err: error }, "browser extension file listing failed");
        apiError(res, 500, "확장 프로그램 파일을 준비하지 못했습니다. 서버 로그를 확인하세요.");
      }
    },
  );

  router.get(
    "/api/browser-extension.zip",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      let zip: Buffer;
      try {
        zip = buildBrowserExtensionZip(undefined, requestOriginPatterns(req));
      } catch (error) {
        logger.error({ err: error }, "browser extension bundle failed");
        apiError(res, 500, "확장 프로그램 패키지를 만들지 못했습니다. 서버 로그를 확인하세요.");
        return;
      }
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", 'attachment; filename="noah-browser-bridge.zip"');
      res.setHeader("Content-Length", String(zip.length));
      res.end(zip);
    },
  );

  return router;
}
