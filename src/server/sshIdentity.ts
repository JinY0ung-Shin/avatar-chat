import { runPython } from "./pythonExec.js";

export interface GeneratedSshKeyPair {
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

function cleanComment(comment: string): string {
  return comment
    .trim()
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_.@-]/g, "-")
    .slice(0, 80);
}

function parseGenerated(stdout: string): GeneratedSshKeyPair {
  const parsed = JSON.parse(stdout) as Partial<GeneratedSshKeyPair>;
  if (
    typeof parsed.privateKey !== "string" ||
    !parsed.privateKey.includes("BEGIN OPENSSH PRIVATE KEY") ||
    typeof parsed.publicKey !== "string" ||
    !parsed.publicKey.startsWith("ssh-ed25519 ") ||
    typeof parsed.fingerprint !== "string" ||
    !parsed.fingerprint.startsWith("SHA256:")
  ) {
    throw new Error("INVALID_GENERATED_SSH_KEY");
  }
  return {
    privateKey: parsed.privateKey,
    publicKey: parsed.publicKey,
    fingerprint: parsed.fingerprint,
  };
}

/**
 * Generate an Ed25519 SSH keypair in OpenSSH format without shelling out to
 * ssh-keygen. The Docker image already carries python3-cryptography for SSH
 * host-key handling, and this keeps the private key inside the server process
 * path until it is encrypted into the user secret vault.
 */
export async function generateSshKeyPair(comment = "avatar-chat"): Promise<GeneratedSshKeyPair> {
  const script = [
    "import sys, json, base64, hashlib",
    "from cryptography.hazmat.primitives.asymmetric import ed25519",
    "from cryptography.hazmat.primitives import serialization",
    "comment = sys.argv[1]",
    "key = ed25519.Ed25519PrivateKey.generate()",
    "private_key = key.private_bytes(",
    "    serialization.Encoding.PEM,",
    "    serialization.PrivateFormat.OpenSSH,",
    "    serialization.NoEncryption(),",
    ").decode()",
    "public_blob = key.public_key().public_bytes(",
    "    serialization.Encoding.OpenSSH,",
    "    serialization.PublicFormat.OpenSSH,",
    ").decode()",
    "public_key = public_blob + ((\" \" + comment) if comment else \"\")",
    "raw = base64.b64decode(public_blob.split()[1])",
    "fingerprint = \"SHA256:\" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip(\"=\")",
    "print(json.dumps({\"privateKey\": private_key, \"publicKey\": public_key, \"fingerprint\": fingerprint}))",
  ].join("\n");
  const stdout = await runPython(script, [cleanComment(comment)], {
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  return parseGenerated(stdout);
}

export interface DerivedSshPublicKey {
  publicKey: string;
  fingerprint: string;
}

/**
 * Derive the OpenSSH public key (+ SHA256 fingerprint) from a stored private
 * key so the public half stays queryable even when the owner pasted their own
 * `SSH_PRIVATE_KEY` instead of generating one in-app. Accepts OpenSSH or PEM
 * private keys; returns null when the key can't be parsed (e.g. unsupported
 * format or passphrase-protected) so callers can treat it as "no public key"
 * rather than failing the secret save.
 */
export async function deriveSshPublicKey(
  privateKey: string,
  comment = "avatar-chat",
): Promise<DerivedSshPublicKey | null> {
  const script = [
    "import sys, json, base64, hashlib",
    "from cryptography.hazmat.primitives import serialization",
    "data = sys.argv[1].encode()",
    "comment = sys.argv[2] if len(sys.argv) > 2 else ''",
    "key = None",
    "try:",
    "    key = serialization.load_ssh_private_key(data, password=None)",
    "except Exception:",
    "    try:",
    "        key = serialization.load_pem_private_key(data, password=None)",
    "    except Exception:",
    "        print(json.dumps({\"error\": \"PARSE_FAILED\"}))",
    "        sys.exit(0)",
    "public_blob = key.public_key().public_bytes(",
    "    serialization.Encoding.OpenSSH,",
    "    serialization.PublicFormat.OpenSSH,",
    ").decode()",
    "public_key = public_blob + ((\" \" + comment) if comment else \"\")",
    "raw = base64.b64decode(public_blob.split()[1])",
    "fingerprint = \"SHA256:\" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip(\"=\")",
    "print(json.dumps({\"publicKey\": public_key, \"fingerprint\": fingerprint}))",
  ].join("\n");
  let stdout: string;
  try {
    stdout = await runPython(script, [privateKey, cleanComment(comment)], {
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
  } catch {
    return null;
  }
  let parsed: Partial<DerivedSshPublicKey> & { error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (
    parsed.error ||
    typeof parsed.publicKey !== "string" ||
    !parsed.publicKey.includes(" ") ||
    typeof parsed.fingerprint !== "string" ||
    !parsed.fingerprint.startsWith("SHA256:")
  ) {
    return null;
  }
  return { publicKey: parsed.publicKey, fingerprint: parsed.fingerprint };
}
