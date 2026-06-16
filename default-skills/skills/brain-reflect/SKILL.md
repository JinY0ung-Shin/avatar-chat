---
name: brain-reflect
description: Consolidation pass over a knowledge repo — synthesize durable notes into wiki/{sources,entities,concepts,synthesis}/, update wiki/index.md and append wiki/log.md, then commit. Personal scope reads raw/ + wiki/ and may optionally review the owner's own recent conversations; group scope reads ONLY the group's raw/ + wiki/ and never conversations.
---

# brain-reflect — consolidate the second brain

Move durable knowledge from `raw/` capture into the consolidated `wiki/`. Run on demand or when
asked to "tidy up / consolidate my notes".

## Privacy boundary (read this first)
- **Personal repo:** read `raw/` and `wiki/`; optionally review the owner's OWN recent
  conversations with the owner-scoped system tools described below.
- For a GROUP repo there is no shared group conversation stream, and reading members' individual
  conversations would violate their privacy — read ONLY the group repo's `raw/` and `wiki/`.

## Scope
- **Personal repo:** `mcp__repo__list_files`/`read_file`/`write_file`/`commit`.
- **Group repo:** pick the group with `mcp__group_repo__list_groups`; read with
  `mcp__group_repo__read_file`/`list_files`. Write/commit require group ADMIN role; if you are only
  a member, summarize proposed changes for an admin instead of writing.

## Personal scope only — optional conversation pull
For the PERSONAL repo you MAY also review the owner's OWN recent conversations to mine durable facts
worth consolidating (this is the nightly conversation-reflection source):
`mcp__system__list_recent_conversations` (e.g. `sinceHours: 24`) then `mcp__system__read_conversation`
per id. Both are owner-scoped — they return nothing for conversations the owner does not own. The
GROUP branch above must NEVER do this: there is no shared group conversation stream, and reading
members' individual conversations would violate their privacy.

## Procedure (mem0-style: ADD / UPDATE / NOOP, prune the stale)
1. List and read `raw/` (and the existing `wiki/`).
2. Synthesize into `wiki/` using `wiki/_template.md`, filing under `sources/` (links/docs),
   `entities/` (people/projects/systems), `concepts/` (definitions/decisions), `synthesis/`
   (cross-cutting connections — the highest-value notes).
3. **Append-or-update, never mass-rewrite.** One fact, one home: UPDATE the existing note instead
   of forking a near-duplicate. Remove notes superseded by a newer decision.
4. Update `wiki/index.md` and APPEND a dated entry to `wiki/log.md` summarizing adds/updates/deletes.
5. Optionally archive raw notes you fully consolidated.
6. **Commit once.** For group scope, if a write is denied (member, not admin), report findings —
   do not retry via Bash.
