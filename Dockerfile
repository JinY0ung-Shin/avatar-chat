FROM node:22-bookworm-slim AS base

# Optional corporate-mirror build args (empty = use upstream defaults).
# Pass them via docker compose build args or --build-arg.
# Example:
#   APT_MIRROR_HOST=mirror.example.internal/repository/proxy-apt-deb.debian.org
#   NPM_CONFIG_REGISTRY=http://mirror.example.internal/repository/proxy-npm-registry.npmjs.org/
ARG APT_MIRROR_HOST=
ARG NPM_CONFIG_REGISTRY=

# No openssh-client: remote SSH goes through the hex-ssh MCP server, which is
# ssh2-based (pure JS) and needs no system `ssh` binary. python3-cryptography /
# python3-paramiko back app-managed SSH key generation + known_hosts
# registration (the image has no ssh-keygen/ssh-keyscan); installed via apt to
# avoid PEP 668 pip restrictions on Debian and to resolve through the apt mirror.
COPY docker/apt_mirror_sources.sh /usr/local/bin/apt_mirror_sources.sh
RUN sh /usr/local/bin/apt_mirror_sources.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    git \
    gh \
    python3 \
    python3-pip \
    python3-cryptography \
    python3-paramiko \
    ripgrep \
    procps \
    jq \
  && (curl -LsSf https://astral.sh/uv/install.sh | sh \
      && cp /root/.local/bin/uv /usr/local/bin/uv \
      || echo "uv install skipped (no internet access)") \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/local/bin/apt_mirror_sources.sh

# Trust an optional corporate proxy CA so git/curl/node can clone over HTTPS
# through an intercepting proxy. Folding it into the system bundle covers git
# (libcurl), curl, and node, so no per-tool env is needed.
#
# CA_CERT_FILE is the path (relative to the build context) of the cert to trust.
# Override it at build time to point at your own CA:
#   docker build --build-arg CA_CERT_FILE=docker/tls-fullchain.crt .
# or in compose via the `args:` block. It must resolve to a file inside the
# build context (Docker COPY can't read paths outside it). The default is a
# placeholder so builds that do not need a custom CA still work.
ARG CA_CERT_FILE=docker/extra-ca.crt.example
COPY ${CA_CERT_FILE} /tmp/extra-ca.crt
RUN if grep -q "BEGIN CERTIFICATE" /tmp/extra-ca.crt; then \
      cp /tmp/extra-ca.crt /usr/local/share/ca-certificates/extra-proxy-ca.crt; \
      update-ca-certificates; \
    else \
      echo "No extra CA certificate configured; skipping trust-store update."; \
    fi \
  && rm -f /tmp/extra-ca.crt

WORKDIR /app

# RTK (Rust Token Killer) rewrites Bash commands into token-optimized equivalents
# in the Claude SDK PreToolUse hook. Download the prebuilt static binary instead
# of `cargo install`-ing from source: a single HTTPS fetch through the
# already-trusted corporate proxy CA above — no Rust toolchain and no crates.io
# dependency tree to resolve on a closed network. Pinned for reproducibility;
# bump RTK_VERSION (and re-run the self-test) to upgrade.
ARG RTK_VERSION=0.42.4
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64|"") RTK_TARGET=x86_64-unknown-linux-musl ;; \
      arm64)    RTK_TARGET=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-${RTK_TARGET}.tar.gz" \
       | tar -xz -C /usr/local/bin rtk \
  && chmod +x /usr/local/bin/rtk \
  && rtk --version \
  && test "$(rtk rewrite 'git status && git diff')" = "rtk git status && rtk git diff"

# Always use npm install (not npm ci) so the build doesn't fail when the lock
# file drifts out of sync with package.json, and so a corporate mirror can
# resolve slightly different dependency versions than the lock file expects.
# When a custom NPM_CONFIG_REGISTRY is provided we also set strict-ssl=false
# for HTTP mirrors with self-signed certs and NODE_TLS_REJECT_UNAUTHORIZED=0
# for node-gyp header downloads.
COPY package.json package-lock.json* ./
RUN if [ -n "$NPM_CONFIG_REGISTRY" ]; then \
      printf 'registry=%s\nstrict-ssl=false\n' "$NPM_CONFIG_REGISTRY" > .npmrc; \
      NODE_TLS_REJECT_UNAUTHORIZED=0 npm install; \
    else \
      npm install; \
    fi \
  && rm -f .npmrc

# Install the hex-ssh MCP server (remote-server access tools) into the IMAGE at
# build time, so the avatar never has to `npx`-download it at runtime — that
# fails on a closed corporate network where the public npm registry is
# unreachable. The build-time mirror (NPM_CONFIG_REGISTRY) IS reachable, so we
# install through it here, then expose the package's bin under the fixed name
# `hex-ssh-mcp` (the actual bin key in package.json is resolved at build time, so
# claudeAgent can spawn a stable command). Kept in its own layer so an upstream
# version bump only rebuilds this step. Pinned for reproducibility.
ARG HEX_SSH_MCP_VERSION=1.9.2
RUN if [ -n "$NPM_CONFIG_REGISTRY" ]; then \
      printf 'registry=%s\nstrict-ssl=false\n' "$NPM_CONFIG_REGISTRY" > /root/.npmrc; \
      NODE_TLS_REJECT_UNAUTHORIZED=0 npm install -g "@levnikolaevich/hex-ssh-mcp@${HEX_SSH_MCP_VERSION}"; \
    else \
      npm install -g "@levnikolaevich/hex-ssh-mcp@${HEX_SSH_MCP_VERSION}"; \
    fi \
  && rm -f /root/.npmrc \
  && PKG_DIR="$(npm root -g)/@levnikolaevich/hex-ssh-mcp" \
  && BIN_REL="$(node -e "const b=require('$PKG_DIR/package.json').bin; process.stdout.write(typeof b==='string'?b:Object.values(b)[0])")" \
  # Point the fixed name `hex-ssh-mcp` at the package's real bin. Use `ln -sf`
  # (which replaces the link itself), NOT `> file` — npm's global install already
  # created a /usr/local/bin symlink for this bin, and a `>` redirect would
  # follow it and clobber the package's own server file. The bin's own shebang
  # (#!/usr/bin/env node) makes it directly executable, so no wrapper is needed.
  && ln -sf "$PKG_DIR/$BIN_REL" /usr/local/bin/hex-ssh-mcp \
  && test -f "$PKG_DIR/$BIN_REL" \
  && echo "hex-ssh-mcp -> $PKG_DIR/$BIN_REL"

COPY . .
RUN npm run build

# uv was installed into /root during the base layer, then COPIED (not symlinked)
# to /usr/local/bin/uv so the unprivileged `node` user can execute it — a symlink
# into /root would be unreadable because /root is mode 700.

ENV NODE_ENV=production
ENV PORT=48787
ENV APP_DATA_DIR=/app/data
EXPOSE 48787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f --noproxy '*' http://localhost:48787/api/bootstrap || exit 1

# Drop root privileges: the node:22 base image ships a `node` user (uid 1000).
# /app and the data dir are owned by root at this point; chown them so the
# `node` user can write the SQLite DB, avatar images, agent-session transcripts,
# and any cloned repos under APP_DATA_DIR.
RUN chown -R node:node /app
# APP_DATA_DIR defaults to /app/data (set above) and is typically a named volume
# mounted at runtime. The directory is created here so the volume mount point
# has the right owner even before a volume is attached.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "dist/server/index.js"]
