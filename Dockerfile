# Telinha image: Bun installs, builds the page and runs the server (TypeScript
# directly, no build step for server/), which supervises livekit-server, caddy
# and cloudflared bundled from versions.json.
# Plain Dockerfile syntax so both `docker buildx build` and `podman build` work.
# Every stage but the last runs on the build platform: the page, node_modules
# (pure JS) and the downloads are arch-neutral, so emulation only runs apk/setcap.

FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS build
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
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS prod-deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production

# Child binaries for the target arch, sha256-checked against versions.json.
# Repo layout kept: bins.ts finds versions.json one directory above itself.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS bins
# Set by buildx and podman from --platform (default: the host's).
ARG TARGETOS TARGETARCH
WORKDIR /b
COPY versions.json ./
COPY scripts/bins.ts scripts/
RUN bun scripts/bins.ts --os "$TARGETOS" --arch "$TARGETARCH" --out /out livekit caddy cloudflared

# Same base as the build: busybox wget stays available for the compose healthcheck.
FROM oven/bun:1.4.2-alpine
ENV NODE_ENV=production TELINHA_HOME=/telinha
# libcap: caddy binds 80/443 as the unprivileged bun user (direct mode).
# Data dir owned by bun so a fresh named volume mounted there inherits it.
RUN apk add --no-cache libcap ca-certificates && mkdir -p /telinha/data && chown bun:bun /telinha/data
# Only the three binaries: /out also holds bins.ts's <name>.version sidecars,
# which do not belong on PATH.
COPY --from=bins /out/livekit-server /out/caddy /out/cloudflared /usr/local/bin/
RUN setcap cap_net_bind_service=+ep /usr/local/bin/caddy
WORKDIR /app
COPY package.json bunfig.toml versions.json ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/server/package.json /app/server/tsconfig.json server/
COPY --from=build /app/server/src server/src
COPY --from=build /app/server/test server/test
# server/test reads it (every key is a KNOWN_KEY); also a reference config for `docker run`.
COPY deploy/telinha.env.example deploy/
COPY --from=build /app/web/dist web/dist
# The smoke test ships in the image so `run --rm <tag> sh scripts/smoke.sh` needs no mount.
COPY scripts/smoke.sh scripts/
USER bun
VOLUME /telinha/data
CMD ["bun", "server/src/index.ts"]
