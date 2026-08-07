import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default time budget for an inline python3 invocation. */
const DEFAULT_PYTHON_TIMEOUT_MS = 15_000;

export interface RunPythonOptions {
  /** Process timeout in ms (default 15s). */
  timeout?: number;
  /** Max captured stdout/stderr in bytes (Node default when omitted). */
  maxBuffer?: number;
  /** Text piped to the child's stdin. SECRET VALUES MUST USE THIS, never
   *  `args`: argv is world-readable via /proc/<pid>/cmdline for the whole
   *  process lifetime, and the agent's Bash runs same-uid in this container. */
  input?: string;
}

/**
 * Run an inline python3 script (`python3 -c <code> <args…>`) and return stdout.
 *
 * Centralizes the spawn boilerplate and the image-dependency contract: the
 * Docker image must carry python3 plus the `cryptography` and `paramiko`
 * packages, which back SSH key generation and host-key fetching respectively
 * (the container has no `ssh-keygen`/`ssh-keyscan`). Callers pass the script as
 * `code` and any positional `sys.argv[1:]` values as `args`.
 */
export async function runPython(
  code: string,
  args: string[] = [],
  options: RunPythonOptions = {},
): Promise<string> {
  const pending = execFileAsync("python3", ["-c", code, ...args], {
    timeout: options.timeout ?? DEFAULT_PYTHON_TIMEOUT_MS,
    ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
  });
  if (options.input !== undefined && pending.child.stdin) {
    // Swallow stream errors (e.g. EPIPE if the child died at spawn) — the
    // awaited promise below reports the real failure.
    pending.child.stdin.on("error", () => {});
    pending.child.stdin.write(options.input);
    pending.child.stdin.end();
  }
  const { stdout } = await pending;
  return stdout;
}
