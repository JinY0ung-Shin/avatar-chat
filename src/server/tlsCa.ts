import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import type { AppConfig } from "./types.js";

interface CaLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

// `tls.setDefaultCACertificates`/`getCACertificates` landed in Node 22.15; the
// installed @types/node may predate them, so view `tls` through a widened type
// and feature-detect at runtime rather than hard-depending on the declaration.
const tlsApi = tls as typeof tls & {
  setDefaultCACertificates?: (certs: Array<string | Buffer>) => void;
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
};

/**
 * Trust a self-hosted / on-prem GitHub's internal CA from a SINGLE env var
 * (`GITHUB_CA_CERT`, a PEM file path), across the TLS stacks the app uses to
 * reach `githubHost`:
 *
 *  - the built-in `fetch` (undici), handled by APPENDING the cert to the
 *    process's default CA set at runtime (`tls.setDefaultCACertificates`).
 *    Appending (not replacing) keeps system roots + `NODE_EXTRA_CA_CERTS`, so
 *    public hosts like github.com still verify.
 *  - every `git` clone/push/seed (knowledge repo + plugins), which the app runs
 *    via `execFile` inheriting `process.env` — handled by exporting
 *    `GIT_SSL_CAINFO` (read by libcurl).
 *  - `mcp__repo__create_repo`, which is implemented with `gh repo create` and
 *    passes this same path as `SSL_CERT_FILE` in the `gh` child env.
 *
 * Best-effort: an unset var, an unreadable file, or an old Node without
 * `setDefaultCACertificates` is logged, not fatal.
 *
 * Caveat: `GIT_SSL_CAINFO` makes libcurl use this file as its ENTIRE CA bundle
 * (it replaces, not appends, for git), so the PEM should contain every CA git
 * needs — fine for an all-internal host; include public roots too if you also
 * clone public-host repos. An explicit operator-set `GIT_SSL_CAINFO` is kept.
 *
 * Returns true when a CA was applied. Call once at startup, before serving.
 */
export function applyCustomGithubCa(config: AppConfig, logger: CaLogger): boolean {
  const certPath = config.githubCaCert;
  if (!certPath) {
    return false;
  }
  const absPath = path.resolve(certPath);
  let pem: string;
  try {
    pem = fs.readFileSync(absPath, "utf8");
  } catch (error) {
    logger.warn(
      { certPath: absPath, error: error instanceof Error ? error.message : String(error) },
      "GITHUB_CA_CERT set but the file could not be read; custom CA not applied",
    );
    return false;
  }

  // fetch (undici): append to the default set so existing roots stay trusted.
  if (typeof tlsApi.setDefaultCACertificates === "function") {
    try {
      const defaults =
        typeof tlsApi.getCACertificates === "function"
          ? tlsApi.getCACertificates("default")
          : [...tls.rootCertificates];
      tlsApi.setDefaultCACertificates([...defaults, pem]);
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "failed to register GITHUB_CA_CERT for the fetch (undici) TLS stack",
      );
    }
  } else {
    logger.warn(
      {},
      "tls.setDefaultCACertificates unavailable (Node < 22.15); fetch() to the GitHub host may still need NODE_EXTRA_CA_CERTS",
    );
  }

  // git (libcurl): inherited by every `git` execFile child. Don't clobber an
  // explicit operator-provided value.
  if (!process.env.GIT_SSL_CAINFO) {
    process.env.GIT_SSL_CAINFO = absPath;
  }

  logger.info({ certPath: absPath, gitSslCaInfo: process.env.GIT_SSL_CAINFO }, "applied GITHUB_CA_CERT");
  return true;
}
