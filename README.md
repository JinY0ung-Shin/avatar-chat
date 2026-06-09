# Avatar Chat

Internal browser chat app for a Claude Agent SDK backed workplace skill marketplace.

## What It Does

- Invite-only internal access.
- Two modes:
  - `colleague`: read-only, project-scoped operational questions.
  - `owner`: owner-only work-command mode.
- Loads a Claude plugin marketplace from a local path, GitHub `owner/repo`, or git URL.
- Uses app-specific `avatar-chat.json` metadata to expose deterministic skill runners and to decide which skills are colleague-safe.
- Uses `@anthropic-ai/claude-agent-sdk` when `ANTHROPIC_API_KEY` is configured.
- Falls back to local skill runners when `AGENT_RUNTIME=local` or no API key is present.
- Runs as a single Docker Compose service with a persistent data volume.

The app intentionally does not implement service health checks or VM inventory integrations directly. Those belong in marketplace skills/plugins.

## Quick Start

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:48787`.

For local development, the default owner setup code is:

```text
owner-local-setup
```

For deployment, set a strong `OWNER_SETUP_CODE` and `SESSION_SECRET` in `.env`.

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The image includes Node.js, git, OpenSSH client, Python 3, ripgrep, `jq`, and `uv`.

## Marketplace Configuration

By default the app mounts and uses:

```text
sample-marketplace/
```

To use a GitHub-hosted marketplace:

```env
MARKETPLACE_SOURCE=your-org/your-claude-marketplace
MARKETPLACE_REF=main
GITHUB_TOKEN=...
```

The marketplace should contain:

```text
.claude-plugin/marketplace.json
plugins/<plugin-name>/.claude-plugin/plugin.json
plugins/<plugin-name>/skills/<skill-name>/SKILL.md
```

For deterministic app execution and colleague-mode filtering, add `avatar-chat.json` to each plugin root:

```json
{
  "commands": [
    {
      "name": "service-status",
      "description": "서비스 상태를 표로 정리합니다.",
      "mode": "colleague",
      "readOnly": true,
      "projectScoped": true,
      "match": ["서비스", "status"],
      "command": "node",
      "args": ["scripts/service-status.js"]
    }
  ]
}
```

Colleague mode only exposes commands where:

- `readOnly` is `true`
- `projectScoped` is `true`
- `mode` is `colleague` or `both`

Owner mode can see all commands.

## Claude Agent SDK

Official docs currently identify the TypeScript package as:

```bash
npm install @anthropic-ai/claude-agent-sdk
```

When `ANTHROPIC_API_KEY` is set and `AGENT_RUNTIME=auto` or `claude`, the app calls the SDK with local plugin roots:

- Colleague mode: `permissionMode=dontAsk`, default allowed tools `Read,Glob,Grep`
- Owner mode: `permissionMode` from `OWNER_PERMISSION_MODE`

If `ANTHROPIC_API_KEY` is absent and `AGENT_RUNTIME=auto`, the app uses local skill runners so the deployment and UI remain testable.

## Verification

```bash
npm run lint
npm test
npm run build
```

Smoke test locally:

1. Login as owner with `owner-local-setup`.
2. Create a colleague invite.
3. Open another browser/session and login with the invite.
4. Ask: `지금 서비스들 정상 작동하고 있는지 확인해줘`
5. Confirm a service status table appears.
6. Ask: `api 서버 재배포 해줘`
7. Confirm colleague mode blocks the mutating request.
