import { describe, expect, it, vi } from "vitest";
import * as vega from "vega";
import * as vegaLite from "vega-lite";
import { expressionInterpreter } from "vega-interpreter";
import { assertInlineOnlyVegaSpec, createInlineOnlyVegaLoader } from "../src/client/src/lib/vegaCanvas.js";

async function renderWithInlineOnlyLoader(spec: Record<string, unknown>): Promise<string> {
  assertInlineOnlyVegaSpec(spec);
  const vgSpec = vegaLite.compile(spec as any).spec;
  const runtime = vega.parse(vgSpec as any, null as any, { ast: true } as any);
  const view = new vega.View(runtime, {
    expr: expressionInterpreter,
    renderer: "svg",
    loader: createInlineOnlyVegaLoader(vega),
  } as any);
  try {
    return await view.toSVG();
  } finally {
    view.finalize();
  }
}

describe("client Vega canvas renderer", () => {
  it("renders inline Vega-Lite data to SVG", async () => {
    const svg = await renderWithInlineOnlyLoader({
      data: { values: [{ label: "A", value: 3 }] },
      mark: "bar",
      encoding: {
        x: { field: "label", type: "nominal" },
        y: { field: "value", type: "quantitative" },
      },
    });

    expect(svg).toContain("<svg");
  });

  it("allows inline data rows with ordinary url fields", async () => {
    const svg = await renderWithInlineOnlyLoader({
      data: { values: [{ label: "A", value: 3, url: "/not-loaded" }] },
      mark: "text",
      encoding: {
        text: { field: "url" },
      },
    });

    expect(svg).toContain("/not-loaded");
  });

  it("rejects URL-backed Vega-Lite data without calling browser fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not run"));

    try {
      await expect(
        renderWithInlineOnlyLoader({
          data: { url: "/api/private.csv", format: { type: "csv" } },
          mark: "bar",
          encoding: {
            x: { field: "label", type: "nominal" },
            y: { field: "value", type: "quantitative" },
          },
        }),
      ).rejects.toThrow("URL-backed data");

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects URL and href encoding channels", () => {
    expect(() =>
      assertInlineOnlyVegaSpec({
        data: { values: [{ label: "A", image: "/api/image" }] },
        mark: "image",
        encoding: { url: { field: "image" } },
      }),
    ).toThrow("encoding.url");

    expect(() =>
      assertInlineOnlyVegaSpec({
        data: { values: [{ label: "A", href: "/api/page" }] },
        mark: "point",
        encoding: { href: { field: "href" } },
      }),
    ).toThrow("encoding.href");
  });
});
