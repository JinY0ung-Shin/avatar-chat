---
name: release
description: Cut a Noah Almighty release — run the verification gate, sync the what's-new registry, bump semver, tag, and publish the GitHub release. Use when the user says "릴리즈", "릴리스", "release", "버전 올려서 배포/태그", or asks to publish a version.
---

# Noah Almighty release workflow

Cut a semver release: gates green → what's-new registry synced → version bumped →
`main` pushed → GitHub release published. **Releasing ≠ deploying** — deployment is
a separate internal corporate server; end by reminding the user to deploy the tag.

## 1. Preconditions

- On `main`, synced with origin (`git fetch origin && git status -sb`).
- If unrelated files are dirty, stage release files EXPLICITLY — never `git add -A`
  (`.claude/worktrees/` embedded checkouts + stray edits; see ARCHITECTURE-NOTES).

## 2. Decide the version

- User-named version wins. Otherwise derive from commits since the last tag
  (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`):
  breaking change → major, any `feat` → minor, else patch. Ask if ambiguous.

## 3. Sync the what's-new registry (user-visible changes only)

- If the range contains USER-VISIBLE changes, PREPEND an entry to
  `src/server/releaseNotes.ts`: date-based unique `id` (`YYYY-MM-DD`, same-day
  second release `YYYY-MM-DD.2`), Korean 해요체 `items` (`{title, body, example?}`
  — `example` renders as a highlighted "try this" hint; write one for features
  users must act on to discover). Ordering = array position, newest first; never
  reuse or re-sort ids.
- Skip for internal-only releases (refactor/docs/perf) — keep the dialog meaningful.
- App semver and these date ids are INDEPENDENT — don't unify them.

## 4. Verification gate (all must pass before tagging)

```
npx tsc --noEmit
npx svelte-check --tsconfig ./tsconfig.client.json
npm test
npm run build
```

⚠️ Do NOT use `npm run lint` — the rtk hook misrewrites it (see CLAUDE.md).

## 5. Bump + commit + push

- `npm version <x.y.z> --no-git-tag-version` (package.json + lock only).
  NEVER bump the `version: "0.1.0"` strings in `src/server/agent/*Tools.ts` —
  MCP protocol metadata, not the app version.
- Feature work goes in its own conventional commits first; then
  `chore(release): vX.Y.Z` with package.json, package-lock.json (+ release docs).
- `git push origin main`.

## 6. Publish the GitHub release

- Write Korean, user-facing notes to a scratch file (template below); lead with
  what users get, reuse the `releaseNotes.ts` entry wording where it fits.
- `gh release create vX.Y.Z --target main --title "Noah Almighty vX.Y.Z" --notes-file <file>`
  (gh is authed on this box; origin = github.com/JinY0ung-Shin/noah-almighty).

## 7. Verify + wrap up

- `git ls-remote origin refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'` must resolve to the
  pushed HEAD; `gh release view vX.Y.Z` must show draft=false.
- Tell the user: release URL + "사내 서버에 이 태그로 배포하면 기존 사용자에게
  '새로워진 기능' 안내가 1회 표시됩니다."

## Rules / edge cases

- **Never move a published tag** that may have consumers. If a minutes-old release
  with no consumers must absorb one more commit, prefer a patch bump; only with the
  user's explicit approval recreate in place:
  `gh release delete vX.Y.Z --cleanup-tag --yes` → `gh release create` at new HEAD.
- Language split: this skill, commit messages, code comments → English; GitHub
  release notes and every what's-new string → Korean.

### GitHub notes template (Korean)

```markdown
<한 줄 요약 — 이 릴리스가 사용자에게 주는 가치>

## 달라진 점
- **<기능>** — <사용자 관점 한 줄 설명>

## 내부 변경
- <리팩터링 / 성능 / 문서 등 (없으면 섹션 생략)>
```
