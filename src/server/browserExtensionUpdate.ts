import crypto from "node:crypto";
import {
  BROWSER_EXTENSION_DIR,
  browserExtensionVersion,
  listBrowserExtensionFiles,
} from "./browserExtensionBundle.js";

/**
 * The browser-bridge self-update artifacts: a JSON payload of every bundled
 * file plus a detached RSA signature over its exact bytes. Each release
 * attaches both to GitHub; the extension's updater page fetches them from the
 * stable `releases/latest/download/` alias and installs ONLY after the
 * signature verifies against the public key pinned in its own manifest `key`
 * (the same key that fixes the extension id).
 *
 * Why sign at all when the repo is public: public means readable, not
 * authentic. The private key lives ONLY on the release machine — someone who
 * compromises the GitHub account (or a corporate TLS-interception proxy) can
 * publish bytes, but cannot make this extension accept them.
 *
 * NOTHING here runs on a server request path — the server never imports this
 * module; only the release-time script and tests do.
 */

export const UPDATE_PAYLOAD_ASSET = "noah-bridge-update.json";
export const UPDATE_SIGNATURE_ASSET = "noah-bridge-update.sig";

/**
 * The payload the updater consumes: `{ version, files: [{name, content}] }`,
 * generic (no origin stamping) — the updater merges each install's own
 * `externally_connectable.matches` back in at write time.
 */
export function buildUpdatePayload(dir: string = BROWSER_EXTENSION_DIR): Buffer {
  const version = browserExtensionVersion(dir);
  if (!version) {
    throw new Error(`No manifest version under ${dir} — refusing to build an update payload.`);
  }
  const files = listBrowserExtensionFiles(dir);
  return Buffer.from(`${JSON.stringify({ version, files }, null, 2)}\n`, "utf8");
}

/** RSASSA-PKCS1-v1_5 / SHA-256 over the exact payload bytes, base64. */
export function signUpdatePayload(payload: Buffer, privateKeyPem: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(
      `The signing key must be RSA (got ${key.asymmetricKeyType}); the extension verifies RSASSA-PKCS1-v1_5.`,
    );
  }
  return crypto.sign("sha256", payload, key).toString("base64");
}

/** The manifest `key` value (base64 SPKI) this private key corresponds to. */
export function manifestKeyFromPrivateKey(privateKeyPem: string): string {
  const publicKey = crypto
    .createPublicKey(crypto.createPrivateKey(privateKeyPem))
    .export({ type: "spki", format: "der" }) as Buffer;
  return publicKey.toString("base64");
}

/** The 32-char a-p extension id Chrome derives from a public key (SPKI DER). */
export function extensionIdFromPublicKey(spkiDer: Buffer): string {
  const hex = crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");
}
