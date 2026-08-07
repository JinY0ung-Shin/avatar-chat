import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AppConfig } from "./types.js";

/**
 * Build the app's listening server: HTTPS when TLS_CERT_FILE and TLS_KEY_FILE
 * are both set, plain HTTP when both are absent. TLS terminates in the app
 * itself — no fronting proxy — so agent SSE streams never meet a proxy
 * read-timeout/buffering layer, and pages get a secure context (which is what
 * unlocks File System Access for the browser bridge's one-click update).
 *
 * A half-configured pair throws instead of falling back to HTTP: an operator
 * who set one path believes traffic is encrypted, and a silent downgrade would
 * ship that belief to every user. readFileSync's ENOENT is left to propagate
 * for the same reason — a missing cert mount should stop the boot loudly,
 * naming the path.
 */
export function createAppServer(
  app: http.RequestListener,
  config: Pick<AppConfig, "tlsCertFile" | "tlsKeyFile">,
): { server: http.Server | https.Server; protocol: "http" | "https" } {
  const { tlsCertFile, tlsKeyFile } = config;
  if (Boolean(tlsCertFile) !== Boolean(tlsKeyFile)) {
    throw new Error(
      "TLS_CERT_FILE and TLS_KEY_FILE must be set together — refusing to fall back to plain HTTP.",
    );
  }
  if (!tlsCertFile || !tlsKeyFile) {
    return { server: http.createServer(app), protocol: "http" };
  }
  return {
    server: https.createServer(
      { cert: fs.readFileSync(tlsCertFile), key: fs.readFileSync(tlsKeyFile) },
      app,
    ),
    protocol: "https",
  };
}
