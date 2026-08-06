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
#
# libreoffice-impress + poppler-utils back the pptx skill's slide rendering:
# soffice --headless converts pptx->pdf, then pdftoppm renders pdf->png, with
# fonts-nanum supplying Korean fonts so Hangul renders in headless conversions.
COPY docker/apt_mirror_sources.sh /usr/local/bin/apt_mirror_sources.sh
RUN sh /usr/local/bin/apt_mirror_sources.sh \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    fonts-nanum \
    git \
    gh \
    libreoffice-impress \
    poppler-utils \
    python3 \
    python3-pip \
    python3-cryptography \
    python3-paramiko \
    ripgrep \
    procps \
    jq \
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

ARG TARGETARCH

# uv/uvx (Python package + venv manager) for agent shell workflows. Pinned
# prebuilt GitHub-release binary — a single HTTPS fetch through the
# already-trusted corporate proxy CA above (the previous install.sh attempt
# silently skipped on closed networks, leaving images without uv). At RUNTIME,
# point uv at a corporate PyPI mirror via UV_DEFAULT_INDEX / UV_INDEX in .env —
# the whole .env reaches the container (compose env_file) and flows through the
# server into the agent subprocess env, so `uv pip install`/`uvx` in the agent
# shell resolve through the mirror. Bump UV_VERSION to upgrade.
ARG UV_VERSION=0.8.17
RUN case "$TARGETARCH" in \
      amd64|"") UV_TARGET=x86_64-unknown-linux-musl ;; \
      arm64)    UV_TARGET=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_TARGET}.tar.gz" \
       | tar -xz -C /usr/local/bin --strip-components=1 "uv-${UV_TARGET}/uv" "uv-${UV_TARGET}/uvx" \
  && chmod +x /usr/local/bin/uv /usr/local/bin/uvx \
  && uv --version \
  && uvx --version

# python-pptx is the library the pptx skill uses to build .pptx decks. It is
# NOT packaged in Debian bookworm, so apt can't provide it, hence pip with
# --break-system-packages, which overrides PEP 668's externally-managed guard
# for this ONE library (system python; no venv in this image).
# PIP_INDEX_URL / PIP_TRUSTED_HOST follow the NPM_CONFIG_REGISTRY pattern above
# (empty = upstream PyPI); --trusted-host is added only when set, for an HTTP
# mirror with a self-signed cert. The trailing self-test asserts soffice,
# pdftoppm, and the pptx module are present so a broken mirror fails the build.
ARG PIP_INDEX_URL=
ARG PIP_TRUSTED_HOST=
RUN if [ -n "$PIP_INDEX_URL" ]; then \
      pip3 install --break-system-packages --index-url "$PIP_INDEX_URL" ${PIP_TRUSTED_HOST:+--trusted-host "$PIP_TRUSTED_HOST"} python-pptx; \
    else \
      pip3 install --break-system-packages python-pptx; \
    fi \
  && soffice --version \
  && command -v pdftoppm \
  && python3 -c "import pptx"

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
  CMD curl -f --noproxy '*' "http://localhost:${PORT:-48787}/api/bootstrap" || exit 1

# Drop root privileges: the node:22 base image ships a `node` user (uid 1000).
# The `node` user only ever WRITES under APP_DATA_DIR (default /app/data): the
# SQLite DB, avatar images, agent-session transcripts, per-conversation
# workspaces, ssh known_hosts, and any cloned repos. The rest of /app (dist,
# node_modules, public, default-skills) is read-only at runtime, so we only
# chown the data dir — `chown -R /app` would needlessly re-stamp tens of
# thousands of node_modules files and duplicate them into a new image layer.
# HOME-based tool caches (gh/git/python, SDK MCP logs) land under /home/node,
# which the base image already owns as node:node.
#
# APP_DATA_DIR is typically a named volume mounted at runtime. The directory is
# created here so the volume mount point has the right owner even before a
# volume is attached.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "dist/server/index.js"]
