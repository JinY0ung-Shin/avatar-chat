import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  compareDottedVersions,
  mergeManifestPreservingMatches,
  noahOriginsFromMatches,
  validateUpdatePayload,
  zipUrlForOrigin,
  // @ts-expect-error — plain JS module that ships inside the extension bundle.
} from "../extension/updater-core.js";

describe("compareDottedVersions", () => {
  it("compares numerically per segment, not lexically", () => {
    expect(compareDottedVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareDottedVersions("0.7.0", "0.7.0")).toBe(0);
    expect(compareDottedVersions("0.7", "0.7.1")).toBeLessThan(0);
  });

  it("returns null for non-numeric versions so callers fail toward 'cannot compare'", () => {
    expect(compareDottedVersions("v1.0", "1.0")).toBeNull();
    expect(compareDottedVersions("1.0", "")).toBeNull();
  });
});

describe("validateUpdatePayload", () => {
  const good = () => ({
    version: "0.7.0",
    files: [
      { name: "manifest.json", content: "{}" },
      { name: "background.js", content: "// sw" },
    ],
  });

  it("accepts a well-formed payload and returns only name/content per file", () => {
    const payload = good();
    (payload.files[0] as Record<string, unknown>).extra = "smuggled";
    const out = validateUpdatePayload(payload);
    expect(out.version).toBe("0.7.0");
    expect(out.files[0]).toEqual({ name: "manifest.json", content: "{}" });
  });

  it("refuses names that could escape the connected folder", () => {
    for (const name of ["../evil.js", "a/b.js", "a\\b.js", "..", ".", "", ".hidden"]) {
      const payload = good();
      payload.files.push({ name, content: "x" });
      expect(() => validateUpdatePayload(payload), name).toThrow();
    }
  });

  it("refuses a payload without manifest.json — it would strand the install", () => {
    const payload = good();
    payload.files = payload.files.filter((f) => f.name !== "manifest.json");
    expect(() => validateUpdatePayload(payload)).toThrow(/manifest\.json/);
  });

  it("refuses malformed shapes and versions", () => {
    expect(() => validateUpdatePayload(null)).toThrow();
    expect(() => validateUpdatePayload({ version: "v7", files: good().files })).toThrow();
    expect(() => validateUpdatePayload({ version: "0.7.0", files: [] })).toThrow();
    expect(() =>
      validateUpdatePayload({ version: "0.7.0", files: [{ name: "manifest.json", content: 3 }] }),
    ).toThrow();
  });
});

describe("mergeManifestPreservingMatches", () => {
  it("keeps this install's extra Noah addresses on top of the shipped defaults", () => {
    const shipped = JSON.stringify({
      version: "0.8.0",
      externally_connectable: { matches: ["https://noah.corp.local/*"] },
    });
    const merged = JSON.parse(
      mergeManifestPreservingMatches(shipped, [
        "https://noah.internal.example:8443/*",
        "https://noah.corp.local/*", // already shipped — must not duplicate
        42, // junk in the runtime manifest must not survive
      ]),
    );
    expect(merged.externally_connectable.matches).toEqual([
      "https://noah.corp.local/*",
      "https://noah.internal.example:8443/*",
    ]);
    expect(merged.version).toBe("0.8.0");
  });

  it("throws on unparseable manifest bytes rather than writing them", () => {
    expect(() => mergeManifestPreservingMatches("not json", [])).toThrow();
  });
});

describe("noahOriginsFromMatches", () => {
  it("orders the real deployment ahead of the dev entries every build ships", () => {
    expect(
      noahOriginsFromMatches([
        "http://localhost:5173/*",
        "https://noah.corp.local/*",
        "http://127.0.0.1:48787/*",
      ]),
    ).toEqual(["https://noah.corp.local", "http://localhost:5173", "http://127.0.0.1:48787"]);
  });

  it("drops junk and duplicates rather than rendering a broken link", () => {
    expect(
      noahOriginsFromMatches([
        "https://noah.corp.local/*",
        "https://noah.corp.local/other/*", // same origin, different path
        "not a pattern",
        "file:///etc/*",
        42,
        null,
      ]),
    ).toEqual(["https://noah.corp.local"]);
    expect(noahOriginsFromMatches(undefined)).toEqual([]);
  });

  it("points at the server's zip endpoint", () => {
    expect(zipUrlForOrigin("https://noah.corp.local")).toBe(
      "https://noah.corp.local/api/browser-extension.zip",
    );
  });
});

describe("base64ToBytes", () => {
  it("decodes base64 with embedded whitespace (a .sig file ends with a newline)", () => {
    const bytes = base64ToBytes("aGVs\nbG8=\n");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });
});
