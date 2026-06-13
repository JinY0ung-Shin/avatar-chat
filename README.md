# Noah Almighty

A platform where each user signs up, builds a public **avatar** (profile + GitHub plugins +
personal knowledge repo), browses coworkers' published avatars, and chats with any avatar.
Chats run through the Claude Agent SDK with a tiered permission model — read-only for
plain colleagues, elevated (write/SSH/repo) for owners and trusted users.

## What it does

- **Accounts**: self-service signup with username + password (no invite codes). The
  first user to sign up becomes the **admin**. SQLite-backed users + roles (`admin`/`member`).
- **Avatar profile**: display name, uploaded profile picture (with a generated
  initials/gradient fallback), one-line bio, an optional persona / system prompt, and
  **capability hashtags** (역량 해시태그) the avatar can **auto-generate** from its own
  skills/persona (just like the self-introduction). New avatars are public by default and
  can be made private from **내 아바타**.
- **Personal knowledge repo**: each user connects one dedicated GitHub repo where their
  avatar accumulates work knowledge and skills. It is **auto-loaded into the avatar** (its
  skills become available in chat), and the avatar **manages it itself**: in an owner chat
  the avatar can list/read/write files, scaffold skills (`skills/<name>/SKILL.md`), and
  commit & push — via the owner-only `mcp__repo__*` tools. Settings just points at the repo
  (a GitHub link); there is no in-app file editor.
- **Delegation loop**: grow your avatar by turning repeated work, project rules, runbooks,
  and answers to teammate questions into skills / knowledge files / routines, then delegate
  more of that work back to the avatar over time.
- **Scheduled routines**: owners can create recurring chat jobs (`/api/me/routines`) that
  run on a cron schedule — the avatar executes them headlessly (read-only, no tool prompts).
  The `/routine <task>` chat command creates a routine inline. The avatar itself can manage
  routines via the `mcp__system__*_routine` tools.
- **Groups**: the system admin creates named teams (`/api/admin/groups*`) and assigns group
  admins. Group co-members **auto-trust each other symmetrically** — they see each other's
  unpublished avatars and get elevated tool access when chatting with a co-member's avatar,
  exactly like a trusted user. Each group has one shared **knowledge repo** whose skills are
  auto-loaded for all member avatars; group admins can edit it via the `mcp__group_repo__*`
  tools. Group self-serve (member/repo management) is at `/api/me/groups*`.
- **Trusted users**: each user can grant individual colleagues elevated access to their avatar
  (`/api/me/trusted`). Trusted users see unpublished avatars and can run write-capable tools
  (Write/Edit/Bash, repo commit/push) with a per-tool prompt — the same tool set as the
  owner, but with interactive confirmation rather than auto-approve.
- **Knowledge-backfill loop**: when the avatar notices a knowledge gap it can file a
  `request_info` gap. The owner sees pending gaps in the **내 아바타** nav badge and receives
  an in-app toast; clicking through lets them answer and feed the answer back to the avatar,
  which resolves the gap via `mcp__knowledge__resolve_request`.
- **Teammate avatars**: browse coworkers' published avatars and ask them work questions or
  request research, review, summarization, and other tasks against the knowledge and skills
  their owners have built up.
- **Per-user plugins**: each user can also add other GitHub plugin repos (read-only) to their
  avatar, separate from the knowledge repo.
- **Per-user Git tokens**: each user can store an internal `GIT_TOKEN` user secret for the
  configured `GITHUB_HOST` and an optional `GITHUB_TOKEN` for github.com. Tokens are
  AES-256-GCM encrypted at rest, keyed from `SESSION_SECRET`, and supplied to git via an
  `http.extraHeader`, so they are never written into any clone's `.git/config`. The knowledge
  repo is always expected to live on the internal `GITHUB_HOST`. Public general git repos can
  be cloned/synced without a token; push still requires whatever write credential the remote accepts.
- **SSH tools**: when the owner stores an `SSH_PRIVATE_KEY` secret and trusts target hosts,
  the avatar can use allowed SSH tools to work on servers reachable from the app host, such as
  checking logs, inspecting files, or running commands under the configured policy.
- **Onboarding**: after first login a skippable guided step explains the main workflows,
  gives starter prompts, optionally stores the internal `GIT_TOKEN`, and can generate an
  `SSH_PRIVATE_KEY` keypair immediately. External github.com `GITHUB_TOKEN` setup and
  knowledge repo / branch setup can happen later through settings.
- **Discovery**: published avatars appear in the Explore directory, searchable by name or
  **capability hashtag**; anyone can start a chat. Group co-members also see each other's
  unpublished avatars. An avatar can look up other avatars' capabilities mid-chat
  (the shared read-only `mcp__avatars__search_avatars` tool) and point you to a
  better-suited teammate when a request is outside its own expertise.
