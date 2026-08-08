# Avatar collaboration — consultation and skill sharing

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> `mcp__avatars__ask_avatar`, `mcp__skill_exchange__*`, and the shared helpers both reuse.

## Avatar consultation (`mcp__avatars__ask_avatar`, #ask-avatar)

- **What it is:** an OWNER-DRIVEN turn (owner chat or owner routine) may ask a **same-group teammate's
  avatar** one question and get its answer back as tool text. Core in `agent/avatarAsk.ts`
  (`askAvatar`), tool + outcome decoding beside `search_avatars` in `avatarDirectoryTools.ts` (same
  `avatars` server + tool group).
- **Gates (in order):** `store.getUserByUsername` → self-refusal → `resolveChatAvatar` (visibility:
  unknown, `private`, group-invisible, and suspended all return the SAME `not_found` so the tool can't
  probe existence) → `isTrustedFor` (= `shareAnyGroup`, the single trust choke point). So a consult
  grants exactly what the asking USER could already get by chatting with that avatar directly — no new
  trust surface.
- **The inner run is the trusted-colleague viewer class**, constructed only in `avatarAsk.ts`:
  `viewerIsOwner: false, elevated: true, headless: true, allowHeadlessTools: true` — `allowHeadlessTools`
  only lifts the headless read-restriction so the target's second-brain recall registers; owner-only
  tools stay locked because `viewerIsOwner` is false (combo pinned in `deriveAgentToolAccess` tests).
  Plus `mcpToolGroups: ["personal_knowledge"]` (recall + `request_info` — the target can escalate a true
  unknown to ITS owner with the asker attributed), the TARGET's plugin roots + knowledge memory,
  `modelFallback: true`, a 3-min wall clock (`AVATAR_ASK_TIMEOUT_MS`), an 8k-char answer cap
  (`AVATAR_ASK_ANSWER_CAP` — the answer is another user's model output entering the asker's context, so
  it's bounded like the directory bio), and the OUTER run's abort signal propagated in.
- **Machine-initiated ⇒ STRICTLY read-only, beyond what a human teammate turn gets** (`consultationRun`
  in claudeAgent.ts): the shared-account write-widening is withheld (`repoWriteAccess`'s
  `sharedAccount && elevatedToolAccess` arm adds `&& !consultationRun` — no human sees the request, so
  no unattended write+commit into a communal repo), plugin MCP servers are NOT lifted at all
  (third-party servers can't self-gate per viewer; registration is their only gate) and neither
  plugin-secret injection nor shell secret exposure happens. The target keeps skills (prompt-level) but
  answers with recall tools only; the consultation prompt branch states the read-only level and the
  `brainSection` "consultation" mode never invites capture, even on a shared account.
- **Per-turn budget:** the tool closure in `avatarDirectoryTools.ts` counts consultations and refuses
  past `AVATAR_ASK_MAX_PER_TURN` (5) — each consult is a full agent subprocess with its own model calls,
  so an unbounded loop would be a cost amplifier on the shared deployment credentials.
- **In-band error results never masquerade as answers:** `runClaudeAgent` doesn't throw on an error
  *result* — it substitutes a Korean fallback into `response.text` (`resultErrorMessage(subtype)`, or
  `EMPTY_SDK_RESPONSE_MESSAGE` for an empty success). `AgentResponse.resultError` now carries the error
  subtype (set only when nothing real streamed), and `askAvatar` maps it to a `failed` outcome — and the
  exported empty sentinel to `empty` — instead of relaying user-facing Korean as the teammate's claim.
- **Depth guard = `AgentRequest.avatarConsultation`:** set only by `askAvatar`. A consultation run never
  registers `ask_avatar` (no A→B→C chains) and takes a dedicated prompt branch — the headless
  consultation framing in `promptBuilder.ts`, NOT the routine one (which would claim owner-level
  permissions this run doesn't have).
- **Registration:** `avatarAskActive` (= `avatars` group enabled && `ownerToolAccess` &&
  `!avatarConsultation`) drives the `allowedTools` entry AND the ctx executor injection byte-identically;
  the tool joins the server's tool list only when the executor is present, and the handler still
  self-gates on `viewerIsOwner`. Timeout on a busy model returns the PARTIAL streamed text in the error.
- **Nothing persists on the target's side** — deliberate: a teammate chatting with your avatar in the UI
  leaves you no transcript either, and the intro/hashtag headless runs persist nothing. The exchange
  lives in the ASKER's conversation; durable retention is the asker's own `brain-ingest` capture (the
  success text nudges it when the asking run has a connected repo). Revisit as an `is_routine`-style
  tagged conversation if target-side auditability is ever wanted.

## Skill sharing between avatars (`mcp__skill_exchange__*` + 스킬 배우기, #skill-share)
- **What it is:** an owner shares skills FROM their knowledge repo (`skills/<slug>/` dirs); teammates
  browse them in the 스킬 배우기 left tab or via `mcp__skill_exchange__find_shared_skills`, and LEARN one —
  the server copies the directory into the learner's repo, registers it in the learner's
  `.claude-plugin/marketplace.json`, and commits+pushes with the LEARNER's identity. Share rows
  (`shared_skills`, store/avatars.ts) are METADATA SNAPSHOTS only; content is read from the sharer's
  clone at preview/learn time (`ensureClone` refresh), so learners always get the current version.
- **Version updates (전수 후 원본 변경):** every shared_skills row carries a `content_hash` (sha256 of
  the sharer's skill dir via `hashSkillDir`, origin-marker excluded), refreshed wherever the server
  touches the sharer's clone — share, owner mine reconciliation (this ALSO bumps updated_at), and
  teammate preview/learn (`setSharedSkillContentHash`, hash-only so a viewer can't reorder the owner's
  listing). Each learn writes a provenance marker `skills/<slug>/.noah-skill-origin.json`
  (owner id/@username, source skillName, source hash, learnedAt; chain-shares record their IMMEDIATE
  source). The client joins mine.origin.contentHash × listing.contentHash → "업데이트 있음" +
  업데이트 받기; the update path (`learn {updateSlug}` / `learn_skill {update:true}`) replaces the
  learner's copy IN PLACE and is authorized by the origin marker, NOT the directory name — a mismatch
  fails closed (`NOT_LEARNED_FROM_SHARE`). The MCP update resolves the learner's slug from the markers
  (0 → redirect, >1 → ambiguous, ask the user). The marker ALSO records `localHash` (the copy's own
  post-rewrite hash): an update whose copy no longer matches — i.e. the learner CUSTOMIZED it, or a
  legacy marker can't prove otherwise — throws `SKILL_LOCALLY_MODIFIED` until the caller passes
  explicit consent (`overwriteModified` on the route after a danger confirm; `overwrite_modified` on
  the MCP tool after the model asks the user). Git history retains the overwritten customization.
  UNLINK (구독 해지) is the marker's deletion: `unlinkSkillOrigin` (route `POST /api/skill-share/unlink`,
  mine-row 연결 끊기 action, `mcp__skill_exchange__unlink_skill`) commits the removal — the copy stays,
  tracking/badges stop, and re-learning the same share later is a fresh copy.
- **The feed includes the viewer's OWN shares** (route merges `listSharedSkillsByOwner` ahead of
  `listLearnableSkills`, mirroring 탐색's "나" card): that's how an owner sees their skill's 전수 count
  in context. The client badges them 나 and drops the learn button; `listLearnableSkills` itself stays
  others-only (it feeds the MCP find tool + the metacognition count).
- **Learn counts (전수된 횟수):** every successful learn inserts a `skill_learn_events` row keyed by
  (owner, skill_name) — NOT the share-row id — so counts survive unshare→re-share; recorded at the two
  call sites (route + MCP tool) AFTER copy+commit succeed. Surfaces: `SharedSkill.learnCount`
  (correlated subquery in every shared_skills SELECT), the mine view's per-skill counts
  (`skillLearnCounts` — an unshared skill keeps its history), the tab's "전수 N회" badges, find's
  `learned N×` marker, and describe_system's owner total (`OwnerState.sharedSkillLearnTotal`,
  describe_system-only like gitRepoCount). Learner ids are stored ONLY for the deleteUser cascade
  (both axes purge — product data, not an audit trail); the UI never shows who learned.
- **Reach = avatar discovery, exactly.** `LEARNABLE_SKILLS_FROM` (store/avatars.ts) mirrors
  `VISIBILITY_WHERE` minus the self-exception: not suspended + `visibility='group'` + SHARING_TEAMMATES
  co-membership. A `private` avatar's shares vanish; an `avatar_sharing`-off group grants nothing; your
  own shares are never "learnable" (managed via `listSharedSkillsByOwner`). Keep the two SQL fragments in
  lockstep.
- **Transfer plumbing lives in `skillTransfer.ts`** (server root, NOT knowledgeRepo.ts — it imports both
  knowledgeRepo and agent/skillDiscovery without cycles): `listRepoSkills` (scan `skills/<dir>/SKILL.md`),
  `copySkillDir` (lstat walk — symlinks SKIPPED never followed, 512KB/file + 4MB + 200 files + depth 8
  caps, containment via the exported `resolveInRepo`/`realpathContained`), `learnSkillIntoRepo`
  (ensureClone both → copy → rewrite identity → `ensureMarketplaceManifest` → `commitAndPush`).
  On rename the SKILL.md frontmatter `name:` AND `.claude-plugin/plugin.json` `name` are rewritten (a
  stale frontmatter name would load the skill under the OLD name and collide); a missing plugin.json is
  created (the marketplace entry is unloadable without one).
- **Message-coded errors** in the knowledgeRepo style: `SKILL_NOT_FOUND`/`SKILL_EXISTS`/`INVALID_NAME`/
  `SKILL_FILE_TOO_LARGE`/`SKILL_TOO_LARGE`/`TOO_MANY_FILES`. Decoded to Korean in `routes/skillShare.ts`
  (`LEARN_ERROR_KO`, 409 drives the client's rename flow) and to English redirects in
  `skillExchangeTools.decodeLearnError`.
- **Registration:** `skillExchangeActive` (= `avatars` group enabled && `ownerToolAccess`) drives
  `allowedTools` + `mcpServers` byte-identically; every handler ALSO self-gates on `viewerIsOwner`
  (find included — the listing is the OWNER's group view, and a trusted teammate driving this avatar has
  their own avatar for their view). Group-agent runs are excluded twice over (avatars family forced off +
  `ownerToolAccess=false`). Owner routines keep the tools.
- **Metacognition:** `OwnerState.learnableSkillCount`/`sharedSkillCount` (lazy getters) feed BOTH the
  standing prompt section (promptBuilder, inside the avatars-group block, re-deriving the registration
  gate) and `describe_system`'s "Skill exchange" line. A LEARNED skill only LOADS on the NEXT
  conversation (plugin roots mount at run start), so both surfaces + the learn tool result tell the model
  to `mcp__repo__read_file` the new SKILL.md to apply it immediately.
- **Hygiene:** `GET /api/skill-share/mine` reconciles rows against the working tree (dir gone → unshare;
  drifted name/description → re-snapshot); a learn/preview that finds the dir deleted also prunes the
  stale row; the knowledge-repo PUT clears ALL of the owner's shares on disconnect or repoint
  (`clearSharedSkills` — a same-repo re-save keeps them). `deleteUser` cascades `shared_skills` by owner
  (learned copies are FILES in learners' repos, intentionally untouched — like ask_avatar, what crossed
  the boundary belongs to the receiver).
- **Bundled/plugin skills are deliberately NOT shareable** — everyone already has the default bundle, and
  plugin skills are shared by installing the same plugin; only knowledge-repo skills (what the avatar
  authored/accumulated, incl. `scaffold_skill` output) are listed by `mine`/`share_skill`.

## Shared helpers (don't re-copy)
- **`mcpTools.ts`** — `text(message, isError?)` (the MCP result wrapper), `decodeRepoFsError`
  (INVALID_PATH/FILE_TOO_LARGE/NOT_A_FILE/SKILL_EXISTS sentinels), `decodeExecError(err, {redactToken?,
  fallback?})` (git/gh stderr + `scrubGitError`). Use these; don't reintroduce a local `text()`.
- **`repoToolKit.ts`** — the shared guard→resolve→ensureClone→decode skeleton for skill/file CRUD used by
  `repoTools` (owner-only) and `groupRepoTools` (owner + group + admin-role write gate). `commit` handlers
  and `create_repo` are intentionally NOT folded in. `OWNER_ONLY` here =
  `'This tool can only be used by the avatar owner.'`; **`systemTools` has a DIFFERENT `OWNER_ONLY` string**
  (`…in a conversation the avatar owner is participating in.`).
- **`ownerState.ts`** — `summarizeOwnerState(store, config, avatarUserId): OwnerState` returns UNFORMATTED
  self-state DATA shared by `buildPrompt` (English prompt paragraphs) and
  `systemTools.describe_system` (tool text). This module is the structural sync point for the
  metacognition principle. It returns ungated facts; gating + formatting stay at each call site (e.g.
  `buildPrompt` blanks secrets/groups to `[]` unless `ownerToolAccess`). When you add a self-state fact to
  one consumer, add it to `OwnerState` and the other.
- **Owner identity:** the `AgentOwner` type (`{id, username, displayName, alias?}`) lives in `../types.ts`
  and the descriptor is built ONCE in `runClaudeAgent` and passed to all tool servers. Don't re-declare
  the shape or rebuild the literal per server.
