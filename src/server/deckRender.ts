import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logger from "./logger.js";

const execFileAsync = promisify(execFile);
const deckLogger = logger.child({ module: "deck-render" });

/**
 * Deployment-level probe for the PPTX deck toolchain the bundled `pptx` skill
 * drives from the agent shell: LibreOffice (`soffice`, pptx→pdf), poppler's
 * `pdftoppm` (pdf→slide PNGs), and the `python-pptx` library (deck authoring).
 * All three ship in the Docker image; a dev machine usually has none, and an
 * older deployed image may miss them — then the feature must degrade to an
 * honest "unavailable" in the standing prompt and `describe_system` instead of
 * letting the avatar walk into shell errors.
 *
 * Probed ONCE per process (memoized): the result cannot change without a
 * container rebuild, and `spawnSync` per turn would be wasted latency. This is
 * deliberately NOT owner state (`ownerState.ts`) — it is a per-deployment fact,
 * threaded per-run like `fileOutputEnabled` (see `claudeAgent.ts`).
 */

const PROBE_TIMEOUT_MS = 5_000;

let cached: boolean | null = null;

function commandWorks(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
  });
  return !result.error && result.status === 0;
}

/** True when soffice + pdftoppm + python-pptx are all usable in this deployment. */
export function probeDeckRendering(): boolean {
  if (cached !== null) return cached;
  // `-env:UserInstallation` points soffice at a throwaway profile dir so the
  // probe doesn't trigger the slow, HOME-writability-dependent default-profile
  // init (which can blow the 5s timeout and wrongly memoize `false`).
  const sofficeProfile = path.join(os.tmpdir(), "noah-soffice-probe");
  const soffice = commandWorks("soffice", [
    `-env:UserInstallation=file://${sofficeProfile}`,
    "--version",
  ]);
  const pdftoppm = commandWorks("pdftoppm", ["-v"]);
  const pythonPptx = commandWorks("python3", ["-c", "import pptx"]);
  cached = soffice && pdftoppm && pythonPptx;
  deckLogger.info(
    { soffice, pdftoppm, pythonPptx, available: cached },
    "deck rendering probe",
  );
  return cached;
}

/** Test hook: override or clear (null) the memoized probe result. */
export function __setDeckRenderingForTests(value: boolean | null): void {
  cached = value;
}

/** Document types the server can rasterize into page previews. */
export const PREVIEWABLE_EXTENSIONS = ["pptx", "docx", "xlsx", "pdf"] as const;

export function isPreviewableExtension(ext: string): boolean {
  return (PREVIEWABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/** Cap on auto-rendered preview pages (matches the hidden-publish budget). */
export const MAX_PREVIEW_PAGES = 30;

/** Per-stage (soffice / pdftoppm) time budget for an auto-render. */
const RENDER_STAGE_TIMEOUT_MS = 120_000;

/**
 * Order pdftoppm outputs numerically: it emits `slide-1.png`…`slide-10.png`
 * for short docs but zero-pads (`slide-01.png`) for longer ones, so a plain
 * lexicographic sort would interleave pages. Exported for tests.
 */
export function sortSlideFiles(names: string[]): string[] {
  const pageNo = (name: string) => {
    const match = /-(\d+)\.png$/i.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  return [...names].sort((a, b) => pageNo(a) - pageNo(b));
}

/**
 * Rasterize a stored document into per-page PNG buffers (page order), fully
 * SERVER-SIDE — the agent never has to render/publish slides itself. pdf goes
 * straight through pdftoppm; office formats convert to pdf first via a
 * profile-isolated headless soffice (parallel conversions would otherwise
 * fight over the shared profile lock). Returns [] when the toolchain is
 * missing or anything fails — callers treat previews as best-effort.
 */
export async function renderDocumentPreviews(
  sourcePath: string,
  ext: string,
): Promise<Buffer[]> {
  if (!probeDeckRendering() || !isPreviewableExtension(ext)) {
    return [];
  }
  let workDir: string | null = null;
  try {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "deck-preview-"));
    let pdfPath = sourcePath;
    if (ext.toLowerCase() !== "pdf") {
      await execFileAsync(
        "soffice",
        [
          "--headless",
          "--norestore",
          `-env:UserInstallation=file://${workDir}/lo-profile`,
          "--convert-to",
          "pdf",
          "--outdir",
          workDir,
          sourcePath,
        ],
        { timeout: RENDER_STAGE_TIMEOUT_MS },
      );
      const base = path.basename(sourcePath);
      pdfPath = path.join(workDir, `${base.slice(0, base.lastIndexOf("."))}.pdf`);
    }
    await fs.promises.access(pdfPath);
    await execFileAsync(
      "pdftoppm",
      ["-png", "-r", "120", "-l", String(MAX_PREVIEW_PAGES), pdfPath, path.join(workDir, "slide")],
      { timeout: RENDER_STAGE_TIMEOUT_MS },
    );
    const entries = await fs.promises.readdir(workDir);
    const slides = sortSlideFiles(entries.filter((name) => /^slide-\d+\.png$/i.test(name))).slice(
      0,
      MAX_PREVIEW_PAGES,
    );
    const buffers: Buffer[] = [];
    for (const name of slides) {
      buffers.push(await fs.promises.readFile(path.join(workDir, name)));
    }
    return buffers;
  } catch (err) {
    deckLogger.warn({ err, sourcePath, ext }, "document preview render failed");
    return [];
  } finally {
    if (workDir) {
      fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
