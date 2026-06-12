# Noah Almighty

A small platform where each user signs up, builds a public **avatar** (profile +
their own GitHub plugins), browses other people's published avatars, and chats with
any avatar. Chats run through the Claude Agent SDK in **read-only** mode.

## What it does

- **Accounts**: self-service signup with username + password (no invite codes). The
  first user to sign up becomes the **admin**. SQLite-backed users + roles (`admin`/`member`).
- **Avatar profile**: display name, uploaded profile picture (with a generated
  initials/gradient fallback), one-line bio, and an optional persona / system prompt.
  New avatars are public by default and can be made private from **내 아바타**.
- **Personal knowledge repo**: each user connects one dedicated GitHub repo where their
  avatar accumulates work knowledge and skills. It is **auto-loaded into the avatar** (its
  skills become available in chat), and the avatar **manages it itself**: in an owner chat
  the avatar can list/read/write files, scaffold skills (`skills/<name>/SKILL.md`), and
  commit & push — via the owner-only `mcp__repo__*` tools. Settings just points at the repo
  (a GitHub link); there is no in-app file editor.
- **Delegation loop**: grow your avatar by turning repeated work, project rules, runbooks,
  and answers to teammate questions into skills / knowledge files / routines, then delegate
  more of that work back to the avatar over time.
- **Teammate avatars**: browse coworkers' published avatars and ask them work questions or
  request research, review, summarization, and other tasks against the knowledge and skills
  their owners have built up.
- **Per-user plugins**: each user can also add other GitHub plugin repos (read-only) to their
  avatar, separate from the knowledge repo.
- **Per-user GitHub token**: each user can store a personal access token (AES-256-GCM
  encrypted at rest, keyed from `SESSION_SECRET`) to clone their own private plugin/knowledge
  repos and to let the avatar push to the knowledge repo. The token is supplied to git via an
  `http.extraHeader`, so it is never written into any clone's `.git/config`.
- **SSH tools**: when the owner stores an `SSH_PRIVATE_KEY` secret and trusts target hosts,
  the avatar can use allowed SSH tools to work on servers reachable from the app host, such as
  checking logs, inspecting files, or running commands under the configured policy.
- **Onboarding**: after first login a skippable guided step explains the main workflows,
  gives starter prompts, and optionally stores a GitHub token; knowledge repo / branch setup
  can happen later through chat or settings.
- **Discovery**: published avatars appear in the Explore directory; anyone can start a chat.
- **Read-only chat**: chatting with an avatar loads that avatar's enabled plugins and runs
  the Claude Agent SDK with `permissionMode=dontAsk`, `allowedTools=Read,Glob,Grep`, and
  `Write`/`Edit` disallowed. Streaming, markdown rendering, conversations, and per-message
  actions (copy, regenerate, edit-and-resend) are supported.
- **Admin**: list users, grant/revoke the `admin` role, delete accounts.

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
uploaded avatar images persist under `APP_DATA_DIR`.

## Configuration

| Env | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session token hashing secret (required in production). |
| `SECURE_COOKIES` | `true` to mark the session cookie `Secure` (HTTPS-only). Leave unset for plain-HTTP deployments (e.g. local docker-compose) or the cookie is never sent back and login fails. |
| `AGENT_RUNTIME` | `claude` (default, SDK read-only) or `local` (offline stub, no plugin execution). |
| `ANTHROPIC_API_KEY` | Optional; absent → SDK uses local Claude Code auth. |
| `PORT` / `APP_DATA_DIR` | Server port / data directory (SQLite DB + avatar images). |
| `READONLY_TOOLS` | Tool allowlist for plugin execution (default `Read,Glob,Grep`). |
| `GITHUB_HOST` | Default host for shorthand repo values like `owner/repo` (default `github.com`; full URLs are used as-is). |
| `CONFLUENCE_URL` | Optional app-wide Confluence Server/Data Center base URL. Per-avatar PATs are stored as the `CONFLUENCE_PAT` user secret. |

## Security note

Avatar plugins are arbitrary GitHub repositories loaded by the Claude Agent SDK. Tool
permissions are restricted to read-only (`Write`/`Edit` blocked), but loading a third-party
plugin still executes its code on the server. For a public/production deployment, run plugin
execution in a sandbox (container/VM per request, network egress limits). This build assumes
a trusted-enough environment per the read-only tradeoff.

## Verification

```bash
npm run lint
npm test
npm run build
```

Smoke test: sign up (first user = admin) → open **내 아바타**, set a name/picture/bio,
add a plugin, toggle **공개** → from another account, open **탐색**, pick the avatar,
and chat. Confirm the response streams and renders markdown.
