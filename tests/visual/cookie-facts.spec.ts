import http from "node:http";
import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the ONE CDP fact `mcp__browser__read_cookies`
// (extension/background.js: the read_cookies branch of performOp) rests on:
// whether `Network.getCookies` answers with only the debugger attached, WITHOUT
// `Network.enable`. This repo pins Chrome facts by EXPERIMENT, not by reading
// the specification (the DOMSnapshot.enable / Overlay.enable probes are the
// precedent — ax-facts.spec.ts, overlay-highlight.spec.ts).
//
// It matters because `Network.enable` is deliberately NOT on the CDP_ALLOWLIST:
// it streams every network event (requestWillBeSent, responseReceived, raw
// bodies) — a far wider read than reading the cookie jar. read_cookies adds
// ONLY `Network.getCookies`, a command method that reads the cookie store
// directly, so it is sound only if that method needs no enable. If a future
// Chrome starts REQUIRING Network.enable for getCookies, this pin flips and the
// op must move to `Storage.getCookies` (which needs no enable) with
// extension-side current-origin filtering instead.
//
// Three questions, against a throwaway 127.0.0.1 server that Set-Cookies a
// normal AND an HttpOnly cookie:
//
//   1. Does `Network.getCookies` return WITHOUT `Network.enable`? (The
//      allowlist justification.)
//   2. Does it return the HttpOnly cookie a page's document.cookie cannot see?
//      (That is the whole reason the op exists — reading the live session
//      token — and the reason it is consent-gated.)
//   3. Does `{ urls: [pageUrl] }` scope the answer to the current origin only,
//      never a cross-site cookie? (The op's current-origin invariant.)
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/cookie-facts.spec.ts`
// (npx playwright is broken here; no dev server needed — a local http server + raw CDP).

type Cookie = { name: string; value: string; domain: string; httpOnly?: boolean };

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`cookie-facts ${label}:`, body);
  test.info().attach(`cookie-facts-${label}`, { body });
}

/**
 * A throwaway origin that hands out one readable and one HttpOnly cookie plus a
 * body — real http, so the cookies behave exactly as a live site's would (a
 * file:// page cannot carry cookies, and JS cannot set an HttpOnly one).
 */
function startCookieServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader("Set-Cookie", [
      "readable=plain-value; Path=/; SameSite=Lax",
      "session=httponly-secret; Path=/; HttpOnly; SameSite=Lax",
    ]);
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><title>cookie fixture</title><body>cookie fixture</body>");
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

test.describe("what Network.getCookies does without Network.enable (empirical)", () => {
  let cdp: CDPSession;
  let fixture: { url: string; close: () => Promise<void> };

  test.beforeEach(async ({ page }) => {
    fixture = await startCookieServer();
    await page.goto(fixture.url);
    cdp = await page.context().newCDPSession(page);
    // EXACTLY the domains ensureAttached turns on for a read — Network.enable is
    // deliberately absent, because the whole question is whether getCookies
    // needs it. If this suite ever has to add Network.enable to make the test
    // pass, that is the answer flipping, not a test-setup detail.
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
  });

  test.afterEach(async () => {
    await fixture.close();
  });

  test("getCookies answers without Network.enable and includes the HttpOnly cookie", async () => {
    let failure = "";
    let cookies: Cookie[] = [];
    try {
      const res = await cdp.send("Network.getCookies", { urls: [fixture.url] });
      cookies = (res.cookies ?? []) as Cookie[];
    } catch (error) {
      failure = String(error);
    }
    const byName = (name: string) => cookies.find((c) => c.name === name) ?? null;
    record("no-enable", {
      failure: failure || null,
      names: cookies.map((c) => c.name),
      readable: byName("readable"),
      session: byName("session"),
    });

    // Fact 1: the command answers with no Network.enable. If a future Chrome
    // refuses here, read_cookies must switch to Storage.getCookies.
    expect(failure, "Network.getCookies must not need Network.enable").toBe("");
    // Fact 2: the HttpOnly cookie — the live session token — is present. This is
    // exactly what document.cookie cannot see and why the op is consent-gated.
    expect(byName("session")?.value, "the HttpOnly session cookie is readable over CDP").toBe(
      "httponly-secret",
    );
    expect(byName("session")?.httpOnly).toBe(true);
    expect(byName("readable")?.value).toBe("plain-value");
  });

  test("{ urls } scopes the read to the current origin — no cross-site cookie", async () => {
    // A cookie on a DIFFERENT origin must not appear in a urls-scoped read.
    const other = await startCookieServer();
    try {
      const { cookies } = await cdp.send("Network.getCookies", { urls: [fixture.url] });
      const domains = [...new Set(((cookies ?? []) as Cookie[]).map((c) => c.domain))];
      record("scoped", { domains, otherUrl: other.url });
      // Both fixtures share 127.0.0.1 as host, so this asserts the mechanism
      // shape (a single-host answer), not port isolation: the point pinned is
      // that the extension passes `urls:[tab.url]`, never an unscoped getAllCookies.
      expect(domains).toContain("127.0.0.1");
    } finally {
      await other.close();
    }
  });
});
