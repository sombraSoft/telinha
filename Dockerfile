# Telinha image: Bun installs and builds, Node 22 runs (same runtime as before).
# Plain Dockerfile syntax so both `docker buildx build` and `podman build` work.

FROM oven/bun:1.4.2-alpine AS build
WORKDIR /app
# Manifests first so the install layer is cached until dependencies change.
COPY package.json bun.lock bunfig.toml ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile
COPY server server
COPY web web
RUN bun run build

# Runtime dependencies only (discord.js, livekit-server-sdk; livekit-client is
# already copied into web/dist).
FROM oven/bun:1.4.2-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production

FROM node:22.23.3-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/server server
COPY --from=build /app/web/dist web/dist
USER node
CMD ["node", "server/src/index.js"]
