// Build every browser-bridge update artifact from ONE signing key:
//
//   noah-bridge-update.json / .sig   in-page updater (File System Access)
//   noah-browser-bridge.crx          policy install channel (Chrome auto-update)
//   updates.xml                      Omaha manifest the policy's update_url names
//
// Two channels because one of them dies on a managed fleet: where a DLP agent
// intercepts file dialogs, the in-page updater cannot even open a folder
// picker, while the policy channel never opens one (Chrome downloads and
// installs by itself). Both verify against the same key.
//
// Release-machine only — the signing key never touches the server or the repo.
//
//   BROWSER_EXTENSION_KEY_FILE=~/.noah/browser-bridge-key.pem \
//     npx tsx scripts/build-browser-extension-update.ts --tag v1.3.0 \
//     [--origin "https://noah.internal.example/*"]... [--out dist/extension]
//
// The extension's updater page and the policy's update_url both read the
// stable "latest release" alias, so once a channel is live EVERY release must
// attach its assets.
//
// No key yet? Generate one and KEEP THE .pem FOREVER (the extension id and the
// pinned verify key derive from it; losing it orphans every install):
//   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
//     -out ~/.noah/browser-bridge-key.pem

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_EXTENSION_DIR,
  buildBrowserExtensionZip,
  matchPatternForOrigin,
} from "../src/server/browserExtensionBundle.js";
import { buildUpdatesXml, packCrx3 } from "../src/server/browserExtensionCrx.js";
import {
  UPDATE_PAYLOAD_ASSET,
  UPDATE_SIGNATURE_ASSET,
  buildUpdatePayload,
  extensionIdFromPublicKey,
  manifestKeyFromPrivateKey,
  signUpdatePayload,
} from "../src/server/browserExtensionUpdate.js";

const DEFAULT_REPO = "JinY0ung-Shin/noah-almighty";
const CRX_ASSET = "noah-browser-bridge.crx";
const UPDATES_XML_ASSET = "updates.xml";

