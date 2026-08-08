import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for what Chrome's accessibility tree actually reports about
// the four element kinds the browser bridge now makes decisions on
// (extension/background.js: refuseFileInput / inputKind / driveSlider,
// extension/axtree.js: image uids, sliderPlan).
//
// This repo pins Chrome facts by EXPERIMENT, not by reading the specification:
// the bridge addresses elements through AX roles and properties, so a role
// string that differs by one letter ("image" vs "img") silently removes a whole
// class of element from the snapshot, and a property Chrome does not emit
// silently removes a bound the slider planner needs.
//
// Four questions, all against `fixtures/ax-facts.html`:
//
//   1. Which role does an <img> get, and does a linked image keep the LINK in
//      its ancestor chain? (A thumbnail is usually the only clickable part of a
//      search result, and it is only reachable if one of the two carries a uid.)
//   2. What does <input type=file> look like? It is a plain button with a
//      Korean label — indistinguishable from any other button in a snapshot,
//      which is exactly why the bridge has to ask the DOM before clicking one.
//   3. Do both slider kinds (native range, WAI-ARIA div) report role `slider`
//      with readable numeric bounds and value? driveSlider reads the bounds from
//      DOM attributes first and falls back to aria-* then to AX properties; that
//      ladder only makes sense if the AX side really carries them.
//   4. Does Chrome TRUNCATE a very long accessible value? readAxValue verifies
//      writes by reading the value back, so a silent AX-side cap would make the
//      verification lie on a big field (suspected in a corrupted ~20 KB GitHub
//      blob read).
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/ax-facts.spec.ts`
// (npx playwright is broken here; this spec needs no dev server — it drives a
// local file:// fixture over raw CDP).

type AxValue = { value?: unknown };

type AxNode = {
  nodeId: string;
  backendDOMNodeId?: number;
  childIds?: string[];
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name?: string; value?: AxValue }[];
};

const roleOf = (node: AxNode | null) => String(node?.role?.value ?? "");
const nameOf = (node: AxNode | null) => String(node?.name?.value ?? "");

/** axtree.js `axProp`, so the probe reads properties exactly as the bridge does. */
function axPropOf(node: AxNode | null, name: string): unknown {
  return (node?.properties ?? []).find((prop) => prop?.name === name)?.value?.value;
}

async function backendIdFor(cdp: CDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return node.backendNodeId as number;
}

async function fullAxTree(cdp: CDPSession): Promise<AxNode[]> {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {} as never);
  return (nodes ?? []) as AxNode[];
}

/**
 * The AX node for one DOM element. Several nodes can carry the same
 * backendDOMNodeId (an ignored wrapper rides along), so the visible one wins —
 * the same preference `readAxValue` applies when it asks for a partial tree.
 */
function axFor(nodes: AxNode[], backendId: number): AxNode | null {
  const hits = nodes.filter((node) => node.backendDOMNodeId === backendId);
  return hits.find((node) => !node.ignored) ?? hits[0] ?? null;
}

/** Roles from a node up to the root, nearest first. */
function ancestorRoles(nodes: AxNode[], node: AxNode): string[] {
  const byId = new Map(nodes.map((one) => [one.nodeId, one]));
  const parentOf = new Map<string, string>();
  for (const one of nodes) for (const childId of one.childIds ?? []) parentOf.set(childId, one.nodeId);
  const roles: string[] = [];
  let cursor = parentOf.get(node.nodeId);
  while (cursor) {
    const parent = byId.get(cursor);
    if (!parent) break;
    roles.push(roleOf(parent));
    cursor = parentOf.get(cursor);
  }
  return roles;
}

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`ax-facts ${label}:`, body);
  test.info().attach(`ax-facts-${label}`, { body });
}

test.describe("what Chrome's accessibility tree emits (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    const fixture = path.join(path.dirname(test.info().file), "fixtures/ax-facts.html");
    await page.goto(pathToFileURL(fixture).href);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
  });

  test("an <img> emits role image, and a linked image keeps the link above it", async () => {
    const nodes = await fullAxTree(cdp);
    const bare = axFor(nodes, await backendIdFor(cdp, "#bare-img"));
    const thumb = axFor(nodes, await backendIdFor(cdp, "#thumb-img"));
    const link = axFor(nodes, await backendIdFor(cdp, "#thumb-link"));

    record("image", {
      bare: { role: roleOf(bare), name: nameOf(bare) },
      thumb: { role: roleOf(thumb), name: nameOf(thumb) },
      link: { role: roleOf(link), name: nameOf(link) },
      thumbAncestors: thumb ? ancestorRoles(nodes, thumb) : null,
    });

    // The spelling axtree.js mints image uids on. It tolerates both "image" and
    // "img"; this is which one Chrome actually says.
    expect(roleOf(bare), "role Chrome emits for <img alt>").toBe("image");
    expect(nameOf(bare)).toBe("marker");
    expect(roleOf(thumb), "a linked image is still an image").toBe("image");

    // A thumbnail link is reachable only if one of the two nodes carries a uid,
    // and the link is the node whose name and href describe the destination.
    expect(link, "the <a> has its own AX node").not.toBeNull();
    expect(roleOf(link)).toBe("link");
    expect(
      ancestorRoles(nodes, thumb as AxNode),
      "the link stays an ancestor of the image it wraps",
    ).toContain("link");
  });

  test("<input type=file> is a plain button with a Korean label", async () => {
    const nodes = await fullAxTree(cdp);
    const upload = axFor(nodes, await backendIdFor(cdp, "#upload"));

    record("file-input", {
      role: roleOf(upload),
      name: nameOf(upload),
      value: upload?.value?.value ?? null,
      properties: (upload?.properties ?? []).map((prop) => prop?.name),
    });

    // The whole reason refuseFileInput has to ask the DOM: nothing in the AX
    // node says "file upload". It is a button, and its name is whatever the page
    // labelled it — here Korean, which is what the field report showed too.
    expect(roleOf(upload), "AX role of <input type=file>").toBe("button");
    expect.soft(nameOf(upload), "its accessible name is page text, not a marker").toBeTruthy();
  });

  test("both slider kinds report role slider with numeric bounds and value", async () => {
    const nodes = await fullAxTree(cdp);
    const range = axFor(nodes, await backendIdFor(cdp, "#range"));
    const aria = axFor(nodes, await backendIdFor(cdp, "#aria-slider"));

    const shape = (node: AxNode | null) => ({
      role: roleOf(node),
      name: nameOf(node),
      value: node?.value?.value ?? null,
      valueType: typeof node?.value?.value,
      valuemin: axPropOf(node, "valuemin"),
      valuemax: axPropOf(node, "valuemax"),
      valuetext: axPropOf(node, "valuetext"),
      properties: (node?.properties ?? []).map((prop) => prop?.name),
    });
    record("sliders", { range: shape(range), aria: shape(aria) });

    // inputKind routes on the native type first and on this role second; a
    // design-system slider is a plain div and has nothing else to route on.
    expect(roleOf(range), "AX role of <input type=range>").toBe("slider");
    expect(roleOf(aria), 'AX role of <div role="slider">').toBe("slider");

    // driveSlider's bound ladder ends at these two properties, so an ARIA
    // slider that sets only aria-* must still expose them here.
    expect(Number(axPropOf(range, "valuemin")), "range valuemin").toBe(0);
    expect(Number(axPropOf(range, "valuemax")), "range valuemax").toBe(5);
    expect(Number(axPropOf(aria, "valuemin")), "aria-valuemin reaches the AX tree").toBe(10);
    expect(Number(axPropOf(aria, "valuemax")), "aria-valuemax reaches the AX tree").toBe(90);

    // The current value is read through axValueAnswer, which stringifies
    // whatever arrives — a slider's is a NUMBER, not a string (the reason
    // walkAxNodes uses `?? ""` rather than calling .trim() on it).
    expect(Number(range?.value?.value), "range current value").toBe(2.5);
    expect(Number(aria?.value?.value), "aria slider current value").toBe(40);
    expect
      .soft(typeof range?.value?.value, "Chrome reports a slider value as a number")
      .toBe("number");
  });

  test("a 42000-character textarea value survives the accessibility tree intact", async ({
    page,
  }) => {
    const nodes = await fullAxTree(cdp);
    const long = axFor(nodes, await backendIdFor(cdp, "#long"));
    // Measured off the DOM, not off a number the fixture recorded: the question
    // is whether the AX tree agrees with what the field actually holds.
    const truth = await page.evaluate(() => {
      const value = (document.getElementById("long") as HTMLTextAreaElement).value;
      return { longLength: value.length, longHead: value.slice(0, 12), longTail: value.slice(-12) };
    });
    const axValue = String(long?.value?.value ?? "");

    record("long-value", {
      domLength: truth.longLength,
      axLength: axValue.length,
      truncated: axValue.length !== truth.longLength,
      // Where it stopped, if it stopped: every 100 chars carry their offset.
      axHead: axValue.slice(0, 12),
      axTail: axValue.slice(-12),
      domHead: truth.longHead,
      domTail: truth.longTail,
    });

    expect(truth.longLength).toBeGreaterThan(40000);
    // Load-bearing for readAxValue: the clearing ladder decides "did the old
    // value survive" by comparing the value it reads back, and a value Chrome
    // silently cut at some ceiling would make every long-field verdict wrong.
    // Soft, because a cap is a Chrome implementation detail that may change —
    // if this goes red, the ladder needs a length-aware comparison, not a fix
    // here. The recorded axLength/axTail above say exactly where the cut fell.
    expect
      .soft(axValue.length, "Chrome does not truncate a long AX value")
      .toBe(truth.longLength);
    expect.soft(axValue.slice(0, 12), "the value starts where the DOM's does").toBe(truth.longHead);
  });
});
