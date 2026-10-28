# Cloud Run image for the Aforo Apigee Pub/Sub forwarder.
# Build from this directory: docker build -t <region>-docker.pkg.dev/<project>/aforo/apigee-pubsub-forwarder:3.1.0 .
FROM node:20.18.1-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY src ./src
USER node
CMD ["node", "src/server.js"]
