import http from "node:http";
import { chromium, expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the Chromium facts `mcp__browser__type`'s SECRET input
// (extension/background.js: the `secret` handling in the type / fill_form
// branches, extension/secretInput.js) rests on. These are BLINK facts — what the
// renderer exposes about a password field and which document a node belongs to —
// not transport facts, so raw CDP over Playwright is the right probe here: every
// method used below is already on the extension's CDP_ALLOWLIST and already
// proven over `chrome.debugger` by the shipped ops that call it. (When a probe
// asks whether a method is REACHABLE at all, it must run over chrome.debugger
// instead — see the read_storage / DOMStorage lesson in browser-bridge/contract.md.)
//
// The design questions, and why each one decides something:
//
//   1. What does the accessibility tree report as a password field's value after
//      `Input.insertText`? The secret write must be VERIFIED — a silent no-op is
//      how every earlier write bug shipped — but a verification that reads the
//      value back would put the plaintext in the extension's hands as a
//      comparable string, one refactor away from a note or an error message. If
//      Chrome masks the value as one bullet per character, LENGTH is a real
//      verification signal that cannot leak the secret.
//   2. Same question for `getFullAXTree`, because that is the read the SNAPSHOT
//      returned by the same op is built from: whatever it shows travels into the
//      model's context.
//   3. `DOMSnapshot.captureSnapshot` is on the allowlist (the AX-invisible
//      clickable section uses it) — does its `inputValue` expose the PLAINTEXT?
//      If it does, that field must never be rendered into a snapshot, and the
//      document-attribution read below must take documentURL only.
//   4. `DOM.describeNode` — the preflight the password-only check reads — must
//      show the shape (`<input type=password>`) and NOT the value.
//   5. A plain `<input type=text>` reads back PLAINTEXT, which is why
//      `passwordOnly` defaults to true and why the length-only rule is applied to
//      every secret write regardless of the field kind.
//   6. Which DOCUMENT does a node belong to? A tab on an allowed host can embed a
//      same-process iframe from a SIBLING host (same site, different hostname),
//      and typing a credential into that frame would hand it to the sibling. The
//      extension therefore has to attribute the element's frame before the first
//      key. `DOMSnapshot.captureSnapshot` answers it for every same-process frame
//      in one call (documents[].documentURL + the backendNodeId list per
//      document); this pins that it really does.
//   7. A CROSS-site iframe is an OOPIF, and this is the half that MEASURED
//      differently from the obvious guess: its document is absent from the root
//      target's capture, AND its backendNodeIds are per-PROCESS, so the id of a
//      node inside it also names an unrelated node in the top document. Reading
//      one through a root capture therefore answers with the TOP page's URL —
//      the very host the secret is allowed on. So a uid carrying a sessionId is
//      attributed through THAT session instead, and this pins both halves.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/password-facts.spec.ts`
// (npx playwright is broken here; no dev server needed — local http servers + raw CDP).

const SECRET = "hunter2secret!";

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`password-facts ${label}:`, body);
  test.info().attach(`password-facts-${label}`, { body });
}

type AxNode = { value?: { value?: unknown }; backendDOMNodeId?: number };

/** The AX `value` of one node, exactly as background.js's readAxValue reads it. */
function axValueOf(node: AxNode | null | undefined): string | null {
  const raw = node?.value?.value;
  return typeof raw === "string" ? raw : null;
}

async function backendIdOf(cdp: CDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return node.backendNodeId as number;
}

