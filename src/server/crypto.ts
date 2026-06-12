import crypto from "node:crypto";

// At-rest encryption for reversible secrets, which — unlike passwords/session
// tokens — must be recovered in plaintext to replay into git auth or tool env.
// We use AES-256-GCM with a key derived from SESSION_SECRET via scrypt, so no
// extra key material has to be provisioned. The stored format is
// `v1:salt:iv:tag:ciphertext` (all base64url): the salt makes each ciphertext's
// key independent, and the GCM tag authenticates it (tamper/garbage decrypts
// fail loudly rather than yielding a bogus token).

const VERSION = "v1";
const KEY_LEN = 32; // AES-256
const SALT_LEN = 16;
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

function deriveKey(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, KEY_LEN);
}

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Encrypt a UTF-8 secret with a key derived from `secret`. Returns the stored token string. */
export function encryptSecret(plaintext: string, secret: string): string {
  if (!secret) {
    throw new Error("encryptSecret requires a non-empty key secret");
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, b64(salt), b64(iv), b64(tag), b64(ciphertext)].join(":");
}

/**
 * Decrypt a string produced by `encryptSecret` using the same `secret`. Returns
 * null on any failure (wrong format, wrong/changed key, tampering) so callers
 * can treat an undecryptable token as "no token" instead of crashing.
 */
export function decryptSecret(stored: string, secret: string): string | null {
  if (!stored || !secret) {
    return null;
  }
  const parts = stored.split(":");
  if (parts.length !== 5 || parts[0] !== VERSION) {
    return null;
  }
  try {
    const [, saltB64, ivB64, tagB64, dataB64] = parts;
    const salt = Buffer.from(saltB64, "base64url");
    const iv = Buffer.from(ivB64, "base64url");
    const tag = Buffer.from(tagB64, "base64url");
    const data = Buffer.from(dataB64, "base64url");
    if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== TAG_LEN) {
      return null;
    }
    const key = deriveKey(secret, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}
