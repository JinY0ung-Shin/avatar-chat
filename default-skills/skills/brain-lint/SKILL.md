---
name: brain-lint
description: Hygiene pass over the knowledge repo's wiki/ — find dangling links, stale or duplicate notes, notes missing required template fields, and orphans not listed in index.md; report and optionally fix, then commit. Works on the personal repo (mcp__repo__*) OR a group shared repo (mcp__group_repo__*).
---

# brain-lint — keep the second brain healthy

Check `wiki/` for hygiene problems and (when asked) fix them. Run on demand or after a big
brain-reflect pass.

## Scope
- **Personal repo:** read with `mcp__repo__list_files`/`read_file`; fix with
  `mcp__repo__write_file`/`move_file`/`delete_file`; then `mcp__repo__commit`.
- **Group repo:** read with `mcp__group_repo__*`. Writes are admin-only; if you are a member,
  REPORT findings only — never Bash git.

## Checks
1. **Dangling links** — links whose target note does not exist.
2. **Template drift** — notes missing `wiki/_template.md` fields (title/date/source/tags).
3. **Duplicates / near-duplicates** — propose a merge.
4. **Orphans** — notes not referenced from `wiki/index.md`.
5. **Stale notes** — superseded by a newer decision in `raw/` / `wiki/log.md`.

## Output
Report findings grouped by check. If asked to fix, apply minimal edits, keep the index in sync,
then **commit once**. Never overwrite a note's substantive content without confirmation.