function fail(message: string): never {
  console.error(`\n[build-browser-extension-update] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = { origins: [] as string[] } as {
    key?: string;
    out?: string;
    tag?: string;
    repo?: string;
    crxUrl?: string;
    origins: string[];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`${flag} needs a value.`);
      return argv[i];
    };
    if (flag === "--key") args.key = next();
    else if (flag === "--out") args.out = next();
    else if (flag === "--tag") args.tag = next();
    else if (flag === "--repo") args.repo = next();
    else if (flag === "--crx-url") args.crxUrl = next();
    else if (flag === "--origin") args.origins.push(next());
    else fail(`Unknown flag ${flag}. Flags: --key --out --tag --repo --crx-url --origin`);
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

// The manifest `key` is BOTH the verify key installed extensions check the
// payload signature against AND the source of the extension id a policy pins.
// A mismatch ships updates nobody accepts under an id nobody installed.
const manifestPath = path.join(BROWSER_EXTENSION_DIR, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  version?: string;
  key?: string;
  minimum_chrome_version?: string;
};
const expectedManifestKey = manifestKeyFromPrivateKey(privateKeyPem);
const extensionId = extensionIdFromPublicKey(Buffer.from(expectedManifestKey, "base64"));
if (manifest.key !== expectedManifestKey) {
  fail(
    "extension/manifest.json `key` does not match the signing key — no installed extension would accept\n" +
      "this signature, and the policy channel would install under a different id.\n" +
      "One-time bootstrap for a new keypair — update ALL of these to the new key/id, commit, then re-run:\n" +
      `  1. extension/manifest.json  "key": "${expectedManifestKey}"\n` +
      `  2. src/client/src/lib/browserBridge.ts default extension id → "${extensionId}"\n` +
      "  3. extension/README.md 설치 안내의 예시 id, and the administrator policy paths that name the id\n" +
      "     (allowedOrigins: HKLM\\...\\3rdparty\\extensions\\<id>\\policy, plus ExtensionSettings) —\n" +
      "     the id CHANGES with the key, so every existing install must be reloaded from a fresh zip once.",
  );
}
if (!manifest.version) fail(`No version in ${manifestPath}.`);

// Origins baked into the RELEASED manifest. This matters most for the policy
// channel: a policy-installed extension cannot be hand-edited, so if the Noah
// address is not in externally_connectable the bridge fails SILENTLY on every
// machine. Note the tradeoff — a GitHub release asset is PUBLIC, so an
// internal hostname stamped here is visible to the world; serve the crx from
// the Noah server (--crx-url) when that is not acceptable.
//
// BUILD-TIME only, by necessity: Chrome enforces externally_connectable before
// any extension code runs, so no server env var can influence it after the
// fact. The env var below just spares the release machine from restating the
// address on every release — set it once in the release shell profile.
//
// The manual zip path needs none of this: the download route stamps the
// requesting Noah address into that bundle's manifest by itself.
const ORIGINS_ENV = "BROWSER_BRIDGE_ORIGINS";
const rawOrigins = args.origins.length
  ? args.origins
  : (process.env[ORIGINS_ENV] || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
// Accept both a bare origin and a full match pattern: `matchPatternForOrigin`
// is the same normalizer the download route uses, so the two channels can
// never disagree about what a Noah address looks like.
const origins = rawOrigins.map((value) => {
  const pattern = matchPatternForOrigin(value.replace(/\/\*$/, ""));
  if (!pattern) {
    fail(
      `Not a usable Noah address: ${value}\n` +
        `Give an http(s) origin ("https://noah.example") or a match pattern ("https://noah.example/*"),\n` +
        `via --origin or ${ORIGINS_ENV}="https://noah.example,https://alt.example".`,
    );
  }
  return pattern;
});

const repo = args.repo || DEFAULT_REPO;
if (!args.tag && !args.crxUrl) {
  fail(
    "Pass --tag vX.Y.Z (the release these assets attach to) so updates.xml can point at this exact\n" +
      "release's crx, or --crx-url to host it elsewhere (e.g. on the Noah server).",
  );
}
const crxUrl = args.crxUrl || `https://github.com/${repo}/releases/download/${args.tag}/${CRX_ASSET}`;

const outDir = args.out || path.join("dist", "extension");
fs.mkdirSync(outDir, { recursive: true });

// In-page updater assets (generic: the updater merges each install's own
// externally_connectable back in at write time, so no origin stamping here).
const payload = buildUpdatePayload();
const signature = signUpdatePayload(payload, privateKeyPem);
fs.writeFileSync(path.join(outDir, UPDATE_PAYLOAD_ASSET), payload);
fs.writeFileSync(path.join(outDir, UPDATE_SIGNATURE_ASSET), `${signature}\n`);

// Policy-channel assets. Root-level zip: Chrome requires manifest.json at the
// crx archive root.
const crxZip = buildBrowserExtensionZip(undefined, origins, "");
const packed = packCrx3(crxZip, privateKeyPem);
fs.writeFileSync(path.join(outDir, CRX_ASSET), packed.crx);
fs.writeFileSync(
  path.join(outDir, UPDATES_XML_ASSET),
  buildUpdatesXml({
    extensionId,
    version: manifest.version,
    crxUrl,
    minChromeVersion: manifest.minimum_chrome_version,
  }),
);

const updateUrl = `https://github.com/${repo}/releases/latest/download/${UPDATES_XML_ASSET}`;
console.log(`extension id : ${extensionId}`);
console.log(`version      : ${manifest.version}`);
console.log(`out dir      : ${outDir}`);
console.log(`  ${UPDATE_PAYLOAD_ASSET} (${payload.length} bytes) + ${UPDATE_SIGNATURE_ASSET}`);
console.log(`  ${CRX_ASSET} (${packed.crx.length} bytes) + ${UPDATES_XML_ASSET} → ${crxUrl}`);
if (origins.length) {
  console.log(`baked origins: ${origins.join(", ")}`);
} else {
  console.log("");
  console.log(
    "NOTE: no Noah address baked in, so the crx accepts only the shipped defaults. A policy install\n" +
      "cannot be hand-edited: if the real address is missing, the bridge fails silently on every machine.\n" +
      `Set ${ORIGINS_ENV}="https://noah.example" on the release machine, or pass --origin.`,
  );
}
console.log("");
console.log("Attach ALL FOUR files to the GitHub release, then hand IT this policy (once):");
console.log(
  JSON.stringify(
    {
      ExtensionSettings: {
        [extensionId]: { installation_mode: "force_installed", update_url: updateUrl },
      },
    },
    null,
    2,
  ),
);
