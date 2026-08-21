import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type CDPSession, type Page } from "@playwright/test";

// EMPIRICAL evidence for the coordinate-space and input facts the VOC round-10
// fixes stand on (extension/background.js: captureShot resolving quads BEFORE
// the layout-metrics read, hitNodeAt's two-space hit test, subtreeContains's
// contentDocument hop, and the spinbutton write path). This repo pins Chrome
// facts by EXPERIMENT (the precedent: ax-facts.spec.ts, zoom-capture.spec.ts);
// each test here reproduces the field failure it guards against as a negative
// control, so a Chrome that changes the semantics fails the pin rather than
// silently re-opening the bug.
//
// Four questions, all against `fixtures/scrolled-hit.html`:
//
//   1. `DOM.scrollIntoViewIfNeeded` SCROLLS, and `DOM.getContentQuads` answers
//      relative to the POST-scroll viewport — so a page offset read BEFORE the
//      scroll reconstructs the wrong document position by exactly the scroll
//      delta. (The torn-clip bug: an off-viewport element's screenshot showed a
//      region offset by that delta.)
//   2. On a SCROLLED page, a `DOM.getNodeForLocation` answer cannot be taken on
//      faith: only an answer whose own quads CONTAIN the asked viewport point is
//      trustworthy, and asking twice — the point as-is, then the point
//      translated by the scroll offset — terminates on the real element. (The
//      false-"could not be identified" and false-obstruction bugs.)
//   3. `DOM.describeNode` with pierce exposes a same-origin iframe's document as
//      `contentDocument` on the frame node, NOT in `children` — a subtree walk
//      without that hop cannot see INTO the frame. (The false-obstruction bug's
//      second half: the <iframe> read as unrelated to its own inner button.)
//   4. An <input type=date>'s year/month/day parts are role `spinbutton`,
//      `Input.insertText` into one is a SILENT NO-OP, and digit KEY events do
//      write — which is why inputKind must route them off the text path.
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/scrolled-hit-facts.spec.ts`
// (npx playwright is broken here; this spec needs no dev server — it drives a
// local file:// fixture over raw CDP).

type AxValue = { value?: unknown };

type AxNode = {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  value?: AxValue;
  properties?: { name?: string; value?: AxValue }[];
};

type DomNode = {
  backendNodeId?: number;
  nodeName?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
};

const roleOf = (node: AxNode | null) => String(node?.role?.value ?? "");

function axPropOf(node: AxNode | null, name: string): unknown {
  return (node?.properties ?? []).find((prop) => prop?.name === name)?.value?.value;
}

function attrOf(node: DomNode | null, name: string): string | null {
  const flat = node?.attributes ?? [];
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i] === name) return flat[i + 1];
  return null;
}

async function backendIdFor(cdp: CDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return node.backendNodeId as number;
}

async function pageYOf(cdp: CDPSession): Promise<number> {
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const viewport = (metrics.cssVisualViewport ?? metrics.cssLayoutViewport ?? {}) as {
    pageY?: number;
  };
  return viewport.pageY ?? 0;
}

/** background.js `quadsContain`, replicated so the probe checks what the bridge checks. */
function quadsContain(quads: number[][], x: number, y: number): boolean {
  return (quads || []).some((quad) => {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return (
      x >= Math.min(...xs) - 1 &&
      x <= Math.max(...xs) + 1 &&
      y >= Math.min(...ys) - 1 &&
      y <= Math.max(...ys) + 1
    );
  });
}

async function askHit(
  cdp: CDPSession,
  x: number,
  y: number,
): Promise<{ backendNodeId: number; quads: number[][] } | null> {
  try {
    const { backendNodeId } = await cdp.send("DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
    });
    if (!backendNodeId) return null;
    const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId });
    return { backendNodeId, quads: (quads ?? []) as number[][] };
  } catch {
    return null;
  }
}

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`scrolled-hit ${label}:`, body);
  test.info().attach(`scrolled-hit-${label}`, { body });
}

async function documentTopOf(page: Page, id: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.getElementById(sel);
    if (!el) throw new Error(`no #${sel}`);
    return el.getBoundingClientRect().top + window.scrollY;
  }, id);
}

