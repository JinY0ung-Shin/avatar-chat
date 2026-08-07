// Build the browser-bridge self-update assets: noah-bridge-update.json (every
// bundled file + version) and noah-bridge-update.sig (detached RSA signature).
// Release-machine only — the signing key never touches the server or the repo.
//
//   BROWSER_EXTENSION_KEY_FILE=~/.noah/browser-bridge-key.pem \
//     npx tsx scripts/build-browser-extension-update.ts [--out dist/extension]
//
// The extension's updater page fetches both from the stable alias
//   https://github.com/<repo>/releases/latest/download/<asset>
// so once the channel is live, EVERY release must attach both assets.
//
// No key yet? Generate one and KEEP THE .pem FOREVER (the extension id and the
// pinned verify key derive from it; losing it orphans every install):
//   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
//     -out ~/.noah/browser-bridge-key.pem

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_EXTENSION_DIR } from "../src/server/browserExtensionBundle.js";
import {
  UPDATE_PAYLOAD_ASSET,
  UPDATE_SIGNATURE_ASSET,
  buildUpdatePayload,
  extensionIdFromPublicKey,
  manifestKeyFromPrivateKey,
  signUpdatePayload,
} from "../src/server/browserExtensionUpdate.js";

function fail(message: string): never {
  console.error(`\n[build-browser-extension-update] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args: { key?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`${flag} needs a value.`);
      return argv[i];
    };
    if (flag === "--key") args.key = next();
    else if (flag === "--out") args.out = next();
    else fail(`Unknown flag ${flag}. Flags: --key --out`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const keyPath = args.key || process.env.BROWSER_EXTENSION_KEY_FILE;
if (!keyPath) {
  fail(
    "No signing key. Pass --key <path> or set BROWSER_EXTENSION_KEY_FILE.\n" +
      "First time? Generate one and keep the .pem permanently:\n" +
      "  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ~/.noah/browser-bridge-key.pem",
  );
}
const resolvedKeyPath = keyPath.startsWith("~")
  ? path.join(os.homedir(), keyPath.slice(1))
  : keyPath;
if (!fs.existsSync(resolvedKeyPath)) {
  fail(`Signing key not found: ${resolvedKeyPath}`);
}
const privateKeyPem = fs.readFileSync(resolvedKeyPath, "utf8");

// The manifest `key` IS the verify key every installed extension checks this
// signature against — a mismatch means shipping updates no install accepts
// (and, once installs migrate, a fleet split across two extension ids).
const manifestPath = path.join(BROWSER_EXTENSION_DIR, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  version?: string;
  key?: string;
};
const expectedManifestKey = manifestKeyFromPrivateKey(privateKeyPem);
const derivedId = extensionIdFromPublicKey(Buffer.from(expectedManifestKey, "base64"));
if (manifest.key !== expectedManifestKey) {
  fail(
    "extension/manifest.json `key` does not match the signing key — no installed extension would accept this signature.\n" +
      "One-time bootstrap for a new keypair — update ALL of these to the new key/id, commit, then re-run:\n" +
      `  1. extension/manifest.json  "key": "${expectedManifestKey}"\n` +
      `  2. src/client/src/lib/browserBridge.ts default extension id → "${derivedId}"\n` +
      "  3. extension/README.md 설치 안내의 예시 id, and the administrator allowedOrigins policy path\n" +
      "     (HKLM\\...\\3rdparty\\extensions\\<id>\\policy) — the id CHANGES with the key,\n" +
      "     so every existing install must be reloaded from a fresh zip once.",
  );
}

const outDir = args.out || path.join("dist", "extension");
fs.mkdirSync(outDir, { recursive: true });

const payload = buildUpdatePayload();
const signature = signUpdatePayload(payload, privateKeyPem);
const payloadPath = path.join(outDir, UPDATE_PAYLOAD_ASSET);
const signaturePath = path.join(outDir, UPDATE_SIGNATURE_ASSET);
fs.writeFileSync(payloadPath, payload);
fs.writeFileSync(signaturePath, `${signature}\n`);

console.log(`extension id : ${derivedId}`);
console.log(`version      : ${manifest.version}`);
console.log(`payload      : ${payloadPath} (${payload.length} bytes)`);
console.log(`signature    : ${signaturePath}`);
console.log("");
console.log("Attach BOTH files to the GitHub release. The extension's updater fetches:");
console.log(
  `  https://github.com/JinY0ung-Shin/noah-almighty/releases/latest/download/${UPDATE_PAYLOAD_ASSET}`,
);
