import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type CDPSession, type Page } from "@playwright/test";
// Kept on ONE line: @ts-expect-error only covers the line after it, and the error
// is raised on the module specifier — the LAST line of a wrapped import.
// @ts-expect-error — plain JS module that ships inside the extension bundle.
import { axValueAnswer } from "../../extension/axtree.js";

// EMPIRICAL evidence for the browser bridge's clearing ladder
// (extension/background.js: resolveValueNode / clearAndWrite).
//
// The field bug this pins: on map.naver.com's React combobox, a
// type("성남", clear: true) against "광교카페거리성남" produced
// "광교카페거리성남성남" — the select-all was ignored, so the replacement became
// an append — and the tool reported plain success three times running. Nothing
// in CI could see it, because nothing in CI drove a CONTROLLED input over raw
// CDP. This spec does, against `fixtures/controlled-input.html`, which emulates
// the class in vanilla JS (page state is the only writer of `input.value`) in two
// variants: `plain`, and `guarded`, which additionally preventDefault()s
// ctrl/cmd+A on keydown.
//
// OBSERVED MATRIX (headless Chromium 143, Linux, Playwright 1.61 — re-run with
// `node tests/run-visual.mjs clear-ladder` after touching any rung):
//
//   rung                                         | plain    | guarded
//   ---------------------------------------------+----------+---------
//   none  insertText only (the baseline bug)      | APPENDED | APPENDED
//   A     rawKeyDown commands:["selectAll"] + ins | cleared  | APPENDED
//   B     imeSetComposition replacement + commit  | cleared  | cleared
//   C     End + Backspace×len + insert            | cleared  | cleared
//
// So: rung A is real but defeatable (a page that consumes the keydown keeps its
// value); rungs B and C both survive a controlled input that ignores the
// shortcut. Ladder order A → B → C therefore holds — A stays first because it is
// what a person does and costs one round trip, B before C because it is one pair
// of CDP calls instead of one per character. The rows for `guarded` are the whole
// reason the ladder exists at all.
//
// Two more findings encoded below, both load-bearing for the value-node
// resolution the ladder reads through — and checked through the bridge's OWN
// parser (`axtree.js` `axValueAnswer`, imported here) rather than a copy of it,
// so real Chrome output is what the shipped code is measured against:
//   * Chrome OMITS the AX `value` property entirely on an EMPTY text field, so
//     "no value property" cannot by itself mean unreadable — that naive rule
//     would flag every clear of an empty field as unverifiable. What separates
//     the two is the `editable` property (`plaintext`/`richtext`): present on
//     every textbox / textarea / contenteditable whether or not it holds text.
//   * The role="combobox" WRAPPER around the input has NEITHER — no value and no
//     `editable`. Reading it is exactly how verification silently disarmed in the
//     field (`""` read as "the field is empty"), and walking
//     DOM.describeNode(depth:-1, pierce:true) to the first
//     INPUT/TEXTAREA/[contenteditable] descendant recovers a readable node.

/** MODIFIER_BITS.Control — the select-all modifier on Linux/Windows. */
const CONTROL = 2;

const NEW_VALUE = "성남";

type Ref = { backendNodeId: number };

async function refFor(cdp: CDPSession, selector: string): Promise<Ref> {
  const { root } = await cdp.send("DOM.getDocument", { depth: 1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return { backendNodeId: node.backendNodeId as number };
}

type AxNode = {
  backendDOMNodeId?: number;
  value?: { value?: unknown };
  properties?: { name?: string }[];
};

async function axNodeFor(cdp: CDPSession, ref: Ref): Promise<AxNode | null> {
  const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
    backendNodeId: ref.backendNodeId,
    fetchRelatives: false,
  });
  const list = (Array.isArray(nodes) ? nodes : []) as AxNode[];
  return list.find((n) => n.backendDOMNodeId === ref.backendNodeId) ?? list[0] ?? null;
}

/**
 * The bridge's OWN parser (`axtree.js`), fed real Chrome output — not a copy that
 * could drift from it. null means UNREADABLE, "" means empty.
 */
async function readAxValue(cdp: CDPSession, ref: Ref): Promise<string | null> {
  return axValueAnswer(await axNodeFor(cdp, ref)) as string | null;
}

