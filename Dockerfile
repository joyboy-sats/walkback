# Same image as Dockerfile.worker. Coolify should set the Dockerfile path to
# Dockerfile.worker. This file exists so a default `docker build` also starts
# the worker and does not serve HTTP.

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production

CMD ["node", "--conditions=react-server", "--import", "tsx", "worker/index.ts"]