- **Tiered chat permissions**: the Claude Agent SDK runs with `permissionMode: "default"`.
  A `PreToolUse` hook is the single gate for all tool calls:
  - **Owner** (chatting with own avatar): all tools auto-approved with no prompt, including
    Write/Edit/Bash, repo commit/push, SSH, knowledge-backfill, and routine management.
  - **Elevated viewer** (trusted user or group co-member): same tool set, but each non-read
    tool requires an interactive per-tool allow/deny prompt.
  - **Plain colleague / headless routines**: read-only tools only (`READONLY_TOOLS`,
    default `Read,Glob,Grep`), plus in-process MCP tools that self-gate to owner/elevated
    in their handlers.
  - Streaming, markdown rendering, conversations, and per-message actions (copy,
    regenerate, edit-and-resend) are supported for all viewer classes.
- **Admin**: list users, grant/revoke the `admin` role, delete accounts, manage groups
  (create/delete teams, assign group admins, manage members), and configure the subscription
  login (관리자 ▸ 구독 로그인) — paste the output of `claude setup-token` to use a Claude
  subscription instead of an `ANTHROPIC_API_KEY`. System info (model, subscription status,
  API key override) is at `GET /api/admin/system`.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:48787`, click **회원가입**, and create the first account (it becomes admin).

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The image includes Node.js, git, GitHub CLI (`gh`), Python 3, ripgrep, `jq`, and `uv`. SQLite data and
uploaded avatar images persist under `APP_DATA_DIR`. The container runs as the non-root `node` user.

## Configuration

| Env | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session token hashing secret (required in production). |
| `SECURE_COOKIES` | `true` to mark the session cookie `Secure` (HTTPS-only). Leave unset for plain-HTTP deployments (e.g. local docker-compose) or the cookie is never sent back and login fails. |
| `AGENT_RUNTIME` | `claude` (default) or `local` (offline stub, no plugin execution). |
| `ANTHROPIC_API_KEY` | Optional; absent → SDK uses subscription token (admin UI) or local Claude Code auth. |
| `ANTHROPIC_MODEL` | Optional. Pin the Claude model (e.g. `claude-opus-4-8`). Absent → SDK default. |
| `PORT` / `APP_DATA_DIR` | Server port (default `48787`) / data directory (SQLite DB + avatar images). |
| `READONLY_TOOLS` | Tool allowlist for unelevated colleague chat sessions (default `Read,Glob,Grep`). |
| `GITHUB_HOST` | Internal/default GitHub host for shorthand repo values like `owner/repo` (default `github.com`). Knowledge repos must use this host; full github.com URLs can use `GITHUB_TOKEN`. |
| `GITHUB_CA_CERT` | Optional PEM CA bundle for on-prem GitHub Enterprise (GHES) with a private CA. |
| `CONFLUENCE_URL` | Optional app-wide Confluence Server/Data Center base URL. Per-avatar PATs are stored as the `CONFLUENCE_PAT` user secret. |
| `LOG_LEVEL` | Pino log level: `trace`/`debug`/`info`/`warn`/`error` (default `debug` in dev, `info` in prod). |
| `MAX_TURNS` | Maximum agent turns per chat run (default `1000`). |
| `DEFAULT_PLUGINS_DIR` | Path to built-in skills loaded for every avatar (default `<cwd>/default-skills`). |
| `ENV_FILE` | Override the `.env` file path loaded at startup (default `.env` in cwd). |

## Security note

Avatar plugins are arbitrary GitHub repositories loaded by the Claude Agent SDK. The tool
permission model is tiered — owners and trusted/group co-members can run elevated tools
(Write/Edit/Bash, repo commit/push, SSH); plain colleague chats are read-only. The
`PreToolUse` hook in `src/server/agent/claudeAgent.ts` is the single enforcement gate; all
in-process MCP server handlers self-gate for owner/elevated checks. Loading a third-party
plugin still executes its code on the server. For a public/production deployment, run plugin
execution in a sandbox (container/VM per request, network egress limits).

## Verification

```bash
npm run lint
npm test
npm run build
```

`npm test` runs `node --check public/app.js` first (via `pretest`) to syntax-check the
vanilla-JS frontend before running the Vitest suite.

Smoke test: sign up (first user = admin) → open **내 아바타**, set a name/picture/bio,
click **아바타가 자동 생성** under 역량 해시태그, add a plugin, toggle **공개** → from
another account, open **탐색**, search by a hashtag, pick the avatar, and chat. Confirm the
response streams and renders markdown.
