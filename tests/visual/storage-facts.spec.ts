import http from "node:http";
import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the CDP facts `mcp__browser__read_storage`
// (extension/background.js: the read_storage branch of performOp) rests on:
// whether `DOMStorage.getDOMStorageItems` answers with only the debugger
// attached, WITHOUT `DOMStorage.enable`, and how the localStorage vs
// sessionStorage store is selected. This repo pins Chrome facts by EXPERIMENT,
// not by reading the specification (cookie-facts.spec.ts is the direct
// precedent; the DOMSnapshot.enable / Overlay.enable probes came before it).
//
// It matters because `DOMStorage.enable` is deliberately NOT on the
// CDP_ALLOWLIST: it streams every storage CHANGE event (domStorageItemAdded /
// Updated / Removed) — a far wider read than reading the store once. read_storage
// adds ONLY `DOMStorage.getDOMStorageItems`, a command method that reads a
// store's items directly, so it is sound only if that method needs no enable. If
// a future Chrome starts REQUIRING DOMStorage.enable for getDOMStorageItems, this
// pin flips and the op must be reworked.
//
// Three questions, against a throwaway 127.0.0.1 server whose page inline-sets a
// localStorage and a sessionStorage item:
//
//   1. Does `DOMStorage.getDOMStorageItems` return WITHOUT `DOMStorage.enable`?
//      (The allowlist justification.)
//   2. Does `{ securityOrigin, isLocalStorage: true }` return the localStorage
//      item? (localStorage commonly holds bearer/JWT tokens — the whole reason
//      the op exists, and the reason it is consent-gated.)
//   3. Does `{ securityOrigin, isLocalStorage: false }` return the sessionStorage
//      item? (The op reads BOTH stores, chosen by isLocalStorage.)
//
// The `storageKey` variant of storageId fails ("Frame not found") in this
// Chromium, which is why the op uses the deprecated-but-working `securityOrigin`.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/storage-facts.spec.ts --project=chromium`
// (npx playwright is broken here; no dev server needed — a local http server + raw CDP).

type Entry = [string, string];

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`storage-facts ${label}:`, body);
  test.info().attach(`storage-facts-${label}`, { body });
}

/**
 * A throwaway origin whose page inline-sets one localStorage and one
 * sessionStorage item — real http, so the stores behave exactly as a live site's
 * would (a file:// page has a null/opaque origin that DOM storage refuses).
 */
function startStorageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>storage fixture</title>" +
        "<script>" +
        "try { localStorage.setItem('local-key', 'local-value'); } catch (e) {}" +
        "try { sessionStorage.setItem('session-key', 'session-value'); } catch (e) {}" +
        "</script><body>storage fixture</body>",
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test.describe("what DOMStorage.getDOMStorageItems does without DOMStorage.enable (empirical)", () => {
  let cdp: CDPSession;
  let fixture: { url: string; close: () => Promise<void> };
  let origin: string;

  test.beforeEach(async ({ page }) => {
    fixture = await startStorageServer();
    origin = new URL(fixture.url).origin;
    await page.goto(fixture.url);
    cdp = await page.context().newCDPSession(page);
    // EXACTLY the domains ensureAttached turns on for a read — DOMStorage.enable
    // is deliberately absent, because the whole question is whether
    // getDOMStorageItems needs it. If this suite ever has to add DOMStorage.enable
    // to make the test pass, that is the answer flipping, not a test-setup detail.
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
  });

  test.afterEach(async () => {
    await fixture.close();
  });

  test("getDOMStorageItems answers without DOMStorage.enable and reads localStorage", async () => {
    let failure = "";
    let entries: Entry[] = [];
    try {
      const res = await cdp.send("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin: origin, isLocalStorage: true },
      });
      entries = (res.entries ?? []) as Entry[];
    } catch (error) {
      failure = String(error);
    }
    const find = (key: string) => entries.find((e) => e[0] === key) ?? null;
    record("local-no-enable", { failure: failure || null, entries });

    // Fact 1: the command answers with no DOMStorage.enable. If a future Chrome
    // refuses here, read_storage must be reworked.
    expect(failure, "DOMStorage.getDOMStorageItems must not need DOMStorage.enable").toBe("");
    // Fact 2: the localStorage item — a bearer/JWT token's typical home — is
    // present when isLocalStorage is true. This is why the op is consent-gated.
    expect(find("local-key")).toEqual(["local-key", "local-value"]);
  });

  test("isLocalStorage:false reads sessionStorage from the same securityOrigin", async () => {
    let failure = "";
    let entries: Entry[] = [];
    try {
      const res = await cdp.send("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin: origin, isLocalStorage: false },
      });
      entries = (res.entries ?? []) as Entry[];
    } catch (error) {
      failure = String(error);
    }
    const find = (key: string) => entries.find((e) => e[0] === key) ?? null;
    record("session", { failure: failure || null, entries });

    // Fact 3: flipping isLocalStorage to false reads sessionStorage instead —
    // the same securityOrigin, the other store, no DOMStorage.enable either.
    expect(failure, "sessionStorage read must not need DOMStorage.enable").toBe("");
    expect(find("session-key")).toEqual(["session-key", "session-value"]);
    // And it is a DIFFERENT store: the localStorage key must not leak into it.
    expect(find("local-key")).toBeNull();
  });
});
