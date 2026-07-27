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
- **PowerPoint decks**: the avatar can generate PowerPoint (`.pptx`) presentations, preview the
  rendered slides in the chat (in the canvas side panel when enabled, inline otherwise), and hand
  over the finished deck as a download card.
- **Scheduled routines**: owners can create one-time or recurring chat jobs (`/api/me/routines`)
  for a specific KST date/time, daily/weekly slots, or a fixed interval. The avatar executes
  them headlessly and keeps each run's result in a dedicated routine conversation.
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
- **External avatars**: operators can register stateless agents in **관리자 ▸ 외부 아바타**
  (encrypted at rest) or as read-only deployment entries with `EXTERNAL_AGENTS_JSON`. They
  appear in Explore and use the same Noah transcript/activity
  UI, while each turn sends the full stored text history to an external
  `POST /v1/agents/messages` endpoint. Their gateway owns model, system prompt, and tools;
  Noah does not expose local model/effort, MCP, repo/plugin, routine, or image controls for
  them. The event stream must declare schema `claude-agent-sdk-message-v1` and wrap normalized
  Claude Agent SDK envelopes in `sdk_message` events. Omit `visibleToGroupIds` to expose one
  to every signed-in user, or provide a non-empty list of Noah group UUIDs to limit discovery
  and new chat turns to current members. This group list is a Noah visibility ACL only; it
  neither changes gateway tools nor grants local trust/elevation. System admins must also be
  members of an allowed group to chat; removing membership blocks the next detail/chat request
  but does not erase that user's existing conversation history or interrupt a run already started.
  Existing conversations are bound to their original endpoint, so changing a static env endpoint
  does not forward prior transcripts; start a new conversation after such a change.
  The admin screen supports create/edit, activation, group selection, write-only Gateway API
  keys, safety timeouts, and a side-effect-free Gateway auth/model check. Environment entries
  remain read-only and win an ID collision, so existing deployments keep their behavior.
- **Per-conversation model picker**: the chat composer lets any user choose a model
  tier (Opus / Sonnet / Haiku) per conversation; the choice persists on the conversation
  and rides each turn. **Opus is the default** when nothing is picked. Operators map each
  tier to a concrete model id via `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` (the picker
  shows the mapped id). An env-pinned `ANTHROPIC_MODEL` hard-locks the model and hides the picker.
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

