# Telinha image: Bun installs, builds the page and runs the server (TypeScript
# directly, no build step for server/).
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

# Runtime dependencies only (discord.js, livekit-server-sdk): every web
# dependency is a devDependency, bundled into web/dist by Vite.
FROM oven/bun:1.4.2-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production

# Same base as the build: busybox wget stays available for the compose healthcheck.
FROM oven/bun:1.4.2-alpine
ENV NODE_ENV=production
# Room registry. Owned by bun so a fresh named volume mounted here inherits it.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
WORKDIR /app
COPY package.json bunfig.toml ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/server/package.json /app/server/tsconfig.json server/
COPY --from=build /app/server/src server/src
COPY --from=build /app/server/test server/test
COPY --from=build /app/web/dist web/dist
USER bun
CMD ["bun", "server/src/index.ts"]
