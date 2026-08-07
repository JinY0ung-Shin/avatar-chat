import crypto from "node:crypto";

/**
 * Signing-key helpers for the browser-bridge policy install channel: the
 * manifest `key` (public half) and the extension id both derive from the ONE
 * RSA key held on the release machine, and these are the derivations the build
 * script and tests rely on to keep manifest, client default id, and admin
 * policy in agreement.
 *
 * NOTHING here runs on a server request path — the server never imports this
 * module; only the release-time script and tests do. A server holding the
 * signing key would turn a server compromise into fleet-wide browser control.
 */

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
