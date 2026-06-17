# src/server/agent — Claude notes

Agent orchestration + in-process MCP tool servers. Read with the **root [`CLAUDE.md`](../../../CLAUDE.md)**
(meta-cognition, language split, permission gate, MCP-only git) and [`../CLAUDE.md`](../CLAUDE.md). The
detailed mechanics (the prompt-section helpers, SSE/session resume, image-attachment query mode, canvas,
hex-ssh, offline test setup) live in
**[`../../../docs/ARCHITECTURE-NOTES.md`](../../../docs/ARCHITECTURE-NOTES.md) §Agent**.

Durable principles for this layer:

- **`claudeAgent.ts` is the orchestrator and re-exports the split-out symbols** (`promptBuilder.ts`,
  `sdkMessageHandlers.ts`, `preToolUseHook.ts`, `agentUtils.ts`) so importer paths stay stable. Keep the
  re-export set minimal to the original public surface.
- **`ownerState.ts` is the metacognition sync point.** `summarizeOwnerState` returns UNFORMATTED self-state
  DATA consumed by BOTH `buildPrompt` (English prompt) and `describe_system` (tool text); gating +
  formatting stay at each call site. Add a self-state fact to `OwnerState` and BOTH consumers together.
- **Every MCP tool MUST self-gate in its handler** — the `mcp__`-prefix auto-allow in the PreToolUse hook
  fires BEFORE any owner check. **Guard conventions differ per file BY DESIGN** (owner-only vs elevated vs
  group-member vs intentionally ungated); don't "normalize" them.
- **A new tool means updating BOTH `mcpServers` AND `allowedTools`** in `claudeAgent.ts` — two hand-synced
  lists. Miss one and the model either sees a tool it can't call or calls one it can't see.
- **Don't re-copy shared helpers.** `mcpTools.ts` (`text()`, `decodeRepoFsError`, `decodeExecError`) and
  `repoToolKit.ts` (the guard→resolve→ensureClone→decode skeleton) exist so the ~9 servers don't drift.
- **`agent-core.test.ts` checks the prompt with `toContain`/`not.toContain` substrings**, not byte-for-byte
  — adding a section is safe; changing an existing string (or its per-viewer presence) breaks a test.
