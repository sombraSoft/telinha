# Telinha

Self-hosted screen share for a Discord group. Members log in with Discord, a
role check gates entry, and the `/telinha` slash command (renamable) opens a
room at `/r/<code>` and posts its live status card in the allowed channels.
Media goes through a [LiveKit](https://livekit.io) SFU.

Why: Discord Go Live is blocked in Brazil.

One process does everything. Telinha reads one `telinha.env`, renders
`livekit.yaml` (and in direct mode a small Caddyfile) into its data dir, starts
and supervises `livekit-server`, plus `caddy` or `cloudflared` depending on the
ingress mode, gates every page behind the Discord login, relays the LiveKit
signaling WebSocket at `/livekit/*` itself, and restarts LiveKit when the
public IP changes. The Docker image bundles the three binaries; compose runs
one service.

## Architecture

Telinha is the only HTTP front in every mode: Caddy (direct mode) only
terminates TLS, cloudflared (tunnel mode) only carries traffic. The login gate
and all routing live in telinha.

`INGRESS=direct` (bundled Caddy gets a Let's Encrypt certificate):

```
browser --> caddy :443 (TLS; :80 redirects)           child of telinha
              --> telinha 127.0.0.1:8081 (LISTEN)
                    /healthz      --> answered, no login
                    /auth/*       --> OAuth login, /auth/members (no gate)
                    everything    --> gate: Discord login + role
                      /livekit/rtc* --> LiveKit 127.0.0.1:7880   (signaling relay, WebSocket)
                      /r/<code>     --> room page
                      /             --> redirect to /r/

media: browser <--> LiveKit   TCP 7881 / UDP 7882 (forwarded on the router)
```

`INGRESS=tunnel` (Cloudflare Tunnel, no inbound HTTP ports):

```
browser --> Cloudflare --> cloudflared                child of telinha
              --> telinha 127.0.0.1:8081 --> (same routes as above)

media: browser <--> LiveKit   TCP 7881 / UDP 7882 (forwarded on the router)
```

`INGRESS=external` (your own nginx, Traefik, Caddy, ...):

```
browser --> your proxy (TLS, WebSocket, X-Forwarded-For)
              --> telinha LISTEN --> (same routes as above)

media: browser <--> LiveKit   TCP 7881 / UDP 7882 (forwarded on the router)
```

The supervised children write their output into telinha's log as
`[livekit] ...`, `[caddy] ...`, `[cloudflared] ...`. A child that crashes is
restarted with backoff (1 s doubling up to 60 s, reset after a minute of
uptime) and never given up on. If LiveKit does not answer within 30 s at start,
telinha stops the other children and exits 1. Only signaling goes through the
relay (a few KB/s per client); media flows directly between the browser and
LiveKit on the media ports. The relay forwards only `/livekit/rtc` and
`/livekit/rtc/*`; anything else under `/livekit/` (notably LiveKit's Twirp
API) is a 404.

`/healthz` is never gated. Its full body (`ok`, `discord`, `dev`, `rooms`,
`children`) only goes to local callers (the compose healthcheck,
`telinha-update`, the smoke test); a request carrying `X-Forwarded-For`,
`X-Forwarded-Host`, `Forwarded` or `Cf-Connecting-Ip` gets `{ "ok": true }`.

## Layout

| Path | What |
| --- | --- |
| `server/` | Bun TypeScript server, run directly (no build step): `index.ts` entry (loads `telinha.env`, starts the children, serves HTTP), `config.ts` env parsing and validation, `envfile.ts` `telinha.env` parser, `paths.ts` home/bin/config/data dirs and binary lookup, `supervisor.ts` child processes, `children.ts` which children a mode needs, `render.ts` `livekit.yaml` and Caddyfile, `ipwatch.ts` public IP watch, `proxy.ts` `/livekit/*` relay, `http.ts` gate and routes, `auth.ts` sessions/OAuth, `roles.ts` role check, `livekit.ts` tokens and RoomService calls, `codes.ts` room codes, `rooms.ts` room registry (SQLite), `lifecycle.ts` room poller, `card.ts` the status card, `members.ts` the member directory, `static.ts` page serving, `pages.ts` HTML pages, `bot.ts` Discord bot, `i18n.ts` strings, tests in `test/` |
| `web/` | Svelte 5 + TypeScript room page on plain Vite (`src/App.svelte`, `components/`, `lib/`, `styles/`), served under `/r/`; `bun run build` writes `web/dist` |
| `versions.json` | Pinned `livekit-server`, `caddy` and `cloudflared` versions with the sha256 of every asset (linux amd64/arm64, windows amd64) |
| `scripts/bins.ts` | Downloads and sha256-verifies the child binaries from `versions.json` (dev, the Docker build) |
| `scripts/versions.ts` | `check` (CI) and `refresh` (after a version bump) for `versions.json` |
| `scripts/dev.ts`, `stack.ts` | Local dev: fetches `livekit-server`, starts the Bun server (which supervises it) and Vite, cleans up on exit; `stack.ts --e2e` is Playwright's web server |
| `scripts/image.ts`, `smoke.sh` | `bun run image`: local container build plus the smoke test (`smoke.sh` ships in the image) |
| `e2e/` | Playwright specs (`*.e2e.ts`): login, routes and redirects, screen share between two browser contexts, language and theme, the member list, room closing |
| `Dockerfile` | Multi-stage, multi-arch build (page build, prod deps, binaries, Bun alpine runtime with the three binaries) |
| `deploy/` | Docker host side: `compose.yml`, `compose.journald.yml`, `telinha.env.example`, `install-docker.sh`, `telinha-update` and its systemd service/timer |
| `.github/workflows/` | `ci.yml`, `release.yml` |

## Development

Needs only [Bun](https://bun.sh) 1.4.2 (no Node). Works on Windows and Linux.

```
bun install --frozen-lockfile
bun run dev                # http://localhost:5173/r/ (Vite HMR + Bun server, which runs LiveKit)
bun run typecheck          # tsc and svelte-check
bun run test               # bun test: server and web unit tests
bun run build              # web/dist
bun run e2e                # Playwright; needs bun run build first, and a Chromium (bunx playwright install chromium)
bun run image              # build telinha:dev with docker or podman, then run the smoke test
bun run bins               # download all three child binaries for this host into .cache/telinha/bin
bun run versions check     # validate versions.json (refresh: recompute every hash)
```

`bun run dev` downloads `livekit-server` (pinned in `versions.json`,
sha256-verified) into `.cache/telinha/bin` on first run and starts the server
with `TELINHA_HOME=.cache/telinha`, `INGRESS=external`, `MEDIA=self` and
`LIVEKIT_NODE_IP=127.0.0.1`, so the server supervises LiveKit exactly as in
production and LiveKit advertises loopback instead of a STUN-discovered public
IP (it may still list the host's own IPv6 addresses). Vite proxies `/auth` and
`/livekit` (WebSocket included) to the server on `127.0.0.1:8081`, so the
browser goes through the real gate and signaling relay.

The server runs with `DEV_USER` set (default `1:Dev`, i.e. `<id>:<name>`), a
fake login that skips Discord and the bot. It is refused unless `PUBLIC_URL`
is `http://localhost` or `http://127.0.0.1`, `LISTEN` is a loopback address and
`INGRESS` is `external` (the default when `DEV_USER` is set), and in that mode
every request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` gets a
421, so a reverse proxy in front of it (or a DNS-rebinding page) never reaches
the fake login. Set `DEV_LOCALE=en` or `pt-BR` to force the locale. There is
no slash command in dev, so any valid room code (`/r/test1`, `/r/lamo-futi`)
opens a room on first use, and the member list is a fixed preview (the dev
user plus seven made-up members, some offline); a room still closes like a
real one (`CLOSE_EMPTY_SECONDS=30 bun run dev` to watch that happen). The dev
registry lives in `.cache/telinha/data/`; the E2E stack uses
`.cache/e2e-data/` with a fresh registry each run (its `run/children.json`
is kept, so a `livekit-server` left behind by a killed run is cleaned up)
and `CLOSE_EMPTY_SECONDS=4`, `POLL_SECONDS=1`; the browser reaches LiveKit through `ws://localhost:8081/livekit` like production.

## Configuration

Everything lives in one `KEY=value` file, `telinha.env`
([`deploy/telinha.env.example`](deploy/telinha.env.example) lists every key
with comments). Real environment variables override the file; one set to the
empty string does not. A key the server does not know logs
`config: unknown key FOO in telinha.env` and is otherwise ignored.

**Quoting.** Docker compose's `env_file` interpolates `$VAR`, processes `\`
escapes in double quotes and strips ` #...` comments; telinha's own parser
reads values literally. The one spelling both read the same is a single-quoted
value, so **single-quote every value containing `$`, `\` or `#`**
(`COOKIE_SECRET='a$b#c'`). Telinha warns at start about an unquoted one. The
example file single-quotes every secret placeholder.

Identity and Discord:

| Key | Default | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | required | Bot token |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | required | OAuth app; redirect `<PUBLIC_URL>/auth/callback` |
| `GUILD_ID`, `ROLE_ID` | required | One guild per deployment; members with the role may enter |
| `CHANNEL_IDS` | required | Comma list; the slash command works only there |
| `COMMAND_NAME` | `telinha` | Slash command name: lowercase, 1-32 letters, digits, `-` or `_` |
| `GROUP_NAME` | guild name | Shown in pages and the command's replies |
| `COOKIE_SECRET` | required | `openssl rand -base64 48` |
| `SESSION_DAYS` | `7` | Login session length |
| `ROLE_CACHE_SECONDS` | `300` | Role check cache |

Public URL and ingress:

| Key | Default | Notes |
| --- | --- | --- |
| `PUBLIC_URL` | required | `https://host[:port]`; `http://localhost[:port]` only with `DEV_USER` |
| `INGRESS` | `direct` (`external` with `DEV_USER`) | `direct`, `tunnel` or `external` |
| `LISTEN` | `127.0.0.1:8081` | Telinha's own listener; Caddy, cloudflared or your proxy forward here |
| `HTTP_PORT` | `80` | direct: HTTP->HTTPS redirect port; `0` turns the redirect listener off |
| `HTTPS_PORT` | `443` | direct: the port Caddy binds for TLS |
| `ACME_EMAIL` | none | direct, optional: Let's Encrypt account email |
| `TUNNEL_TOKEN` | required in tunnel | Cloudflare tunnel token |

Media:

| Key | Default | Notes |
| --- | --- | --- |
| `MEDIA` | `self` | `self` runs the bundled LiveKit; `cloud` is reserved (phase 5) and rejected |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | required | Any pair you make up (secret 32+ chars); handed to LiveKit through its environment |
| `LIVEKIT_PORT` | `7880` | LiveKit signaling/API, loopback only |
| `MEDIA_TCP_PORT` | `7881` | ICE over TCP; forward it on the router |
| `MEDIA_UDP_PORT` | `7882` | ICE over UDP; forward it on the router |
| `LIVEKIT_NODE_IP` | none | Static public IPv4: skips STUN and turns the IP watch off |
| `LIVEKIT_API_URL` | `http://127.0.0.1:<LIVEKIT_PORT>` | LiveKit HTTP API as telinha reaches it |
| `LIVEKIT_PUBLIC_URL` | `PUBLIC_URL` as `ws(s)://` + `/livekit` | Signaling URL the browser uses (telinha's relay) |
| `IP_WATCH_SECONDS` | `300` | Public IP check interval; `0` off |

Rooms and locations:

| Key | Default | Notes |
| --- | --- | --- |
| `CLOSE_EMPTY_SECONDS` | `300` | A room closes for good after this long empty |
| `POLL_SECONDS` | `5` | How often rooms are checked |
| `TELINHA_HOME` | per platform (below) | Root of `bin/ config/ data/ logs/`; the image sets `/telinha` |
| `TELINHA_ENV` | `<home>/config/telinha.env` | Which file to load; only as a real environment variable |
| `DATA_DIR` | `<home>/data` | Registry, rendered configs (`run/`), Caddy certificates (`caddy/`) |
| `BIN_DIR` | `<home>/bin` | Looked at before `PATH` for the child binaries |
| `WEB_DIR` | `web/dist` next to the sources | Built page |

Dev only: `DEV_USER`, `DEV_LOCALE` (see Development). Reserved and accepted
without a warning, but not used yet: `DDNS_PROVIDER`, `DUCKDNS_TOKEN`,
`DUCKDNS_DOMAIN`, `UPNP`, `AUTO_UPDATE`, `LOCALE` (phase 2), `LIVEKIT_CLOUD_URL`,
`TURN_TLS_PORT` (phase 5).

Validation fails start-up with one line (`telinha: bad INGRESS ...`,
`ports collide: MEDIA_TCP_PORT=7881, LISTEN=7881`, ...): `direct` and `tunnel`
need an `https://` `PUBLIC_URL`; `LIVEKIT_PORT`, both media ports, the `LISTEN`
port and (direct) `HTTPS_PORT`/`HTTP_PORT` must all differ.

Where the file lives (`TELINHA_HOME` moves the whole tree, `TELINHA_ENV` just
the file):

| Platform | `telinha.env` |
| --- | --- |
| Linux Docker host | `/opt/telinha/config/telinha.env` (compose passes it as the environment via `env_file`) |
| Linux, as root | `/opt/telinha/config/telinha.env` |
| Linux, as a user | `~/.local/share/telinha/config/telinha.env` (`$XDG_DATA_HOME` respected) |
| Windows | `%LOCALAPPDATA%\Telinha\config\telinha.env` |

Inside the container `TELINHA_HOME=/telinha` and there is no file there (the
log says `config: no telinha.env at /telinha/config/telinha.env, environment
only`); that is expected, compose already handed the file over as variables.

The tree under the home dir:

| Path | What |
| --- | --- |
| `bin/` | `livekit-server`, `caddy`, `cloudflared` (`.exe` on Windows); `PATH` is tried after it |
| `config/telinha.env` | The configuration |
| `data/telinha.sqlite` | Room registry |
| `data/run/` | Rendered `livekit.yaml` and `Caddyfile` (rewritten before every child start: edit `telinha.env`, never these), `children.json` pidfile, `public-ip` (last IP seen by the watch) |
| `data/caddy/` | Caddy's certificates and ACME account (direct mode) |
| `logs/` | Reserved; nothing is written there yet |

Binaries: a missing one stops start-up with
`livekit-server not found: put it in <bin> (bun scripts/bins.ts livekit) or on PATH`.
To run natively from a clone today (phase 2 brings real installers):
`bun scripts/bins.ts --out <home>/bin`, `bun run build`, then
`bun server/src/index.ts`.

What children get from the environment: telinha's own environment minus every
`telinha.env` key and minus anything starting with `LIVEKIT_`, `TUNNEL_`,
`DISCORD_` or `TELINHA_` (the Go binaries read such variables as flags).
`PATH`, `HOME`, `TEMP`, `SystemRoot`, `LANG`, proxy settings and so on pass
through. On top of that each child gets only what it needs: LiveKit
`LIVEKIT_KEYS` (built from the API key pair), cloudflared `TUNNEL_TOKEN`, Caddy
`XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`HOME` pointed at `data/caddy`. No secret is
ever in a child's command line (visible in `ps`) or in a rendered file.

## Ingress modes and media

**direct.** The bundled Caddy gets a certificate for the `PUBLIC_URL` host and
proxies everything to `LISTEN`. Point the DNS name at your public IP and
forward TCP `HTTP_PORT` (80, for the ACME challenge and the redirect) and TCP
`HTTPS_PORT` (443) to the host, plus the two media ports. Router port
translation works: with `PUBLIC_URL=https://telinha.example.com` (public 443) and
the router mapping 443 to the host's 8443, set `HTTPS_PORT=8443`. A
`PUBLIC_URL` port that differs from `HTTPS_PORT` is only a warning
(`config: PUBLIC_URL port 443 differs from HTTPS_PORT 8443; assuming the router
translates 443 -> 8443`), never an error. In the image Caddy has
`cap_net_bind_service`, so it binds 80/443 as the unprivileged `bun` user.

**tunnel.** No inbound HTTP ports. Cloudflare Zero Trust -> Networks ->
Tunnels -> create a tunnel, copy its token into `TUNNEL_TOKEN` (uncomment it), and give it a
public hostname whose service is `http://localhost:<LISTEN port>` (default
`http://localhost:8081`). No Caddy runs in this mode.

**external.** Your proxy terminates TLS and forwards to `LISTEN`. It must pass
WebSocket upgrades (the signaling relay at `/livekit/rtc`) and must set
`X-Forwarded-For` (every mainstream proxy does by default): telinha uses the
forwarding headers to tell a public `/healthz` request from a local one. The
gate is still telinha's; `/auth/check` remains available if your proxy wants a
`forward_auth` of its own.

**Media (`MEDIA=self`).** Browsers send media straight to LiveKit, so forward
TCP `MEDIA_TCP_PORT` (7881) and UDP `MEDIA_UDP_PORT` (7882) to the host in
every ingress mode (tunnels do not carry WebRTC). LiveKit learns its public IP
through STUN once at start; on a residential line the IP watch polls
`https://1.1.1.1/cdn-cgi/trace` (then `https://api.ipify.org`) every
`IP_WATCH_SECONDS` and restarts the LiveKit child when the IP changes (rooms
blip, see Room lifecycle). With a static IP set `LIVEKIT_NODE_IP` instead.

No domain yet: phase 2 adds DuckDNS (dynamic IP) and sslip.io (static IP)
support to the setup; until then any DNS name pointing at the host works,
DuckDNS included if you update it yourself. Behind CGNAT (the router's WAN IP
is not the one `1.1.1.1/cdn-cgi/trace` shows) port forwarding cannot work: run
Telinha on a small VPS, or wait for LiveKit Cloud media (phase 5).

## Room lifecycle

A Telinha link does not live forever:

- Only the slash command (`/telinha`, or `COMMAND_NAME`) creates rooms. Each
  gets a pronounceable code like `lamo-futi` (two words of two
  consonant-vowel syllables, about 25 bits; six syllables once codes start to
  collide), checked against the registry, and lives at
  `<PUBLIC_URL>/r/lamo-futi`. The server records the room in
  `DATA_DIR/telinha.sqlite`, creates it in LiveKit through the RoomService API
  and posts the card. LiveKit runs with `room.auto_create: false`, so an old
  token cannot bring a closed room back, and tokens last 10 minutes anyway
  (LiveKit refreshes them for connected participants). The code is not the
  secret: the login gate is.
- Every `POLL_SECONDS` the server lists the participants of each open room.
  The slash command's message is a live card: who is streaming (with the
  quality the page reports, e.g. `1080p60 · H265`), who is watching, and since
  when. It is edited only when it changes, at most every 5 s, without pinging
  anyone. Editing goes through the bot's REST API, so the bot needs **View
  Channel** and **Read Message History** in the command's channels
  (slash-command replies alone need neither). Without them the card stays as
  posted (logged once as "card not editable"), and everything else works.
- A room closes for good after `CLOSE_EMPTY_SECONDS` with nobody in it, or
  that long after the command when nobody ever joined. The server deletes the
  LiveKit room and turns the card into a summary (how long it lasted, everyone
  who came) without the button.
- The page needs a room from the command: `/r/` alone, or an unknown or closed
  room, shows a notice pointing to `/<command>` (the token endpoint answers 404
  or 410).
- `/` redirects to `/r/`.

While a room is open the server keeps it in LiveKit, so a LiveKit restart (the
in-process IP watch, a crash, an update recreating the container) only blips
it: the page fetches a new token and rejoins once (a stream has to be shared
again).

Card edits use the bot token, so the bot must still see the channel. If the
message is deleted, or the bot can't edit it (403), the room keeps its
lifecycle and the card is left alone. A closed card that could not be sent
yet is retried after a restart.
The registry is the `telinha-data` volume in `deploy/compose.yml`; losing it
only means the links of rooms open at that moment stop working.

The page has four themes (Dark, Ash, Onyx, Light; "system" follows the OS) and
two languages (pt-BR, en). Both are picked in the top bar and kept in
`localStorage`. By default the language comes from the Discord locale of the
logged-in user, and the bot answers in the invoker's locale (ephemeral) or the
server locale (public post).

Streams use AV1 when the browser has a hardware encoder for it, else H.265
(Chrome only offers it with one), else H.264, always with an H.264 backup for
viewers that can't decode the first choice. Hardware HEVC (seen with NVIDIA on
Windows) sends nothing when any simulcast layer has an odd width or height, so
the page crops each frame to a multiple of 8 and the lower layers are exactly
1/2 and 1/4 of it. Known gap: shrinking a live share well below 960 px wide
drops the top layer (#9).

`bun run image` picks docker, else podman (starting the podman machine if it is
stopped). The smoke test (`scripts/smoke.sh`, also run by the CI `image` job)
runs inside the image: the server tests, the built page, `--version` of the
three binaries, then the real entry point in `DEV_USER` mode until `/healthz`
reports `"livekit":"up"`, a forwarded `/healthz` without `children`, the gate
(`/r/` redirects to the login, then serves the page with the command meta) and
a 404 for `/livekit/` outside the `/rtc` allowlist.

## Member list

Beside who is in the room, the people list shows everyone else with the role,
Discord style: **Online** (online, idle, do not disturb) and **Offline**
(collapsed until opened; the choice is kept in `localStorage`). The page polls
`GET /auth/members` every 15 s while the tab is visible; it answers
`{ members: [{ id, name, avatar, status }] }` (`no-store`), 401 without a
session and 403 without the role, checked by the handler itself since the gate
lets `/auth/*` through. Until the bot has loaded the guild the list is empty.

The bot fetches the guild's members once per gateway session and keeps the
directory current from member and presence events, so it needs two
**privileged intents**: Developer Portal -> the app -> Bot -> **Server Members
Intent** and **Presence Intent**. Without them the bot fails to log in
("disallowed intents"). Only the role members' presences are cached.

## Running with Docker (Linux)

Needs Docker Engine with the compose plugin. The image
`ghcr.io/sombrasoft/telinha` is multi-arch (`linux/amd64`, `linux/arm64`) and
bundles `livekit-server`, `caddy` and `cloudflared`. The host keeps everything
in `/opt/telinha`:

| Path | What |
| --- | --- |
| `/opt/telinha/compose.yml` | One service, `telinha`, host networking, `init: true`, volume `telinha-data` at `/telinha/data` |
| `/opt/telinha/compose.journald.yml` | Optional override: journald logging, tag `telinha` |
| `/opt/telinha/compose.override.yml` | Yours, optional; compose (and `telinha-update`) pick it up automatically |
| `/opt/telinha/config/telinha.env` | The configuration (`chmod 600`) |
| `/opt/telinha/.env` | `TELINHA_VERSION`, `TELINHA_DIGEST`, written by `telinha-update`; without it compose runs `latest` |
| `/opt/telinha/pin`, `deferred` | `telinha-update` state |

With the installer, from a clone or from the release tarball:

```
git clone https://github.com/sombraSoft/telinha && cd telinha/deploy
# or: curl -fsSLO https://github.com/sombraSoft/telinha/releases/latest/download/telinha-deploy.tar.gz
#     mkdir telinha-deploy && tar xzf telinha-deploy.tar.gz -C telinha-deploy && cd telinha-deploy
sh install-docker.sh
```

`install-docker.sh` (run as root) is idempotent: it creates `/opt/telinha` and
`/opt/telinha/config` (mode 700), copies `compose.yml` and
`compose.journald.yml` (always, they are ours), creates `config/telinha.env`
from the example only if it is missing (mode 600), installs `telinha-update`
into `/usr/local/sbin` and its units into `/etc/systemd/system`. It warns while
`telinha.env` still has empty or `<placeholder>` values. Fill it in, then
either start once by hand:

```
cd /opt/telinha && docker compose up -d
```

or let `telinha-update` deploy and keep it current:

```
sh install-docker.sh --auto-update     # enables telinha-update.timer once telinha.env is filled in
```

By hand without the installer: create `/opt/telinha/config`, copy
`deploy/compose.yml` to `/opt/telinha/` and `deploy/telinha.env.example` to
`/opt/telinha/config/telinha.env`, fill it in, `docker compose up -d`.

The compose healthcheck fetches `http://127.0.0.1:8081/healthz` and fails while
any child (livekit, caddy, cloudflared) is down and waiting to restart, so a
Caddy that cannot bind 80/443 or a bad tunnel token turns the container
unhealthy (and `telinha-update` rolls back). If you change the `LISTEN` port,
override the healthcheck in `compose.override.yml` too.

Logs:

```
docker logs -f telinha            # default json-file logging: telinha plus [livekit], [caddy], [cloudflared]
cp /opt/telinha/compose.journald.yml /opt/telinha/compose.override.yml
journalctl -t telinha             # with the journald override: survives container recreation
journalctl -t telinha-update
```

The server logs logins (and why one failed), slash commands, rooms and child
restarts. To cap memory add `mem_limit` (e.g. `1g`, LiveKit runs inside)
under `services: telinha:` in `compose.override.yml`; one override file holds
both that and the journald logging.

### Updates

By hand: `cd /opt/telinha && docker compose pull && docker compose up -d`
(follows `latest`, or the `TELINHA_VERSION` in `.env`).

Neither path touches `/opt/telinha/compose.yml`: it only changes when you
re-run `install-docker.sh` from a newer clone or `telinha-deploy.tar.gz`. Do
that when a release's notes mention a compose change.

Or with `telinha-update` (opt-in systemd timer: 3 minutes after boot, then
every 5 minutes). No git is involved; everything comes from the GitHub
release:

```
telinha-update                  # deploy the pinned tag, else the newest stable release
telinha-update --now            # same, but do not wait for open rooms
telinha-update status           # pin, deployed version + digest, newest stable, deferral
telinha-update pin v0.6.0       # hold at a tag (pre-releases like v0.7.0-rc.1 too), deploy now
telinha-update unpin            # follow the newest stable release again, deploy now
```

Every subcommand needs root (`/opt/telinha` is mode 700). `pin` checks that
the release exists first. A run takes the target (pin, else GitHub's latest
release, which excludes
pre-releases), fetches the image digest published with that release
(`telinha-image.digest`; missing means the image job is still running, retried
next tick), pulls `ghcr.io/sombrasoft/telinha:<version>` and the same image
`@<digest>`, and refuses to deploy (and removes the pulled tag) when the two
are not the same image. Then
`docker compose up -d --remove-orphans --wait --wait-timeout 180` in
`/opt/telinha`, and only after the healthcheck passes it records the version
and digest in `.env` and removes the previous image.

When the new version never turns healthy, `telinha-update` rolls back to the
previous one (`.env` still names it and its image is still there) and records
the tag in `/opt/telinha/failed` (shown by `status`). The timer then skips that
tag until a newer release comes out, so the host does not bounce between
versions every 5 minutes; `--now`, `pin` and `unpin` try it again. A first
deploy has nothing to roll back to: fix `telinha.env`, then `telinha-update --now`.

While rooms are open (`/healthz` on the `LISTEN` port reports `rooms` > 0) a
deploy waits, but at most `MAX_DEFER_HOURS` (default 12) per target: a room
stuck open must not block the release that fixes it. `--now` skips the wait.
An unreachable `/healthz` does not defer (nothing running to protect).

Tunables go in a drop-in (`systemctl edit telinha-update.service`, which
`install-docker.sh` never overwrites) as `Environment=` lines, or in the shell
for a by-hand run:

| Variable | Default | Effect |
| --- | --- | --- |
| `TELINHA_DIR` | `/opt/telinha` | Where compose and the state live |
| `MAX_DEFER_HOURS` | `12` | Longest wait for open rooms per target |
| `VERIFY_ATTESTATION` | unset | `1`: also `gh attestation verify` the digest; needs `gh` on `PATH` and authenticated (`GH_TOKEN` in the drop-in or `gh auth login` as root), else the deploy is refused |
| `ALLOW_UNVERIFIED` | unset | `1`: skip the published-digest check (escape hatch, logged loudly) |

### Windows Docker Desktop

`network_mode: host` needs Docker Desktop 4.34 or newer with
**Settings -> Resources -> Network -> Enable host networking** turned on.
WebRTC media over UDP through that path is unverified. Use `INGRESS=tunnel`
there (nothing to bind on 80/443). Native Windows binaries come in phase 2.
`install-docker.sh` and `telinha-update` are Linux only.

## Releases

1. Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org).
2. release-please keeps a Release PR open with the version bump and changelog.
3. Merging it creates the tag `vX.Y.Z` and a GitHub release.
4. The same workflow builds `linux/amd64` and `linux/arm64` and pushes
   `ghcr.io/sombrasoft/telinha` tagged `X.Y.Z`, `X.Y` and `latest`, with a
   provenance attestation on the index digest.
5. It then uploads two release assets: `telinha-image.digest` (the index
   digest, one `sha256:...` line; `telinha-update` trusts nothing else) and
   `telinha-deploy.tar.gz` (`compose.yml`, `compose.journald.yml`,
   `telinha.env.example`, `install-docker.sh`, `telinha-update` and its
   units).
6. Hosts running `telinha-update` pick the new release up within about 5
   minutes of the digest being uploaded (later while rooms are open).

Pre-releases: add a `Release-As: X.Y.Z-rc.N` footer to a commit. `release.yml`
marks hyphenated tags as GitHub pre-releases, and the image gets only the
`X.Y.Z-rc.N` tag (no `latest`, no `X.Y`). `telinha-update` ignores them unless
pinned with `telinha-update pin`.

Required checks on `main`: `test (ubuntu-latest)`, `test (windows-latest)`,
`lint` (shellcheck of `deploy/install-docker.sh`, `deploy/telinha-update` and
`scripts/smoke.sh`, actionlint, `bun scripts/versions.ts check`), `gitleaks`,
`image` (builds both architectures, smoke-tests amd64). The `e2e` job
(Playwright on ubuntu) also runs on every PR but is not required yet.

Renovate runs weekly (early Monday, America/Sao_Paulo) for Bun deps, the
Dockerfile, `deploy/compose.yml`, GitHub Actions and the three binaries in
`versions.json`. Non-major updates are grouped and automerge through a PR once
checks pass. Anything LiveKit (`livekit-client`, `livekit-server-sdk`,
`livekit/livekit`) and all majors are manual. `versions.json` bumps never
automerge: Renovate changes only the `version`, so the hashes are stale and
the `image` and `e2e` jobs fail until someone refreshes them on the Renovate
branch:

```
git fetch origin && git switch <renovate branch>
bun scripts/versions.ts refresh    # downloads every asset, rewrites the sha256 values (cross-checks upstream checksums)
git commit -am "fix(deps): refresh versions.json hashes" && git push
```

Caddy and cloudflared bumps come as one `child-binaries` PR, LiveKit's in the
`livekit` group; all `versions.json` bumps are `fix` commits so they cut a
release.

Versions stay below 1.0. `bump-minor-pre-major` is on, so while in 0.x a
`fix` bumps the patch and a `feat` or breaking change bumps the minor. 1.0.0
only happens when a commit carries a `Release-As: 1.0.0` footer.

## Roadmap

- Phase 1 (done): one supervised process, `telinha.env`, ingress
  modes, in-process IP watch, multi-arch image, `/r/<code>` rooms,
  `telinha-update`.
- Phase 2, install: native Windows and Linux binaries, `telinha setup` wizard,
  one-line installers, `telinha doctor` and a `/doctor` page, UPnP/NAT-PMP,
  DuckDNS, native auto-update, Windows service and Linux systemd unit.
- Phase 3, docs: a Starlight site in English and pt-BR, published on release.
- Phase 4, Windows extras: tray app, signed binaries.
- Phase 5, media extras: LiveKit Cloud (`MEDIA=cloud`), TURN over TLS on 443
  via caddy-l4.

## License

MIT
