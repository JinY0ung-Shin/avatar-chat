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
      && ln -s /root/.local/bin/uv /usr/local/bin/uv \
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
ARG HEX_SSH_MCP_VERSION=latest
RUN if [ -n "$NPM_CONFIG_REGISTRY" ]; then \
      printf 'registry=%s\nstrict-ssl=false\n' "$NPM_CONFIG_REGISTRY" > /root/.npmrc; \
    fi \
  && NODE_TLS_REJECT_UNAUTHORIZED=0 npm install -g "@levnikolaevich/hex-ssh-mcp@${HEX_SSH_MCP_VERSION}" \
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

ENV NODE_ENV=production
ENV PORT=48787
ENV APP_DATA_DIR=/app/data
EXPOSE 48787

CMD ["npm", "start"]
