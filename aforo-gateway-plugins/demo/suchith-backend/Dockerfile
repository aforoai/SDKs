FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 9000
# Run as the image's built-in non-root user (uid 1000), not root (G032 / Semgrep
# dockerfile.security.missing-user). The app only reads /app and binds 9000.
USER node
CMD ["node", "server.js"]
