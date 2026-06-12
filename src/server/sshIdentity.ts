import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  const { stdout } = await execFileAsync("python3", ["-c", script, cleanComment(comment)], {
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  return parseGenerated(stdout);
}
