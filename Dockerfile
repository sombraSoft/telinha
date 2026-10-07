# Telinha image: Bun installs, builds the page and runs the server (TypeScript
# directly, no build step for server/), which supervises livekit-server, caddy
# and cloudflared. versions.json pins all three: livekit-server and cloudflared
# are downloaded, caddy is built here from its recipe.
# Plain Dockerfile syntax so both `docker buildx build` and `podman build` work.
# Every stage but the last runs on the build platform: the page, node_modules
# (pure JS) and the downloads are arch-neutral, Go cross-compiles, so emulation
# only runs apk/setcap.

# The one Bun image every Bun stage uses, so Renovate and the version checks
# see a single line.
ARG BUN_IMAGE=oven/bun:1.4.2-alpine

FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS build
WORKDIR /app
# Manifests first so the install layer is cached until dependencies change.
COPY package.json bun.lock bunfig.toml ./
COPY server/package.json server/
COPY web/package.json web/
COPY docs/package.json docs/
RUN bun install --frozen-lockfile
COPY server server
COPY web web
RUN bun run build

# Runtime dependencies only (discord.js, livekit-server-sdk, OpenTUI + Solid):
# every web dependency is a devDependency, bundled into web/dist by Vite.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS prod-deps
ARG TARGETARCH
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY server/package.json server/
COPY web/package.json web/
COPY docs/package.json docs/
# OpenTUI's native library is per os/cpu: install the target's, not the build
# platform's. Bun installs every libc variant of that os/cpu; the image needs
# only musl (OPENTUI_LIBC below), so the glibc one goes. So does typescript,
# which Bun installs as a required peer of bun-ffi-structs (an @opentui/core
# dependency) and nothing loads at runtime.
RUN cpu=$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
  && bun install --frozen-lockfile --production --os=linux --cpu="$cpu" \
  && test -d "node_modules/@opentui/core-linux-$cpu-musl" \
  && rm -rf node_modules/typescript "node_modules/@opentui/core-linux-$cpu"

# Downloaded child binaries for the target arch, sha256-checked against
# versions.json. Repo layout kept (versions.json, scripts/, server/src/):
# server/src/bins.ts imports ../../versions.json, archive.ts, version.ts and
# releasetag.ts and nothing else of server/.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS bins
# Set by buildx and podman from --platform (default: the host's).
ARG TARGETOS TARGETARCH
WORKDIR /b
COPY versions.json ./
COPY scripts/bins.ts scripts/
COPY server/src/bins.ts server/src/archive.ts server/src/version.ts server/src/releasetag.ts server/src/
RUN bun scripts/bins.ts --os "$TARGETOS" --arch "$TARGETARCH" --out /out livekit cloudflared

# The bun binary for stages whose base image has none. A stage, not a bare
# `COPY --from=<image>`: that form resolves the image for the target platform,
# while this stage follows $BUILDPLATFORM like every other build stage here.
FROM --platform=$BUILDPLATFORM ${BUN_IMAGE} AS bun-tool

# Our Caddy: upstream Caddy plus the DuckDNS DNS module (home certificates
# without ports 80/443) and layer4, built from versions.json by scripts/caddy-build.ts.
# Go cross-compiles, so this runs on the build platform; CADDY_OS/CADDY_ARCH
# default to the target and release.yml overrides them for the Windows assets.
FROM --platform=$BUILDPLATFORM golang:1.25.14-alpine AS caddy-build
ARG TARGETOS TARGETARCH
ARG CADDY_OS=$TARGETOS
ARG CADDY_ARCH=$TARGETARCH
# bun runs the build script (JSON parsing, the xcaddy invocation); it links
# libstdc++ and libgcc, which the golang image lacks.
RUN apk add --no-cache libstdc++ libgcc
COPY --from=bun-tool /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /b
COPY versions.json ./
COPY scripts/caddy-build.ts scripts/
# bun --version first: a missing library fails here with the loader's message.
RUN bun --version && bun scripts/caddy-build.ts --os "$CADDY_OS" --arch "$CADDY_ARCH" --out /out

# `docker buildx build --target caddy-export --output type=local,dest=DIR` hands the binary to release.yml.
FROM scratch AS caddy-export
COPY --from=caddy-build /out/ /

# Same base as the build: busybox wget stays available for the compose healthcheck.
FROM ${BUN_IMAGE}
# OPENTUI_LIBC: OpenTUI does not detect musl; unset, `setup --docker` would load
# its glibc library, which Alpine cannot run.
ENV NODE_ENV=production TELINHA_HOME=/telinha OPENTUI_LIBC=musl
# libcap: caddy binds 80/443 on a VPS (direct mode) as the unprivileged bun user.
# Data dir owned by bun so a fresh named volume mounted there inherits it.
RUN apk add --no-cache libcap ca-certificates && mkdir -p /telinha/data && chown bun:bun /telinha/data
# Only the binaries: /out of bins also holds bins.ts's <name>.version sidecars,
# which do not belong on PATH.
COPY --from=bins /out/livekit-server /out/cloudflared /usr/local/bin/
COPY --from=caddy-build /out/caddy /usr/local/bin/
RUN setcap cap_net_bind_service=+ep /usr/local/bin/caddy
WORKDIR /app
COPY package.json bunfig.toml versions.json ./
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=build /app/server/package.json /app/server/tsconfig.json server/
COPY --from=build /app/server/src server/src
# bun test opens snapshot files for writing; the tests run as bun.
COPY --from=build --chown=bun:bun /app/server/test server/test
# server/test reads it (every key is a KNOWN_KEY); also a reference config for `docker run`.
COPY deploy/telinha.env.example deploy/
COPY --from=build /app/web/dist web/dist
# The smoke test ships in the image so `run --rm --entrypoint sh <tag> scripts/smoke.sh` needs no mount;
# server/test/bins.test.ts checks versions.json through scripts/versions.ts.
COPY scripts/smoke.sh scripts/versions.ts scripts/
USER bun
VOLUME /telinha/data
# The program is the entrypoint so `docker run ... <image> setup --docker` and
# `docker exec telinha bun server/src/index.ts doctor` read like the native CLI.
# No ENV for UPNP/AUTO_UPDATE: an image ENV would override telinha.env.
ENTRYPOINT ["bun", "server/src/index.ts"]
CMD ["run"]