/** background.js insertValue: an IME commit for non-ASCII, a plain insert otherwise. */
async function insertValue(cdp: CDPSession, value: string): Promise<void> {
  if (/[^\x00-\x7F]/.test(value)) {
    await cdp.send("Input.imeSetComposition", {
      text: value,
      selectionStart: value.length,
      selectionEnd: value.length,
    });
  }
  await cdp.send("Input.insertText", { text: value });
}

async function pressKey(cdp: CDPSession, key: string, code: string, vk: number): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: vk,
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
}

/** Rung A: the platform shortcut carrying Blink's own selectAll editor command. */
async function rungA(cdp: CDPSession, value: string): Promise<void> {
  const key = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 };
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: CONTROL,
    ...key,
    commands: ["selectAll"],
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: CONTROL, ...key });
  if (value) await insertValue(cdp, value);
  else await pressKey(cdp, "Delete", "Delete", 46);
}

/** Rung B: IME replacement range — no selection, no keymap, real input events. */
async function rungB(cdp: CDPSession, value: string, current: string): Promise<void> {
  await cdp.send("Input.imeSetComposition", {
    text: value,
    selectionStart: value.length,
    selectionEnd: value.length,
    // DOM text offsets are UTF-16 code units, so `.length` is the right count.
    replacementStart: 0,
    replacementEnd: current.length,
  });
  await cdp.send("Input.insertText", { text: value });
}

/** Rung C: what a person does when the shortcut is ignored. */
async function rungC(cdp: CDPSession, value: string, current: string): Promise<void> {
  await pressKey(cdp, "End", "End", 35);
  // Code points, not UTF-16 units: over-counting is harmless (Backspace on an
  // empty field is a no-op), under-counting would leave the old value behind.
  for (let i = 0; i < [...current].length; i += 1) {
    await pressKey(cdp, "Backspace", "Backspace", 8);
  }
  if (value) await insertValue(cdp, value);
}

type Outcome = { dom: string; state: string; ax: string | null };

async function readBack(page: Page, cdp: CDPSession, id: string, ref: Ref): Promise<Outcome> {
  // The same 150ms VALUE_SETTLE_MS the bridge waits before believing a read.
  await page.waitForTimeout(150);
  return {
    dom: await page.evaluate((which) => window.__fixture.dom(which), id),
    state: await page.evaluate((which) => window.__fixture.state(which), id),
    ax: await readAxValue(cdp, ref),
  };
}

declare global {
  interface Window {
    __fixture: {
      start: string;
      state: (id: string) => string;
      dom: (id: string) => string;
      reset: (id: string, text?: string) => void;
    };
  }
}

