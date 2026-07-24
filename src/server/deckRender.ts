import { spawnSync } from "node:child_process";
import logger from "./logger.js";

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
  const soffice = commandWorks("soffice", ["--version"]);
  const pdftoppm = commandWorks("pdftoppm", ["-v"]);
  const pythonPptx = commandWorks("python3", ["-c", "import pptx"]);
  cached = soffice && pdftoppm && pythonPptx;
  logger
    .child({ module: "deck-render" })
    .info({ soffice, pdftoppm, pythonPptx, available: cached }, "deck rendering probe");
  return cached;
}

/** Test hook: override or clear (null) the memoized probe result. */
export function __setDeckRenderingForTests(value: boolean | null): void {
  cached = value;
}