The image includes Node.js, git, GitHub CLI (`gh`), Python 3, ripgrep, `jq`, `uv`, LibreOffice,
poppler-utils, Korean (Nanum) fonts, and `python-pptx` (backing the avatar's PowerPoint generation).
SQLite data and uploaded avatar images persist under `APP_DATA_DIR`. The container runs as the
non-root `node` user.

On a closed corporate network, optional build args (in `docker-compose.yml`, all empty by default =
public upstreams) route installs through internal mirrors. Alongside the existing `APT_MIRROR_HOST`,
`NPM_CONFIG_REGISTRY`, and `CA_CERT_FILE`, two cover the PyPI fetch of `python-pptx`:

- `PIP_INDEX_URL` — internal PyPI index URL used by `pip install` at build time.
- `PIP_TRUSTED_HOST` — host to trust when that PyPI mirror uses HTTP or a self-signed cert.

## Configuration

| Env | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session token hashing secret (required in production). |
| `SECURE_COOKIES` | `true` to mark the session cookie `Secure` (HTTPS-only). Leave unset for plain-HTTP deployments (e.g. local docker-compose) or the cookie is never sent back and login fails. |
| `AGENT_RUNTIME` | `claude` (default) or `local` (offline stub, no plugin execution). |
| `EXTERNAL_AGENTS_JSON` | Optional read-only JSON array of stateless external avatars (the admin UI can manage additional entries). Each entry requires `id`, `displayName`, and exactly one of `endpoint` or `baseUrl`; an exact endpoint must end in `/v1/agents/messages`, while a base URL gets that suffix appended. The v1 contract supports only `agent: "claude"`. Entries also support public `alias`/`bio`/`persona`/`intro`/`hashtags`, optional non-empty `visibleToGroupIds` for Noah group visibility, private upstream `model`, `system`, and `apiKeyEnv` (preferred) or `apiKey`, plus positive `connectTimeoutSeconds` (default 15), `idleTimeoutSeconds` (default 120), and `totalTimeoutSeconds` (default 1800). Omitting `visibleToGroupIds` keeps the avatar public; values are stable group IDs from the admin groups API/UI and are never returned by public avatar APIs. Environment entries are read-only and take precedence over a UI entry with the same ID. Public ids are `external:<id>`. |
| `ANTHROPIC_API_KEY` | Optional; absent → SDK uses subscription token (admin UI) or local Claude Code auth. |
| `ANTHROPIC_MODEL` | Optional. Pin the Claude model (e.g. `claude-opus-4-8`). When set it's a **hard lock**: the per-conversation model picker is hidden. Absent → the resolution chain below (defaulting to Opus). |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` | Optional. Map each composer model TIER (Opus/Sonnet/Haiku) to a concrete model id; the picker shows the mapped id. Unset tier → SDK resolves the alias to the account default (shown as just the tier label). Precedence: `ANTHROPIC_MODEL` > user's per-conversation tier > admin override > **Opus** (default). |
| `PORT` / `APP_DATA_DIR` | Server port (default `48787`) / data directory (SQLite DB + avatar images). |
| `READONLY_TOOLS` | Tool allowlist for unelevated colleague chat sessions (default `Read,Glob,Grep`). |
| `GITHUB_HOST` | Internal/default GitHub host for shorthand repo values like `owner/repo` (default `github.com`). Knowledge repos must use this host; full github.com URLs can use `GITHUB_TOKEN`. |
| `GITHUB_CA_CERT` | Optional PEM CA bundle for on-prem GitHub Enterprise (GHES) with a private CA. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Optional corporate proxy for outbound web access — used by the `mcp__web__fetch` avatar tool and inherited by the SDK subprocess (built-in WebFetch/WebSearch). Put intranet hosts/domain suffixes in `NO_PROXY` so they bypass the proxy. |
| `NODE_EXTRA_CA_CERTS` | Optional PEM bundle for intranet HTTPS behind a private corporate CA — honored by the app process (`mcp__web__fetch`) and the SDK subprocess (built-in WebFetch). Docker images built with the `CA_CERT_FILE` arg already contain `/usr/local/share/ca-certificates/extra-proxy-ca.crt`. |
| `CONFLUENCE_URL` | Optional app-wide Confluence Server/Data Center base URL for page, attachment, and image/draw.io asset tools. Per-avatar PATs are stored as the `CONFLUENCE_PAT` user secret. |
| `LOG_LEVEL` | Pino log level: `trace`/`debug`/`info`/`warn`/`error` (default `debug` in dev, `info` in prod). |
| `MAX_TURNS` | Maximum agent turns per chat run (default `1000`). |
| `ROUTINE_RUN_TIMEOUT_MINUTES` | Wall-clock deadline for one scheduled-routine run (default `30`, minimum `1` — it cannot be disabled). Covers the whole run, model-fallback retries included. `지금 실행` holds its HTTP request open for up to this long, so keep it under any reverse proxy's read timeout. |
| `DEFAULT_PLUGINS_DIR` | Path to built-in skills loaded for every avatar (default `<cwd>/default-skills`). |
| `PLUGIN_AUTO_REFRESH_MINUTES` | Minutes before an enabled avatar plugin clone is refreshed from git at chat/routine start (default `10`; `0` disables auto refresh after the first clone). |
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

`npm test` runs `node --check` over every `*.js` under `public/` (recursively, via
`pretest`) to syntax-check the vanilla-JS frontend before running the Vitest suite.

Smoke test: sign up (first user = admin) → open **내 아바타**, set a name/picture/bio,
click **아바타가 자동 생성** under 역량 해시태그, add a plugin, toggle **공개** → from
another account, open **탐색**, search by a hashtag, pick the avatar, and chat. Confirm the
response streams and renders markdown.
