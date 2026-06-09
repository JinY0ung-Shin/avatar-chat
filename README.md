# Avatar Chat

A small platform where each user signs up, builds a public **avatar** (profile +
their own GitHub plugins), browses other people's published avatars, and chats with
any avatar. Chats run through the Claude Agent SDK in **read-only** mode.

## What it does

- **Accounts**: self-service signup with username + password (no invite codes). The
  first user to sign up becomes the **admin**. SQLite-backed users + roles (`admin`/`member`).
- **Avatar profile**: display name, uploaded profile picture (with a generated
  initials/gradient fallback), one-line bio, and an optional persona / system prompt.
- **Per-user plugins**: each user adds their own GitHub plugin repos to their avatar.
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

The image includes Node.js, git, Python 3, ripgrep, `jq`, and `uv`. SQLite data and
uploaded avatar images persist under `APP_DATA_DIR`.

## Configuration

| Env | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session token hashing secret (required in production). |
| `AGENT_RUNTIME` | `claude` (default, SDK read-only) or `local` (offline stub, no plugin execution). |
| `ANTHROPIC_API_KEY` | Optional; absent → SDK uses local Claude Code auth. |
| `PORT` / `APP_DATA_DIR` | Server port / data directory (SQLite DB + avatar images). |
| `READONLY_TOOLS` | Tool allowlist for plugin execution (default `Read,Glob,Grep`). |
| `GITHUB_TOKEN` | Optional, for cloning private plugin repos. |

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
