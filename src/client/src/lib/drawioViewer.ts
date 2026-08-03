/**
 * On-demand loader for the vendored draw.io viewer (`public/drawio/`, see its
 * README for provenance/upgrade). The viewer is a ~4 MB non-module global
 * script, so it is deliberately NOT part of the Vite bundle: the first .drawio
 * preview injects a same-origin <script> tag instead. This stays inside the
 * app CSP — `script-src 'self'` allows the tag and the viewer needs no
 * `unsafe-eval`; every asset root below points same-origin, so the viewer's
 * OWN asset loading stays local (missing assets 404 and the affected shapes
 * degrade to labeled placeholders). Diagram-AUTHORED external references
 * (e.g. `fontSource=` styles → Google Fonts) are stopped by the app CSP
 * (`style-src`/`font-src`/`img-src` 'self'), not by these paths — remember
 * that before ever relaxing those directives (app.ts) for other features.
 */

/**
 * Media type `chatFiles.ts` assigns to shared .drawio attachments. Hand-mirrors
 * the server's `DRAWIO_MEDIA_TYPE` (no shared client↔server runtime module —
 * update in lockstep).
 */
export const DRAWIO_MEDIA_TYPE = "application/vnd.jgraph.mxfile";

/** The slice of the viewer's global API the preview panel uses. */
export interface GraphViewerApi {
  /** Render the element's `data-mxgraph` JSON config into it. */
  createViewerForElement: (el: Element) => void;
}

declare global {
  interface Window {
    GraphViewer?: GraphViewerApi;
    // Asset roots the viewer script reads at evaluation time (defaults point
    // at diagrams.net, which the CSP would block — and must stay unused).
    PROXY_URL?: string;
    STYLE_PATH?: string;
    SHAPES_PATH?: string;
    STENCIL_PATH?: string;
    DRAW_MATH_URL?: string;
    GRAPH_IMAGE_PATH?: string;
    mxImageBasePath?: string;
    mxBasePath?: string;
  }
}

let pending: Promise<GraphViewerApi> | null = null;

/** Viewer global once loaded, else null (paint paths that can't await). */
export function getGraphViewer(): GraphViewerApi | null {
  return window.GraphViewer ?? null;
}

/**
 * Load the viewer script once and resolve its global. Safe to call repeatedly;
 * a network failure clears the memo so the next open can retry.
 */
export function loadGraphViewer(): Promise<GraphViewerApi> {
  const loaded = getGraphViewer();
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  // Must be set BEFORE the script evaluates its `window.X ||= <diagrams.net>`
  // defaults. Only /drawio/stencils actually exists (vendored subset).
  window.PROXY_URL ??= "/drawio/proxy";
  window.STYLE_PATH ??= "/drawio/styles";
  window.SHAPES_PATH ??= "/drawio/shapes";
  window.STENCIL_PATH ??= "/drawio/stencils";
  window.DRAW_MATH_URL ??= "/drawio/math";
  window.GRAPH_IMAGE_PATH ??= "/drawio/img";
  window.mxImageBasePath ??= "/drawio/mxgraph/images";
  window.mxBasePath ??= "/drawio/mxgraph";
  pending = new Promise<GraphViewerApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/drawio/viewer-static.min.js";
    script.async = true;
    script.onload = () => {
      const viewer = getGraphViewer();
      if (viewer) {
        resolve(viewer);
      } else {
        // e.g. a truncated asset that still 200s — clear the memo so the next
        // open retries instead of rejecting forever off this cached promise.
        pending = null;
        reject(new Error("drawio viewer script loaded but GraphViewer is missing"));
      }
    };
    script.onerror = () => {
      pending = null;
      script.remove();
      reject(new Error("failed to load /drawio/viewer-static.min.js"));
    };
    document.head.append(script);
  });
  return pending;
}

/**
 * Whether a shared-file attachment should render as a draw.io diagram. Keyed on
 * the media type alone: `publishWorkspaceFile` always sets it from the extension
 * allowlist, so a filename fallback would be dead code.
 */
export function isDrawioAttachment(att: { mediaType?: string }): boolean {
  return att.mediaType === DRAWIO_MEDIA_TYPE;
}
