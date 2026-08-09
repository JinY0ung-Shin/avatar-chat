// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  DRAWIO_MEDIA_TYPE,
  getGraphViewer,
  isDrawioAttachment,
  loadGraphViewer,
  type GraphViewerApi,
} from "../src/client/src/lib/drawioViewer.js";

// The vendored viewer is a ~4 MB non-module global script, so the loader injects
// a real <script> tag instead of importing it. jsdom never fetches that tag
// (external resources are not loadable here), which is exactly what makes the
// load/error outcomes drivable: the tests dispatch the events the browser would.
//
// ORDER MATTERS. `pending` is a module-level memo and the module is imported
// statically (a dynamic import + vi.resetModules is not attributed by the v8
// coverage provider). Every case below except the last drives the memo back to
// null through a failure — the loader's own retry path — so the file stays
// self-consistent without reaching into module internals. The success case is
// LAST because a resolved memo is only harmless while `window.GraphViewer` is
// still set, and teardown deletes it.

const VIEWER_SRC = "/drawio/viewer-static.min.js";

/** Asset roots the loader must seed before the viewer script evaluates. */
const ASSET_ROOTS: Record<string, string> = {
  PROXY_URL: "/drawio/proxy",
  STYLE_PATH: "/drawio/styles",
  SHAPES_PATH: "/drawio/shapes",
  STENCIL_PATH: "/drawio/stencils",
  DRAW_MATH_URL: "/drawio/math",
  GRAPH_IMAGE_PATH: "/drawio/img",
  mxImageBasePath: "/drawio/mxgraph/images",
  mxBasePath: "/drawio/mxgraph",
};

const windowKeys = () => window as unknown as Record<string, unknown>;

function injectedScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>(`script[src="${VIEWER_SRC}"]`)];
}

/** The tag the loader appended most recently, to fire its load/error on. */
function latestScript(): HTMLScriptElement {
  const scripts = injectedScripts();
  expect(scripts.length).toBeGreaterThan(0);
  return scripts[scripts.length - 1];
}

describe("drawio viewer loader", () => {
  afterEach(() => {
    for (const script of injectedScripts()) script.remove();
    for (const key of ["GraphViewer", ...Object.keys(ASSET_ROOTS)]) delete windowKeys()[key];
  });

  it("isDrawioAttachment keys on the media type alone", () => {
    expect(DRAWIO_MEDIA_TYPE).toBe("application/vnd.jgraph.mxfile");
    expect(isDrawioAttachment({ mediaType: DRAWIO_MEDIA_TYPE })).toBe(true);
    // A .drawio name without the server-assigned media type is NOT a diagram:
    // publishWorkspaceFile always stamps the type, so there is no name fallback.
    expect(isDrawioAttachment({ mediaType: "text/plain" })).toBe(false);
    expect(isDrawioAttachment({})).toBe(false);
  });

  it("getGraphViewer reports null until the script defines the global", () => {
    expect(getGraphViewer()).toBeNull();
    const api: GraphViewerApi = { createViewerForElement: () => {} };
    window.GraphViewer = api;
    expect(getGraphViewer()).toBe(api);
  });

  it("injects one script for concurrent callers and rejects both when it fails to load", async () => {
    const first = loadGraphViewer();
    const second = loadGraphViewer();
    // Single-flight: the second caller rides the first promise instance.
    expect(second).toBe(first);
    expect(injectedScripts()).toHaveLength(1);
    expect(latestScript().async).toBe(true);

    const rejected = Promise.all([
      expect(first).rejects.toThrow("failed to load /drawio/viewer-static.min.js"),
      expect(second).rejects.toThrow("failed to load /drawio/viewer-static.min.js"),
    ]);
    latestScript().dispatchEvent(new Event("error"));
    await rejected;

    // The dead tag is pulled, so a retry starts from a clean <head>.
    expect(injectedScripts()).toHaveLength(0);
  });

  it("retries on the next open when the script loads without defining GraphViewer", async () => {
    const attempt = loadGraphViewer();
    const failed = expect(attempt).rejects.toThrow(
      "drawio viewer script loaded but GraphViewer is missing",
    );
    latestScript().dispatchEvent(new Event("load"));
    await failed;

    // The memo is cleared even on this "200 but truncated" outcome, so the next
    // open really re-fetches instead of re-rejecting off the cached promise.
    const retry = loadGraphViewer();
    expect(retry).not.toBe(attempt);
    expect(injectedScripts()).toHaveLength(2);

    const retryFailed = expect(retry).rejects.toThrow("failed to load");
    latestScript().dispatchEvent(new Event("error"));
    await retryFailed;
  });

  it("seeds every asset root same-origin and never overwrites a pre-set value", async () => {
    windowKeys().STENCIL_PATH = "/custom/stencils";
    const attempt = loadGraphViewer();
    const failed = expect(attempt).rejects.toThrow("failed to load");

    // `??=`, so an already-configured root survives.
    expect(windowKeys().STENCIL_PATH).toBe("/custom/stencils");
    for (const [key, expected] of Object.entries(ASSET_ROOTS)) {
      if (key === "STENCIL_PATH") continue;
      expect(windowKeys()[key]).toBe(expected);
      // Same-origin is the whole point: the viewer's own defaults point at
      // diagrams.net, which the app CSP would block. Missing local assets 404
      // and degrade a shape; a remote default would break the panel outright.
      expect(String(windowKeys()[key]).startsWith("/drawio/")).toBe(true);
    }

    latestScript().dispatchEvent(new Event("error"));
    await failed;
  });

  // Keep LAST: leaves the module memo resolved (see the header note).
  it("resolves the viewer global on load and skips the network on later opens", async () => {
    const api: GraphViewerApi = { createViewerForElement: () => {} };
    const pending = loadGraphViewer();
    expect(injectedScripts()).toHaveLength(1);

    // The real script defines the global as it evaluates, before onload fires.
    window.GraphViewer = api;
    latestScript().dispatchEvent(new Event("load"));
    await expect(pending).resolves.toBe(api);
    expect(getGraphViewer()).toBe(api);

    // A later preview reuses the loaded global — no second tag, no second fetch.
    await expect(loadGraphViewer()).resolves.toBe(api);
    expect(injectedScripts()).toHaveLength(1);
  });
});
