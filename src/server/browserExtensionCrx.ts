import crypto from "node:crypto";

/**
 * CRX3 packaging for the POLICY install channel — the one auto-update path.
 *
 * It needs nothing from the user at all: an administrator policy names an
 * `update_url`, and Chrome itself fetches the Omaha manifest, downloads the
 * signed `.crx`, and swaps versions in the background. That matters on a
 * managed fleet where a DLP agent intercepts every file dialog — no dialog is
 * ever opened here.
 *
 * Hand-rolled for the same reason the extension ZIP is: the CRX header is a
 * small fixed protobuf around bytes we already build, and the SIGNING path is
 * the worst possible place for a third-party dependency — a compromised packer
 * would sign whatever it liked with our key.
 *
 * Format (components/crx_file in Chromium):
 *   "Cr24" | uint32le(3) | uint32le(header_len) | CrxFileHeader | <zip>
 *   CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
 *                   bytes signed_header_data = 10000; }
 *   AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
 *   SignedData { bytes crx_id = 1; }   // = sha256(public key DER)[0..16)
 * The RSA(PKCS#1 v1.5, SHA-256) signature covers:
 *   "CRX3 SignedData\x00" | uint32le(len(signed_header_data)) |
 *   signed_header_data | <zip>
 *
 * Key helpers are NOT redefined here — they live in browserExtensionUpdate.ts
 * so ids and manifest keys derive from one implementation.
 *
 * NOTHING here runs on a server request path: the private key exists only on
 * the release machine, and the server never imports this module.
 */

/** Protobuf base-128 varint. */
function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

/** One length-delimited (wire type 2) protobuf field. */
function protoField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

/** First 16 bytes of sha256 over the SPKI DER — Chrome's crx_id. */
export function crxIdFromPublicKey(spkiDer: Buffer): Buffer {
  return crypto.createHash("sha256").update(spkiDer).digest().subarray(0, 16);
}

export interface PackedCrx {
  crx: Buffer;
  publicKeyDer: Buffer;
  /** Exposed for tests: verify the signature without re-parsing the protobuf. */
  signature: Buffer;
  signedHeaderData: Buffer;
}

/** Sign `zip` (manifest.json at the archive ROOT) into a CRX3 file. */
export function packCrx3(zip: Buffer, privateKeyPem: string): PackedCrx {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error(
      `The signing key must be RSA (got ${privateKey.asymmetricKeyType}); Chrome verifies crx3 with sha256_with_rsa.`,
    );
  }
  const publicKeyDer = crypto
    .createPublicKey(privateKey)
    .export({ type: "spki", format: "der" }) as Buffer;

  const signedHeaderData = protoField(1, crxIdFromPublicKey(publicKeyDer)); // SignedData
  const shdLength = Buffer.alloc(4);
  shdLength.writeUInt32LE(signedHeaderData.length, 0);
  const signedPayload = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "latin1"),
    shdLength,
    signedHeaderData,
    zip,
  ]);
  // RSASSA-PKCS1-v1_5 is node's default padding for RSA keys.
  const signature = crypto.sign("sha256", signedPayload, privateKey);

  const proof = Buffer.concat([protoField(1, publicKeyDer), protoField(2, signature)]);
  const header = Buffer.concat([protoField(2, proof), protoField(10000, signedHeaderData)]);

  const prelude = Buffer.alloc(12);
  prelude.write("Cr24", 0, "latin1");
  prelude.writeUInt32LE(3, 4);
  prelude.writeUInt32LE(header.length, 8);

  return { crx: Buffer.concat([prelude, header, zip]), publicKeyDer, signature, signedHeaderData };
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The Omaha update manifest Chrome polls from the policy's `update_url`.
 * Host it at a STABLE address (GitHub: `releases/latest/download/updates.xml`)
 * while `crxUrl` pins the exact versioned artifact of THIS release, so a
 * cached manifest can never point at bytes that were replaced.
 */
export function buildUpdatesXml(opts: {
  extensionId: string;
  version: string;
  crxUrl: string;
  minChromeVersion?: string;
}): string {
  const min = opts.minChromeVersion
    ? ` prodversionmin='${escapeXmlAttr(opts.minChromeVersion)}'`
    : "";
  return (
    "<?xml version='1.0' encoding='UTF-8'?>\n" +
    "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n" +
    `  <app appid='${escapeXmlAttr(opts.extensionId)}'>\n` +
    `    <updatecheck codebase='${escapeXmlAttr(opts.crxUrl)}' version='${escapeXmlAttr(opts.version)}'${min} />\n` +
    "  </app>\n" +
    "</gupdate>\n"
  );
}
