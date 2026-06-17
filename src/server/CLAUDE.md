# src/server — Claude notes

Server-area direction. Read with the **root [`CLAUDE.md`](../../CLAUDE.md)** (architecture, env,
language-split, deploy topology) and agent specifics in [`agent/CLAUDE.md`](agent/CLAUDE.md). The
detailed, change-prone mechanics (route homes, store mixins, schedule decode, repo plumbing, secret
vault, CA wiring) live in **[`../../docs/ARCHITECTURE-NOTES.md`](../../docs/ARCHITECTURE-NOTES.md) §Server**.

Durable principles for this layer:

- **`app.ts` is thin glue.** Per-domain `(deps) => Router` factories in `routes/*`, shared helpers in
  `routes/_shared.ts`. Re-exported symbols (`createApp`/`createServices`/`expandChatSlashCommand`/…) keep
  their `app.ts` import paths — don't move them. No module-level mutable state; thread it through `deps`.
- **`store.ts` is a thin barrel composed from per-domain mixins** (`store/*.ts`); the PUBLIC surface is
  unchanged (`new Store(config)` + `store.foo()`). New methods go in the matching domain mixin (or the
  shared `StoreBase` if cross-cutting). Use the shared `count()` helper; never force callers to pick a
  sub-store class.
- **Schedule math lives in ONE place** (`routineSchedule.ts`) — validation + next-run + decode. Add a
  schedule field there + `RoutineJobRow` + the decode together; don't re-derive it elsewhere.
- **Low-level git is shared** (`repoGitCore.ts` + `repoGitGuards.ts`) — the single edit point for
  git-safety. `knowledgeRepo.ts`/`groupKnowledgeRepo.ts`/`gitRepos.ts` are thin resolvers over it; keep
  them from drifting back into line-for-line mirrors.
- **`SESSION_SECRET` keys EVERY at-rest reversible secret.** Rotating it is SILENT data loss
  (`decryptSecret`→`null`, treated as "no secret"), not a crash — a deploy-migration concern.
- **`deleteUser` cascades MANUALLY** (no `ON DELETE CASCADE`). A new user-scoped table needs a matching
  `DELETE` or it orphans rows past "permanent deletion."
