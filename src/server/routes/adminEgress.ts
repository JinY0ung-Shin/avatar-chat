import http from "node:http";
import https from "node:https";
import type { Response, Router } from "express";
import { requireAdmin, requireAuth, sessionTokenFromRequest, type AuthenticatedRequest } from "../auth.js";
import { normalizeEgressDomains } from "../../shared/egressDomains.js";
import { apiError, type RouterDeps } from "./_shared.js";

/** Deliberately direct: management is not sent through the filtering proxy.
 * No global dispatcher, redirects, agent credentials or caller-selected URL.
 */
function controllerRequest(base: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/policy", base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      reject(new Error("Invalid controller URL"));
      return;
    }
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: encoded === undefined ? "GET" : "PUT",
      headers: {
        Cookie: `ac_session=${encodeURIComponent(token)}`,
        ...(encoded === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) }),
      },
      // Covers authorization callback + validation + restart/rollback.
      signal: AbortSignal.timeout(35_000),
    }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        data += chunk;
        if (data.length > 200_000) request.destroy(new Error("Oversized controller response"));
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 502, body: JSON.parse(data) });
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(encoded);
  });
}

/** The controller re-verifies the forwarded session against Noah's own admin
 * callback, so its 401/403 means THAT callback failed (misconfigured
 * NOAH_EGRESS_AUTH_URL, unreachable Noah) — never that this browser's session is
 * bad, which requireAuth/requireAdmin already established. Passing the 401
 * through would make the client treat it as session expiry and log the admin
 * out, so it becomes a 502 naming the real cause. Every other status (400/409
 * validation and conflict, 5xx) is relayed with the controller's own message.
 */
function relayControllerResponse(res: Response, response: { status: number; body: any }): void {
  if (response.status === 401 || response.status === 403) {
    apiError(res, 502, "정책 서비스가 관리자 세션을 확인하지 못했습니다. 프록시의 NOAH_EGRESS_AUTH_URL 설정과 Noah 연결 상태를 확인하세요.");
    return;
  }
  res.status(response.status).json({ ...response.body, configured: true });
}

export function registerAdminEgressRoutes(router: Router, deps: RouterDeps): void {
  const { config, store, auditAs } = deps;
  // The controller independently verifies this browser's session and CURRENT
  // admin role on every request. This endpoint neither reads nor applies policy.
  router.get("/api/admin/egress/authorize", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ actorId: req.user!.id });
  });

  router.get("/api/admin/egress", requireAuth(store), requireAdmin, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!config.egressControlUrl) {
      res.json({ configured: false, proxyReady: false, domains: [], revision: null, appliedAt: null, appliedBy: null });
      return;
    }
    try {
      const response = await controllerRequest(config.egressControlUrl, sessionTokenFromRequest(req)!);
      relayControllerResponse(res, response);
    } catch {
      apiError(res, 503, "차단 정책 서비스에 연결할 수 없습니다. 배포 상태를 확인하고 다시 불러오세요.");
    }
  });

  router.put("/api/admin/egress", requireAuth(store), requireAdmin, async (req: AuthenticatedRequest, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Custom non-simple header prevents cross-origin form/credential requests.
    if (req.get("X-Noah-Egress-Admin") !== "1" || !req.is("application/json")) {
      apiError(res, 400, "관리자 화면에서 JSON 형식으로 요청해 주세요.");
      return;
    }
    if (!config.egressControlUrl) {
      apiError(res, 503, "외부 통신 차단 서비스가 설치되지 않았습니다.");
      return;
    }
    let domains: string[];
    try {
      domains = normalizeEgressDomains(req.body?.domains);
      if (typeof req.body?.revision !== "string" || !/^[a-f0-9]{32}$/.test(req.body.revision)) {
        throw new Error("최신 목록을 불러온 후 다시 적용하세요.");
      }
    } catch (error) {
      apiError(res, 400, (error as Error).message);
      return;
    }
    try {
      const response = await controllerRequest(config.egressControlUrl, sessionTokenFromRequest(req)!, {
        domains, revision: req.body.revision,
      });
      if (response.status === 200) {
        auditAs(req, "set_egress_policy", `domains=${domains.length}, revision=${response.body.revision}`);
      } else {
        const cause = response.status === 401 || response.status === 403 ? "; controller could not verify the admin session via its callback" : "";
        auditAs(req, "egress_policy_failed", `status=${response.status}${cause}`, "error");
      }
      relayControllerResponse(res, response);
    } catch {
      auditAs(req, "egress_policy_failed", "controller unavailable; outcome unconfirmed", "error");
      apiError(res, 503, "적용 결과를 확인하지 못했습니다. 현재 목록을 다시 불러와 상태를 확인하세요.");
    }
  });
}
