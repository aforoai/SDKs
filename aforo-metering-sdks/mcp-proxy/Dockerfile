# Multi-stage build: compile TypeScript → slim Node 20 runtime
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY bin/ bin/
RUN npm run build && npm prune --omit=dev

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app
COPY --from=builder --chown=root:root /app/dist/ dist/
COPY --from=builder --chown=root:root /app/node_modules/ node_modules/
COPY --chown=root:root package.json ./

# The proxy rewrites this file every 10 s while it is serving and removes it on
# shutdown; the health check fails when it is missing or older than a minute.
ENV AFORO_HEALTH_FILE=/tmp/aforo-proxy-alive

# Run as the image's unprivileged user; the app files stay root-owned (read-only to it).
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD test -n "$(find /tmp/aforo-proxy-alive -mmin -1 2>/dev/null)" || exit 1

ENTRYPOINT ["node", "dist/bin/aforo-mcp-proxy.js"]
