# Multi-stage build: compile TypeScript → slim Node 20 runtime
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
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

# Default: HTTP transport on port 8090. Override with --transport / --port.
# Port 8090 avoids collision with the MCP test server (8080) and Aforo's
# published-service block (8081-8093).
EXPOSE 8090

# Health check — HTTP transport responds to GET /health with a JSON body.
# Uses `node -e` so we don't depend on wget/curl (BusyBox wget in
# node:alpine doesn't reliably support --spider).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8090/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["node", "dist/bin/aforo-agent-test-server.js"]
CMD ["--transport", "http", "--port", "8090"]
