import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type CDPSession } from "@playwright/test";

// EMPIRICAL evidence for the three Chrome facts VOC round 11 decides on
// (extension/axtree.js: stateFlags' sort marker, rangeFlags' degenerate-bounds
// suppression, INTERACTIVE_ROLES gaining "listbox"):
//
//   1. `Accessibility.getFullAXTree` does NOT deliver aria-sort — on a native
//      <th aria-sort> and on the ARIA shape ag-grid renders (div
//      role=columnheader) alike, the node arrives carrying only
//      readonly/required. That absence is WHY the sort marker has to be read
//      from the DOM capture (axtree.js ariaSortByBackendId) instead of from
//      the AX properties every other state flag uses.
//   2. What bounds does an UNBOUNDED <input type=number> report? ag-grid's
//      number filters printed `[min 0 max 0]` — a range no page authored. If
//      Chrome itself emits 0/0 for "no bounds", the pair is a sentinel and
//      suppressing it deletes no page fact; the authored-zero control is the
//      negative control that the sentinel and a real 0..0 range are
//      INDISTINGUISHABLE on the wire (which is why suppression is the honest
//      print either way).
//   3. Which role does a <select multiple> itself get, is it focusable, and do
//      its options sit under it — i.e. does adding "listbox" to
//      INTERACTIVE_ROLES give select_option's option-collector a root to walk?
//
// Run with `node node_modules/@playwright/test/cli.js test tests/visual/round11-facts.spec.ts`
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

/** axtree.js `axProp`, so the probe reads properties exactly as the bridge does. */
function axPropOf(node: AxNode | null, name: string): unknown {
  return (node?.properties ?? []).find((prop) => prop?.name === name)?.value?.value;
}

const propNames = (node: AxNode | null) => (node?.properties ?? []).map((prop) => String(prop?.name));

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

function axFor(nodes: AxNode[], backendId: number): AxNode | null {
  const hits = nodes.filter((node) => node.backendDOMNodeId === backendId);
  return hits.find((node) => !node.ignored) ?? hits[0] ?? null;
}

/** One observation, printed and attached — the point of a fact probe. */
function record(label: string, observed: unknown): void {
  const body = JSON.stringify(observed, null, 2);
  // eslint-disable-next-line no-console
  console.log(`round11-facts ${label}:`, body);
  test.info().attach(`round11-facts-${label}`, { body });
}