/** Focus a field and type through the SAME primitive the bridge uses. */
async function insertInto(cdp: CDPSession, backendNodeId: number, text: string): Promise<void> {
  await cdp.send("DOM.focus", { backendNodeId });
  await cdp.send("Input.insertText", { text });
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>password fixture</title>
<body>
  <form>
    <input id="pw" type="password" name="password" autocomplete="current-password" />
    <input id="txt" type="text" name="username" />
  </form>
</body>`;

test.describe("what Chromium exposes of a password field's value (empirical)", () => {
  let cdp: CDPSession;
  let pw: number;
  let txt: number;

  test.beforeEach(async ({ page }) => {
    await page.setContent(PAGE);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
    await cdp.send("Accessibility.enable");
    pw = await backendIdOf(cdp, "#pw");
    txt = await backendIdOf(cdp, "#txt");
    await insertInto(cdp, pw, SECRET);
    await insertInto(cdp, txt, SECRET);
  });

  test("getPartialAXTree masks a password value as one bullet per character", async () => {
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      backendNodeId: pw,
      fetchRelatives: false,
    });
    const node = ((nodes ?? []) as AxNode[]).find((one) => one?.backendDOMNodeId === pw) ?? null;
    const value = axValueOf(node);
    record("partial-ax-password", { value, chars: value === null ? null : [...value].length });

    // Fact 1. The whole length-only verification rests on this: the read-back is
    // a MASK the same length as the secret, so comparing lengths proves the write
    // landed without the extension ever holding the value as a comparable string.
    expect(value, "a password field's AX value must not be the plaintext").not.toBe(SECRET);
    expect(value).toBe("•".repeat([...SECRET].length));
    expect([...String(value)].length).toBe([...SECRET].length);
  });

  test("getFullAXTree — the snapshot's own read — masks it identically", async () => {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree", {});
    const node = ((nodes ?? []) as AxNode[]).find((one) => one?.backendDOMNodeId === pw) ?? null;
    const value = axValueOf(node);
    record("full-ax-password", { value, chars: value === null ? null : [...value].length });

    // Fact 2. The op returns a snapshot built from this tree, so a leak here
    // would put the credential in the model's context on every secret write.
    expect(value).toBe("•".repeat([...SECRET].length));
  });

  test("DOMSnapshot.captureSnapshot DOES expose the plaintext in inputValue", async () => {
    const snap = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
    const strings = snap.strings as string[];
    const leaked = strings.filter((s) => s.includes(SECRET));
    record("domsnapshot-inputvalue", { leakedStrings: leaked });

    // Fact 3. The allowlisted method that WOULD leak it. Pinned so the rule is a
    // measurement rather than a memory: captureSnapshot's inputValue must never
    // be rendered into a snapshot, and the document attribution below reads
    // documentURL and node ids ONLY.
    expect(leaked, "captureSnapshot is the read that would leak a password").toContain(SECRET);
  });

  test("DOM.describeNode shows the shape and never the value", async () => {
    const { node } = await cdp.send("DOM.describeNode", { backendNodeId: pw, depth: 0 });
    const attrs = (node.attributes ?? []) as string[];
    const outer = await cdp.send("DOM.getOuterHTML", { backendNodeId: pw });
    record("describe-node", { nodeName: node.nodeName, attributes: attrs, outerHTML: outer.outerHTML });

    // Fact 4. The password-only check reads exactly this: nodeName INPUT plus a
    // `type` attribute of `password`. It is also a read that cannot leak — the
    // typed value is not in the attributes, and not in the serialized HTML.
    expect(node.nodeName).toBe("INPUT");
    expect(attrs[attrs.indexOf("type") + 1]).toBe("password");
    expect(attrs.join(" ")).not.toContain(SECRET);
    expect(String(outer.outerHTML)).not.toContain(SECRET);
  });

  test("a text input reads back the PLAINTEXT — why passwordOnly defaults on", async () => {
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      backendNodeId: txt,
      fetchRelatives: false,
    });
    const node = ((nodes ?? []) as AxNode[]).find((one) => one?.backendDOMNodeId === txt) ?? null;
    record("partial-ax-text", { value: axValueOf(node) });

    // Fact 5. No masking outside a password field. So a secret typed into a plain
    // text field is readable in the returned snapshot — which is what the
    // per-secret `passwordOnly` flag (default true) exists to prevent, and why
    // the extension never quotes a read-back on ANY secret write.
    expect(axValueOf(node)).toBe(SECRET);
  });
});

/**
 * Two hostnames on one site, served by one origin-agnostic server. `.test` is a
 * reserved TLD, so `corp.test` is the registrable domain and `app.` / `other.`
 * are SAME-SITE — which is exactly the dangerous shape: same process, one
 * accessibility/DOM target, two different hostnames.
 */
function startFrameServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (String(req.url).startsWith("/frame")) {
      res.end(
        '<!doctype html><meta charset="utf-8"><title>sibling frame</title>' +
          '<input id="fpw" type="password" name="password" />',
      );
      return;
    }
    const host = String(req.headers.host ?? "");
    const port = host.split(":")[1] ?? "80";
    res.end(
      '<!doctype html><meta charset="utf-8"><title>frame host</title>' +
        '<input id="pw" type="password" name="password" />' +
        `<iframe id="sibling" title="sibling" src="http://other.corp.test:${port}/frame"></iframe>` +
        `<iframe id="oopif" title="oopif" src="http://elsewhere.test:${port}/frame"></iframe>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        port: typeof addr === "object" && addr ? addr.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test.describe("which document a node belongs to (empirical)", () => {
  test("captureSnapshot attributes a same-process frame's input to that frame's URL", async () => {
    const fixture = await startFrameServer();
    // Its own browser: the hostnames must RESOLVE for a real cross-host iframe,
    // and site isolation must be ON so the cross-site frame is a real OOPIF —
    // both are launch arguments, not per-page options. (Desktop Chrome/Edge, the
    // fleet this extension ships to, isolate by default; a bare Playwright
    // chromium does not, and without this the OOPIF half of the probe would
    // silently measure a same-process frame.)
    const browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP *.test 127.0.0.1`, "--site-per-process", "--disable-gpu"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://app.corp.test:${fixture.port}/`);
      await page.waitForTimeout(300); // let both frames commit
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("DOM.enable");
      await cdp.send("Page.enable");
      await cdp.send("Accessibility.enable");

      const topPw = await backendIdOf(cdp, "#pw");
      // The sibling frame is same-site, so its content lives in the ROOT target:
      // pierce the owner to reach the input the way the bridge would have to.
      const owner = await backendIdOf(cdp, "#sibling");
      const { node: pierced } = await cdp.send("DOM.describeNode", {
        backendNodeId: owner,
        depth: -1,
        pierce: true,
      });
      const framePw = ((): number | null => {
        const queue: Record<string, unknown>[] = [pierced as unknown as Record<string, unknown>];
        while (queue.length) {
          const one = queue.shift() as Record<string, unknown>;
          if (String(one?.nodeName) === "INPUT") return one.backendNodeId as number;
          for (const child of (one?.children ?? []) as Record<string, unknown>[]) queue.push(child);
          const doc = one?.contentDocument as Record<string, unknown> | undefined;
          if (doc) queue.push(doc);
        }
        return null;
      })();

      const snap = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] });
      const strings = snap.strings as string[];
      const documents = (snap.documents ?? []).map((doc) => ({
        url: strings[doc.documentURL as unknown as number] ?? "",
        ids: ((doc.nodes as { backendNodeId?: number[] })?.backendNodeId ?? []) as number[],
      }));
      const urlOf = (backendNodeId: number | null) =>
        backendNodeId == null
          ? null
          : (documents.find((doc) => doc.ids.includes(backendNodeId))?.url ?? null);

      record("same-process-attribution", {
        documents: documents.map((doc) => ({ url: doc.url, nodes: doc.ids.length })),
        topPwUrl: urlOf(topPw),
        framePwUrl: urlOf(framePw),
      });

      // Fact 6. One call attributes EVERY same-process node to its own document,
      // so the extension can tell "this field is on the allowed host" from "this
      // field is in a sibling-host iframe the allowed host embedded".
      expect(framePw, "the sibling frame's input must be reachable from the root target").not.toBeNull();
      expect(urlOf(topPw)).toBe(`http://app.corp.test:${fixture.port}/`);
      expect(urlOf(framePw)).toBe(`http://other.corp.test:${fixture.port}/frame`);

      // The short-circuit the extension leans on: the root target's frame tree
      // lists exactly the documents a ROOT-session node could live in (its own
      // main frame plus the same-process children — the OOPIF is absent, because
      // it is a different target). So an empty child list means "this node is in
      // the main frame", and an ordinary single-frame login page pays no capture
      // at all. A node inside the OOPIF is not addressable from here either: its
      // uid carries that frame's session, which is the branch that handles it.
      const { frameTree: rootTree } = await cdp.send("Page.getFrameTree");
      const childUrls = (rootTree.childFrames ?? []).map((child) => child.frame.url);
      record("root-frame-tree", { childUrls });
      expect(childUrls).toEqual([`http://other.corp.test:${fixture.port}/frame`]);

      // Fact 7. A CROSS-site frame is an OOPIF: its own renderer, its own CDP
      // session — and its document is ABSENT from the root target's capture.
      // Worse, its backendNodeIds are per-PROCESS, so the id of a node inside it
      // also names an unrelated node in the root document. Attributing an OOPIF
      // element through a root-session capture would therefore answer with the
      // TOP page's URL, which is precisely the host a secret is allowed on — a
      // silent bypass. So a uid that carries a sessionId must be attributed
      // through THAT session (Page.getFrameTree on it), never through the root.
      const oopifUrl = `http://elsewhere.test:${fixture.port}/frame`;
      const oopifFrame = page.frames().find((frame) => frame.url() === oopifUrl);
      expect(oopifFrame, "the cross-site iframe must load").toBeTruthy();
      const frameCdp = await page.context().newCDPSession(oopifFrame!);
      await frameCdp.send("DOM.enable");
      const oopifPw = await backendIdOf(frameCdp, "#fpw");
      const { frameTree } = await frameCdp.send("Page.getFrameTree");
      record("oopif-attribution", {
        oopifPw,
        urlFromRootSnapshot: urlOf(oopifPw),
        urlFromOwnSession: frameTree.frame.url,
      });
      expect(documents.map((doc) => doc.url)).not.toContain(oopifUrl);
      // The collision itself, pinned: the same number means two different nodes.
      expect(urlOf(oopifPw), "an OOPIF node id is NOT root-attributable").not.toBe(oopifUrl);
      // …and the session that owns the node answers correctly.
      expect(frameTree.frame.url).toBe(oopifUrl);
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
});
