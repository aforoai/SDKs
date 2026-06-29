# Multi-stage build: compile TypeScript → slim Node 20 runtime
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY bin/ bin/
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY package.json ./

# Health check — proxy is healthy if process is running
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD test -f /tmp/aforo-proxy-alive || exit 1

ENTRYPOINT ["node", "dist/bin/aforo-mcp-proxy.js"]