test.describe("round-11 Chrome facts (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    const fixture = path.join(path.dirname(test.info().file), "fixtures/round11-facts.html");
    await page.goto(pathToFileURL(fixture).href);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
  });

  test("aria-sort does NOT arrive in the AX tree — the DOM capture is the only carrier", async () => {
    const nodes = await fullAxTree(cdp);
    const thAsc = axFor(nodes, await backendIdFor(cdp, "#th-asc"));
    const thDesc = axFor(nodes, await backendIdFor(cdp, "#th-desc"));
    const divAsc = axFor(nodes, await backendIdFor(cdp, "#div-asc"));

    record("aria-sort", {
      thAsc: { role: roleOf(thAsc), props: propNames(thAsc) },
      thDesc: { role: roleOf(thDesc), props: propNames(thDesc) },
      divAsc: { role: roleOf(divAsc), props: propNames(divAsc) },
    });

    // Measured 2026-08-22 (Chromium via Playwright): a sorted header's AX node
    // carries NO sort-shaped property under any name, on either markup. If a
    // Chrome upgrade ever starts emitting one, this is the spec that says the
    // DOM-capture detour in ariaSortByBackendId can be retired.
    const sortish = (node: AxNode | null) =>
      propNames(node).filter((name) => /sort/i.test(name));
    expect(roleOf(thAsc)).toBe("columnheader");
    expect(roleOf(divAsc)).toBe("columnheader");
    expect(sortish(thAsc), "native th ascending emits no sort property").toEqual([]);
    expect(sortish(thDesc), "native th descending emits no sort property").toEqual([]);
    expect(sortish(divAsc), "ARIA columnheader emits no sort property").toEqual([]);

    // Negative-control direction: the DOM side DOES carry it, which is what
    // the bridge reads instead. DOMSnapshot's attribute arrays are the exact
    // input ariaSortByBackendId parses.
    const { documents, strings } = (await cdp.send("DOMSnapshot.captureSnapshot", {
      computedStyles: [],
    } as never)) as never as {
      documents: { nodes: { backendNodeId?: number[]; attributes?: number[][] } }[];
      strings: string[];
    };
    const wanted = new Map<number, string>([
      [await backendIdFor(cdp, "#th-asc"), "ascending"],
      [await backendIdFor(cdp, "#th-desc"), "descending"],
      [await backendIdFor(cdp, "#div-asc"), "ascending"],
    ]);
    const found = new Map<number, string>();
    for (const document of documents) {
      const backendIds = document.nodes.backendNodeId ?? [];
      const attributes = document.nodes.attributes ?? [];
      for (let i = 0; i < backendIds.length; i += 1) {
        const attrs = attributes[i] ?? [];
        for (let at = 0; at + 1 < attrs.length; at += 2) {
          if (strings[attrs[at]] === "aria-sort" && wanted.has(backendIds[i])) {
            found.set(backendIds[i], strings[attrs[at + 1]]);
          }
        }
      }
    }
    record("aria-sort-dom", Object.fromEntries(found));
    expect(found, "DOMSnapshot carries the attribute the AX tree drops").toEqual(wanted);
  });

  test("an unbounded <input type=number> reports the 0/0 sentinel", async () => {
    const nodes = await fullAxTree(cdp);
    const bare = axFor(nodes, await backendIdFor(cdp, "#num-bare"));
    const bounded = axFor(nodes, await backendIdFor(cdp, "#num-bounded"));
    const authored = axFor(nodes, await backendIdFor(cdp, "#spin-authored-zero"));

    record("number-bounds", {
      bare: {
        role: roleOf(bare),
        valuemin: axPropOf(bare, "valuemin"),
        valuemax: axPropOf(bare, "valuemax"),
      },
      bounded: {
        role: roleOf(bounded),
        valuemin: axPropOf(bounded, "valuemin"),
        valuemax: axPropOf(bounded, "valuemax"),
      },
      authoredZero: {
        role: roleOf(authored),
        valuemin: axPropOf(authored, "valuemin"),
        valuemax: axPropOf(authored, "valuemax"),
      },
    });

    // The sentinel: Chrome answers "no bounds" as literal zeros, so a bare
    // number input is indistinguishable from an authored 0..0 range. That
    // indistinguishability is the evidence rangeFlags' both-zero suppression
    // rests on — there is no honest `[min 0 max 0]` to print because the wire
    // cannot say which of the two it was.
    expect(roleOf(bare)).toBe("spinbutton");
    expect(axPropOf(bare, "valuemin"), "unbounded min arrives as 0").toBe(0);
    expect(axPropOf(bare, "valuemax"), "unbounded max arrives as 0").toBe(0);
    // A real bound still arrives as itself — suppression must key on the PAIR
    // of zeros, never on either bound alone.
    expect(axPropOf(bounded, "valuemin")).toBe(3);
    expect(axPropOf(bounded, "valuemax")).toBe(9);
    expect(axPropOf(authored, "valuemin")).toBe(0);
    expect(axPropOf(authored, "valuemax")).toBe(0);
  });

  test("a <select multiple> is a focusable listbox holding its options", async () => {
    const nodes = await fullAxTree(cdp);
    const multi = axFor(nodes, await backendIdFor(cdp, "#multi"));

    const byId = new Map(nodes.map((one) => [one.nodeId, one]));
    const descendantRoles: string[] = [];
    const walk = (id: string) => {
      const child = byId.get(id);
      if (!child) return;
      descendantRoles.push(roleOf(child));
      for (const grandChild of child.childIds ?? []) walk(grandChild);
    };
    for (const childId of multi?.childIds ?? []) walk(childId);

    record("select-multiple", {
      role: roleOf(multi),
      focusable: axPropOf(multi, "focusable"),
      multiselectable: axPropOf(multi, "multiselectable"),
      descendantRoles,
    });

    // The role INTERACTIVE_ROLES must contain for the select itself to mint a
    // uid, and the descendant options select_option's collector walks from it.
    expect(roleOf(multi)).toBe("listbox");
    expect(axPropOf(multi, "focusable")).toBe(true);
    expect(descendantRoles.filter((role) => role === "option")).toHaveLength(3);
  });
});
