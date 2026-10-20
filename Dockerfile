# Coolify API and worker. One image, two services, different start commands.
#
# API (default):
#   node --conditions=react-server --import tsx backend/server.ts
# Worker (set this as the Coolify start command; no port):
#   node --conditions=react-server --import tsx backend/worker.ts
#
# `--conditions=react-server` is required. `server-only` throws under plain
# Node, and the database client imports it.
#
# No HEALTHCHECK here: the worker has no port. Point Coolify's HTTP health
# check at GET /health on the API service only.

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# tsx is a devDependency. Install it even when the builder sets NODE_ENV=production.
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--conditions=react-server", "--import", "tsx", "backend/server.ts"]
