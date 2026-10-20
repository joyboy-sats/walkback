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

WORKDIR /app

COPY package.json package-lock.json ./
# tsx is a devDependency. Install it even when the builder sets NODE_ENV=production.
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--conditions=react-server", "--import", "tsx", "server/index.ts"]