test.describe("browser bridge clearing ladder (empirical)", () => {
  let cdp: CDPSession;

  test.beforeEach(async ({ page }) => {
    const fixture = path.join(path.dirname(test.info().file), "fixtures/controlled-input.html");
    await page.goto(pathToFileURL(fixture).href);
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Accessibility.enable");
  });

  test("empty field vs unreadable wrapper are separable, and the wrapper resolves", async ({
    page,
  }) => {
    const filled = await refFor(cdp, "#plain");
    const empty = await refFor(cdp, "#pristine");
    const wrapper = await refFor(cdp, "#wrap-plain");

    // The raw node shapes, because the whole distinction rests on them: Chrome
    // OMITS `value` on an empty field, so a reader that only looks at `value`
    // answers "" for BOTH an empty field and an unreadable wrapper — and ""
    // walks straight into `clearFailed`'s `if (!old) return false`, which is how
    // verification disarmed itself in the field.
    const editable = (node: AxNode | null) =>
      (node?.properties ?? []).some((p) => p.name === "editable");
    expect((await axNodeFor(cdp, filled))?.value).toBeTruthy();
    expect((await axNodeFor(cdp, empty))?.value).toBeUndefined();
    expect((await axNodeFor(cdp, wrapper))?.value).toBeUndefined();
    // `editable` is what separates them: on both real fields, never on the wrapper.
    expect(editable(await axNodeFor(cdp, filled))).toBe(true);
    expect(editable(await axNodeFor(cdp, empty))).toBe(true);
    expect(editable(await axNodeFor(cdp, wrapper))).toBe(false);

    // So the bridge's reader answers text / "" / null — three distinct answers.
    expect(await readAxValue(cdp, filled)).toBe(await page.evaluate(() => window.__fixture.start));
    expect(await readAxValue(cdp, empty)).toBe("");
    expect(await readAxValue(cdp, wrapper)).toBeNull();

    // resolveValueNode's recovery walk: describeNode's subtree holds the INPUT.
    const { node } = await cdp.send("DOM.describeNode", {
      backendNodeId: wrapper.backendNodeId,
      depth: -1,
      pierce: true,
    });
    const found: number[] = [];
    const walk = (n: typeof node): void => {
      if (n.nodeName === "INPUT" || n.nodeName === "TEXTAREA") found.push(n.backendNodeId as number);
      for (const child of n.children ?? []) walk(child);
      for (const root of n.shadowRoots ?? []) walk(root);
    };
    walk(node);
    expect(found.length).toBeGreaterThan(0);
    expect(await readAxValue(cdp, { backendNodeId: found[0] })).toBe(
      await page.evaluate(() => window.__fixture.start),
    );
  });

  test("each rung against both controlled variants", async ({ page }) => {
    const start = await page.evaluate(() => window.__fixture.start);
    const matrix: Record<string, Record<string, string>> = {};

    for (const rung of ["none", "A", "B", "C"] as const) {
      matrix[rung] = {};
      for (const id of ["plain", "guarded"] as const) {
        await page.evaluate((which) => window.__fixture.reset(which), id);
        const ref = await refFor(cdp, `#${id}`);
        await cdp.send("DOM.focus", { backendNodeId: ref.backendNodeId });
        // The caret starts where a fresh focus puts it; drive the field the way
        // the bridge does, from whatever the AX tree says is in there.
        const current = (await readAxValue(cdp, ref)) ?? "";
        expect(current).toBe(start);

        if (rung === "none") await insertValue(cdp, NEW_VALUE);
        else if (rung === "A") await rungA(cdp, NEW_VALUE);
        else if (rung === "B") await rungB(cdp, NEW_VALUE, current);
        else await rungC(cdp, NEW_VALUE, current);

        const outcome = await readBack(page, cdp, id, ref);
        // The page's own model and the DOM must agree either way: a rung that
        // only wrote the DOM would be reverted by the fixture's next render, and
        // reporting that as a clear is the failure mode under test.
        expect(outcome.dom, `${rung}/${id} dom vs state`).toBe(outcome.state);
        expect(outcome.ax, `${rung}/${id} ax vs dom`).toBe(outcome.dom);
        matrix[rung][id] =
          outcome.dom === NEW_VALUE
            ? "cleared"
            : outcome.dom.includes(start)
              ? "APPENDED"
              : `other:${outcome.dom}`;
      }
    }

    // eslint-disable-next-line no-console
    console.log("clear-ladder matrix:", JSON.stringify(matrix, null, 2));
    test.info().attach("clear-ladder-matrix", { body: JSON.stringify(matrix, null, 2) });

    // The baseline reproduces the field bug on BOTH variants: a bare insert
    // appends, which is what silently shipped as success.
    expect(matrix.none).toEqual({ plain: "APPENDED", guarded: "APPENDED" });
    // Rung A works — until the page consumes the keydown that carries the
    // editor command. That single cell is why rungs B and C exist.
    expect(matrix.A).toEqual({ plain: "cleared", guarded: "APPENDED" });
    // Both fallbacks clear a controlled input that ignores the shortcut.
    expect(matrix.B).toEqual({ plain: "cleared", guarded: "cleared" });
    expect(matrix.C).toEqual({ plain: "cleared", guarded: "cleared" });
  });

  test("an EMPTY target value empties the field on both fallbacks", async ({ page }) => {
    // `clear` with an empty value means "empty this field", and each rung has to
    // reach empty on its own terms: A overtypes nothing so it presses Delete, B
    // composes the empty string over the whole range, C just erases.
    for (const rung of ["B", "C"] as const) {
      await page.evaluate(() => window.__fixture.reset("guarded"));
      const ref = await refFor(cdp, "#guarded");
      await cdp.send("DOM.focus", { backendNodeId: ref.backendNodeId });
      const current = (await readAxValue(cdp, ref)) ?? "";
      if (rung === "B") await rungB(cdp, "", current);
      else await rungC(cdp, "", current);
      const outcome = await readBack(page, cdp, "guarded", ref);
      expect(outcome.dom, `${rung} empty-value dom`).toBe("");
      expect(outcome.state, `${rung} empty-value state`).toBe("");
    }
  });
});
