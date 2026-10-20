# One image, two Coolify services. This file starts the API.
# The worker is the same build with a different command (see Dockerfile.worker).
#
#   docker build -f Dockerfile -t walkback .
#   docker run -p 8080:8080 --env-file backend.env walkback
#
# Health: GET /health on port 8080.
# `--conditions=react-server` is required because the database client imports
# `server-only`.

FROM node:22-bookworm-slim

# Coolify's container healthcheck runs curl against localhost:8080/health.
# bookworm-slim does not include curl or wget, so the check fails and the deploy rolls back.
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
# tsx is a devDependency. Install it even when the builder sets NODE_ENV=production.
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "--conditions=react-server", "--import", "tsx", "server/index.ts"]
