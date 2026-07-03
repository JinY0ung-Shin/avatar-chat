// PostToolUse hook: redact secret VALUES from tool outputs before the model
// sees them.
//
// With per-key shell exposure (secretPolicy + `user_secrets.shell_expose`),
// secret values can legitimately appear in tool output — `echo $MY_API_KEY`,
// an API error echoing the token, an MCP server logging its env. The SDK's
// PostToolUse `updatedToolOutput` replaces the tool result before it reaches
// the model, so values never enter the model context, the stored transcript,
// or the visible chat. This is ACCIDENT-PREVENTION, not containment: a model
// that can use a secret can also transform it (base64, split) past a literal
// replace — the real boundary is which keys the owner exposes at all.

/**
 * Values shorter than this are never redacted: replacing every occurrence of
 * a 2-character secret would shred unrelated output (false positives) while
 * providing no real secrecy anyway.
 */
export const MIN_REDACT_VALUE_LENGTH = 6;

/**
 * Replace every occurrence of each secret VALUE (length ≥ MIN) in the given
 * tool output with `[REDACTED:<NAME>]`, walking strings inside arrays/objects.
 * Returns the (possibly new) value plus whether anything changed — unchanged
 * structures are returned as-is so the hook can skip `updatedToolOutput`.
 */
export function redactSecretValues(
  value: unknown,
  secrets: Record<string, string>,
): { value: unknown; changed: boolean } {
  // Longest value first so an overlapping shorter secret can't split a longer
  // one into un-redacted fragments.
  const entries = Object.entries(secrets)
    .filter(([, v]) => typeof v === "string" && v.length >= MIN_REDACT_VALUE_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) {
    return { value, changed: false };
  }
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      let out = node;
      for (const [name, secret] of entries) {
        if (out.includes(secret)) {
          out = out.split(secret).join(`[REDACTED:${name}]`);
          changed = true;
        }
      }
      return out;
    }
    if (Array.isArray(node)) {
      const mapped = node.map(walk);
      return mapped.some((v, i) => v !== node[i]) ? mapped : node;
    }
    if (node && typeof node === "object") {
      const src = node as Record<string, unknown>;
      let mutated = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(src)) {
        const w = walk(v);
        out[k] = w;
        if (w !== v) mutated = true;
      }
      return mutated ? out : node;
    }
    return node;
  };
  const result = walk(value);
  return { value: result, changed };
}

type PostToolUseHookOutput = {
  hookSpecificOutput?: {
    hookEventName: "PostToolUse";
    updatedToolOutput?: unknown;
  };
};

/**
 * Build the PostToolUse hook. Registered whenever a run carries injectable
 * secret values (shell-exposed and/or plugin-MCP-injected) so any tool output
 * that echoes a value comes back `[REDACTED:<NAME>]`. Non-matching outputs
 * return `{}` (no-op) — the SDK keeps the original result untouched.
 */
export function buildPostToolUseHook(secrets: Record<string, string>) {
  return async (input: unknown): Promise<PostToolUseHookOutput> => {
    const record = input as Record<string, unknown> | null;
    if (!record || typeof record !== "object") {
      return {};
    }
    const { value, changed } = redactSecretValues(record.tool_response, secrets);
    if (!changed) {
      return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: value,
      },
    };
  };
}