test.describe("scrolled-page coordinate facts (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    const fixture = path.join(path.dirname(test.info().file), "fixtures/scrolled-hit.html");
    await page.goto(pathToFileURL(fixture).href);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Page.enable");
  });

  test("quads answer for the POST-scrollIntoView viewport; a pre-scroll page offset tears the sum", async ({
    page,
  }) => {
    await page.evaluate(() => window.scrollTo(0, 1000));
    const stalePageY = await pageYOf(cdp);
    expect(stalePageY).toBeGreaterThan(900); // the premise: we start scrolled far away

    // #btn2 sits at document y ≈ 204 — far above the 1000px-scrolled viewport,
    // so scrollIntoViewIfNeeded has to move the page.
    const btn2 = await backendIdFor(cdp, "#btn2");
    await cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: btn2 });
    const { quads } = await cdp.send("DOM.getContentQuads", { backendNodeId: btn2 });
    const quadTop = Math.min(...(quads?.[0] ?? []).filter((_, i) => i % 2 === 1));
    const freshPageY = await pageYOf(cdp);
    const documentY = await documentTopOf(page, "btn2");

    record("capture-order", { stalePageY, freshPageY, quadTop, documentY });

    // The scroll really moved — otherwise this test pins nothing.
    expect(Math.abs(freshPageY - stalePageY)).toBeGreaterThan(100);
    // The fix's arithmetic: post-scroll quads + post-scroll offset = document position.
    expect(Math.abs(quadTop + freshPageY - documentY)).toBeLessThan(2);
    // Negative control — the torn-clip bug: the same quads summed with the
    // PRE-scroll offset miss the element by the scroll delta.
    expect(Math.abs(quadTop + stalePageY - documentY)).toBeGreaterThan(100);
  });

  test("a hit test is only trustworthy when the answer's quads contain the point; two asks terminate", async ({
    page,
  }) => {
    await page.evaluate(() => window.scrollTo(0, 800));
    // The viewport-space centre of #btn9 (document y ≈ 904), measured by the page.
    const point = await page.evaluate(() => {
      const rect = document.getElementById("btn9")!.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });

    // hitNodeAt's exact algorithm, replicated: ask with the viewport point,
    // trust it only if its quads contain that point, otherwise ask again with
    // the point translated by the scroll offset.
    const direct = await askHit(cdp, point.x, point.y);
    const directContains = direct !== null && quadsContain(direct.quads, point.x, point.y);
    let resolved = directContains ? direct : null;
    let usedScrolledRetry = false;
    if (!resolved) {
      usedScrolledRetry = true;
      const pageY = await pageYOf(cdp);
      const second = await askHit(cdp, point.x, point.y + pageY);
      resolved = second !== null && quadsContain(second.quads, point.x, point.y) ? second : null;
    }

    const described = resolved
      ? ((await cdp.send("DOM.describeNode", { backendNodeId: resolved.backendNodeId }))
          .node as DomNode)
      : null;
    record("hit-test", {
      point,
      directContains,
      usedScrolledRetry,
      resolvedTo: described ? `${described.nodeName}#${attrOf(described, "id")}` : null,
    });

    // Whichever space this Chrome answers in, the algorithm must end on the
    // element that is really under the viewport point — that is the property
    // describePoint and assertNotObscured act on.
    expect(described, "the two-ask algorithm resolved SOME node").not.toBeNull();
    expect(described?.nodeName).toBe("BUTTON");
    expect(attrOf(described, "id")).toBe("btn9");
  });

  test("pierce hands a same-origin iframe's document over as contentDocument, not as a child", async () => {
    const ifr = await backendIdFor(cdp, "#ifr");
    const { node } = await cdp.send("DOM.describeNode", {
      backendNodeId: ifr,
      depth: -1,
      pierce: true,
    });

    const findButton = (root: DomNode, followContentDocument: boolean): boolean => {
      const queue: DomNode[] = [root];
      while (queue.length) {
        const one = queue.shift()!;
        if (one.nodeName === "BUTTON" && attrOf(one, "id") === "inbtn") return true;
        for (const child of one.children ?? []) queue.push(child);
        for (const shadow of one.shadowRoots ?? []) queue.push(shadow);
        if (followContentDocument && one.contentDocument) queue.push(one.contentDocument);
      }
      return false;
    };

    const withHop = findButton(node as DomNode, true);
    const withoutHop = findButton(node as DomNode, false);
    record("content-document", { withHop, withoutHop });

    // The hop is load-bearing: without it the frame's inner button is invisible
    // to a subtree walk (the false-obstruction bug's "not related" half)...
    expect(withoutHop).toBe(false);
    // ...and with it the same walk finds the button.
    expect(withHop).toBe(true);
  });

  test("a date part is a spinbutton that ignores insertText and takes digit keys", async () => {
    await cdp.send("Accessibility.enable");
    const dateip = await backendIdFor(cdp, "#dateip");

    const partValue = async (backendId: number): Promise<string | null> => {
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
        backendNodeId: backendId,
        fetchRelatives: false,
      });
      const list = (nodes ?? []) as AxNode[];
      const own = list.find((one) => one.backendDOMNodeId === backendId) ?? list[0] ?? null;
      return own?.value?.value == null ? null : String(own.value.value);
    };

    // The year part is found by what it IS (the spinbutton whose max only a
    // year field has), not by its locale-dependent name.
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const spins = ((nodes ?? []) as AxNode[]).filter(
      (one) => !one.ignored && roleOf(one) === "spinbutton",
    );
    const year = spins.find((one) => Number(axPropOf(one, "valuemax")) > 10000);
    record("date-parts", {
      spinButtons: spins.length,
      yearMax: year ? axPropOf(year, "valuemax") : null,
    });
    expect(spins.length, "an empty <input type=date> exposes its parts").toBeGreaterThanOrEqual(3);
    expect(year, "one part's valuemax marks it as the year").toBeTruthy();
    const yearId = year!.backendDOMNodeId as number;

    // The silent no-op the routing exists for: insertText reports nothing and
    // writes nothing.
    await cdp.send("DOM.focus", { backendNodeId: yearId });
    await cdp.send("Input.insertText", { text: "2026" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterInsert = await partValue(yearId);
    expect(Number(afterInsert ?? 0)).not.toBe(2026);

    // Digit KEY events are what a date part listens to.
    for (const ch of "2026") {
      const key = {
        key: ch,
        text: ch,
        code: `Digit${ch}`,
        windowsVirtualKeyCode: ch.charCodeAt(0),
      };
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterKeys = await partValue(yearId);
    record("date-write", { afterInsert, afterKeys });
    expect(Number(afterKeys ?? 0)).toBe(2026);
  });
});
