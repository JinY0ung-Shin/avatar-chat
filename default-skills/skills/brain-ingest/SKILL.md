---
name: brain-ingest
description: Capture a durable fact, decision, preference, or source into the knowledge repo's raw/ capture area, then commit. Use whenever the owner (personal repo) or a teammate working in a group repo states something worth remembering long-term. Works on the personal repo (mcp__repo__*) OR a group shared repo (mcp__group_repo__*).
---

# brain-ingest — capture into the second brain

`raw/` is the inbox for raw, timestamped capture; `wiki/` is the consolidated layer (maintained
later by brain-reflect). This skill handles the **capture** step only.

## When to use
When something durable is stated — a decision and its rationale, a stable preference, a key fact,
a useful source/link, a definition. Do NOT capture transient chit-chat or anything the speaker did
not actually say. Never invent facts.

## Scope
- **Personal repo:** `mcp__repo__write_file` then `mcp__repo__commit`.
- **Group repo:** `mcp__group_repo__write_file` then `mcp__group_repo__commit`. Group writes are
  admin-gated; if a write is denied because you are a member (not admin), do NOT retry via Bash
  and do NOT use `request_info` (it routes to your OWN owner, not the group admin) — instead tell
  the user plainly that a GROUP ADMIN must persist this note.
- **No repo connected (personal):** if a write returns `NO_REPO` and `mcp__repo__create_repo` is
  available, offer to create the knowledge repo first; otherwise ask the owner to connect one.

## Procedure
1. Write to `raw/YYYY-MM-DD-<short-slug>.md`: a one-line title, the date, the source/speaker, and
   the captured content in the speaker's intent.
2. One idea per file when practical, so brain-reflect can consolidate cleanly.
3. **Always commit** after writing — an uncommitted write is not persisted.
4. Confirm briefly what you captured and where.
