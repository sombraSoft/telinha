# Telinha

Self-hosted screen share for a Discord group. Members log in with Discord, a
role check gates entry, and the `/tela` slash command opens a room and posts
its live status card in the allowed channels. Media goes through a
[LiveKit](https://livekit.io) SFU.

Why: Discord Go Live is blocked in Brazil.

## Architecture

```
browser --> Cloudflare Tunnel (cloudflared)
              --> Caddy 127.0.0.1:8080
                    /auth/*      --> telinha 127.0.0.1:8081   (OAuth login, no gate)
                    everything   --> forward_auth telinha /auth/check (Discord login + role)
                      /livekit/* --> LiveKit 127.0.0.1:7880   (signaling, WebSocket)
                      /sala*     --> telinha                  (room page)
                      other      --> redirect to /sala/

media: browser <--> LiveKit   TCP 7891 / UDP 7892 (forwarded on the router)
```

All containers use host networking. `/healthz` on telinha is only used by the
compose healthcheck; Caddy never routes it publicly.

## Layout

| Path | What |
| --- | --- |
| `server/` | Bun TypeScript server, run directly (no build step): `index.ts` entry, `config.ts` env parsing, `http.ts` routes, `auth.ts` sessions/OAuth, `roles.ts` role check, `livekit.ts` tokens and RoomService calls, `rooms.ts` room registry (SQLite), `lifecycle.ts` room poller, `card.ts` the `/tela` status card, `static.ts` page serving, `pages.ts` HTML pages, `bot.ts` Discord bot, `i18n.ts` strings, tests in `test/` |
| `web/` | Svelte 5 + TypeScript room page on plain Vite (`src/App.svelte`, `components/`, `lib/`, `styles/`); `bun run build` writes `web/dist` |
| `scripts/dev.ts`, `stack.ts`, `livekit.ts` | Local dev: downloads and starts `livekit-server --dev`, starts the Bun server and Vite, cleans up on exit |
| `scripts/image.ts` | `bun run image`: local container build plus smoke test |
| `e2e/` | Playwright specs (`*.e2e.ts`): login, screen share between two browser contexts, language and theme, room closing |
| `Dockerfile` | Multi-stage build (Bun build, prod deps, Bun alpine runtime) |
| `deploy/` | Host side: `compose.yml`, `Caddyfile`, `livekit.yaml`, `env/*.example`, `install.sh`, `pin.sh` |
| `deploy/updater/` | `tela-update` and its systemd service/timer (pull-based CD) |
| `deploy/ipwatch/` | `tela-ipwatch`: restarts LiveKit when the residential public IP changes |
| `.github/workflows/` | `ci.yml`, `release.yml` |

## Development

Needs only [Bun](https://bun.sh) 1.4.2 (no Node). Works on Windows and Linux.

```
bun install --frozen-lockfile
bun run dev        # http://localhost:5173/sala/ (Vite HMR + Bun server + LiveKit)
bun run typecheck  # tsc and svelte-check
bun run test       # bun test: server and web unit tests
bun run build      # web/dist
bun run e2e        # Playwright; needs bun run build first, and a Chromium (bunx playwright install chromium)
bun run image      # build telinha:dev with docker or podman, then run the smoke test
```

`bun run dev` downloads `livekit-server` (pinned in `scripts/livekit.ts`,
sha256-verified) into `.cache/` on first run and starts it with `--dev`. The
server runs with `DEV_USER` set (default `1:Dev`, i.e. `<id>:<name>`), a fake
login that skips Discord and the bot. It is refused unless `PUBLIC_URL` is
`http://localhost` or `http://127.0.0.1` and `LISTEN` is a loopback address,
and in that mode every request whose `Host` is not `localhost`, `127.0.0.1` or
`[::1]` gets a 421, so a reverse proxy in front of it (or a DNS-rebinding page)
never reaches the fake login. Set `DEV_LOCALE=en` or `pt-BR` to force the
locale. There is no `/tela` in dev, so any valid room name
(`/sala/?room=test1`) opens a room on first use; it still closes like a real
one (`CLOSE_EMPTY_SECONDS=30 bun run dev` to watch that happen). The dev
registry lives in `.cache/data/`; the E2E stack uses a fresh `.cache/e2e-data/`
with `CLOSE_EMPTY_SECONDS=4` and `POLL_SECONDS=1`.

Optional env vars (all listed, commented out, in `deploy/env/app.env.example`):
`GROUP_NAME` (name shown in the UI and bot replies; defaults to the guild
name), `LIVEKIT_PUBLIC_URL` (signaling URL the browser uses; defaults to
`PUBLIC_URL/livekit` as ws/wss), `LIVEKIT_API_URL` (LiveKit HTTP API the server
calls; default `http://127.0.0.1:7880`), `CLOSE_EMPTY_SECONDS` (default 300),
`POLL_SECONDS` (default 5) and `DATA_DIR` (room registry; `/data` in the
image, `.cache/data/` otherwise).

## Room lifecycle

A Telinha link does not live forever:

- Only `/tela` creates rooms. The server records the room in
  `DATA_DIR/telinha.sqlite`, creates it in LiveKit through the RoomService API
  and posts the card. LiveKit runs with `room.auto_create: false`, so an old
  token (they last 6 h) cannot bring a closed room back.
- Every `POLL_SECONDS` the server lists the participants of each open room.
  The `/tela` message is a live card: who is streaming (with the quality the
  page reports, e.g. `1080p60 · H265`), who is watching, and since when. It is
  edited only when it changes, at most every 5 s, without pinging anyone.
- A room closes for good after `CLOSE_EMPTY_SECONDS` with nobody in it, or
  that long after `/tela` when nobody ever joined. The server deletes the
  LiveKit room and turns the card into a summary (how long it lasted, everyone
  who came) without the button.
- The page needs a room from `/tela`: without one, or for an unknown or closed
  room, it shows a notice pointing to `/tela` (the token endpoint answers 404
  or 410).

While a room is open the server keeps it in LiveKit, so a LiveKit restart
(tela-ipwatch, an image bump) only blips it: the page fetches a new token and
rejoins once (a stream has to be shared again). `tela-update` restarts
LiveKit or Caddy when a release changes `livekit.yaml` or the `Caddyfile`.

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
stopped). The smoke test (also run by the CI `image` job) runs the server tests
in the image, checks that the built page exists and starts the server with
`DEV_USER` to fetch `/healthz` and `/sala/`.

## Releases

1. Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org).
2. release-please keeps a Release PR open with the version bump and changelog.
3. Merging it creates the tag `vX.Y.Z` and a GitHub release.
4. The same workflow builds `linux/amd64` and pushes
   `ghcr.io/sombrasoft/telinha` tagged `X.Y.Z`, `X.Y` and `latest`, with a
   provenance attestation.
5. Hosts running `tela-update` pick the new tag up within about 5 minutes.

Pre-releases: add a `Release-As: X.Y.Z-rc.N` footer to a commit. `release.yml`
marks hyphenated tags as GitHub pre-releases, and the image gets only the
`X.Y.Z-rc.N` tag (no `latest`, no `X.Y`). `tela-update` ignores them unless
pinned with `tela-pin`.

Required checks on `main`: `test (ubuntu-latest)`, `test (windows-latest)`,
`lint` (shellcheck + actionlint), `gitleaks`, `image`. The `e2e` job (Playwright
on ubuntu) also runs on every PR but is not required yet.

Renovate runs weekly (early Monday, America/Sao_Paulo) for Bun deps, the
Dockerfile, `deploy/compose.yml` and GitHub Actions. Non-major updates are
grouped and automerge through a PR once checks pass. Anything LiveKit
(`livekit-client`, `livekit-server-sdk`, `livekit/livekit-server`) and all
majors are manual.

## Deployment (Debian 13 LXC, root, systemd, docker compose v2)

```
git clone https://github.com/sombraSoft/telinha /opt/bots/tela
install -d -m 700 /etc/telinha
cd /opt/bots/tela/deploy
for n in app livekit tunnel; do cp -n env/$n.env.example /etc/telinha/$n.env; done
chmod 600 /etc/telinha/*.env
```

Now fill in every value in `/etc/telinha/{app,livekit,tunnel}.env`. Then:

```
sh /opt/bots/tela/deploy/install.sh
```

`install.sh` is idempotent. It installs `tela-ipwatch`, `tela-update` and
`tela-pin` into `/usr/local/sbin` and the systemd units, and enables
`tela-ipwatch.timer`. It enables `tela-update.timer` only once all three
`/etc/telinha/*.env` exist with no empty or `<placeholder>` values; otherwise it
warns and you re-run it after filling them in. After each deploy `tela-update`
re-runs it by itself when a release changed a host script or unit.

`tela-update` runs every 5 minutes (and 3 minutes after boot). It fetches tags,
picks the pinned tag or the newest stable `vX.Y.Z`, pulls the image first (an
image still being built is retried next tick), checks out the tag, runs
`docker compose up -d --wait`, and only then records the version and commit in
`deploy/.env`. Secrets live only in `/etc/telinha/`, never in the clone.

Tags are trusted only within limits: `tela-update` refuses a tag that moved
since it was deployed, and an unpinned target whose commit is not on
`origin/main`. A pin (root's explicit choice) may name a tag off `main`.

Pin and rollback:

```
tela-pin                  # show pin, deployed version, newest stable tag
tela-pin v0.1.0           # hold at a tag (also pre-releases like v0.2.0-rc.1), deploy now
tela-pin --unpin          # follow the newest stable tag again
```

Logs:

```
journalctl -t tela-update
journalctl -t tela-ipwatch
```

The compose file lives in `deploy/`, not at the repo top level, so the weekly
`/opt/bots/update-all.sh` (which only handles `/opt/bots/*/compose.yml`)
skips this stack on purpose.

## One-time GitHub setup

Do steps 1 and 2 before the first push to `main`: that push triggers the
first release run.

1. Create a GitHub App with Contents, Issues and Pull requests read and write
   access (the same set `release.yml` requests; release-please labels its PRs
   through the issues API) and install it on this repo. Add repo secrets
   `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`. (An App token is used so CI
   runs on the Release PR; PRs opened with `GITHUB_TOKEN` do not trigger
   workflows.)
2. In Settings -> General, enable "Allow auto-merge" (Renovate's automerge
   uses it).
3. Install the Renovate GitHub App on the repo.
4. After the first release, make the `telinha` GHCR package public so the host
   can pull without credentials.
5. Add a ruleset on `main`: pull request required, plus the required checks
   listed under Releases.
6. Add a tag ruleset on `v*`: block updates and deletions, and restrict
   creation with the release app as the only bypass actor. The host refuses
   moved tags too, but this stops them at the source.

If the first release run failed (e.g. the secrets were missing), add them and
run the `release` workflow by hand (Actions -> release -> Run workflow).

Versions stay below 1.0 for now and start at `0.1.0` (forced by a
`Release-As: 0.1.0` commit footer). `bump-minor-pre-major` is on, so while in 0.x
a `fix` bumps the patch and a `feat` or breaking change bumps the minor. 1.0.0 only
happens when a commit carries a `Release-As: 1.0.0` footer.

## Migrating from the old layout

Old layout: `/opt/bots/tela` holds `compose.yml`, `.env`, `livekit.env`,
`tunnel.env`, `screego.env` and an image built locally (`telinha:local`).

0. Before stopping anything: make sure the `telinha` GHCR package is public,
   then on the host, without `docker login`, run
   `docker pull ghcr.io/sombrasoft/telinha:<version>` for the newest release.
   Go on only if that pull succeeds (`tela-update` would otherwise just log
   "not pullable yet" and exit 0, leaving the site down).
1. Stop the old stack: `docker compose down` in `/opt/bots/tela`.
2. Move the whole directory to `/root/tela.old`. Never keep backups under
   `/opt/bots/`: `update-all.sh` would start the old stack.
3. Clone the repo to `/opt/bots/tela` and create `/etc/telinha/{app,livekit,tunnel}.env`
   from the old files, using `deploy/env/*.env.example` for the keys. Drop
   `screego.env`.
4. Run `sh /opt/bots/tela/deploy/install.sh`. The update timer deploys the
   newest release; run `tela-update` to do it immediately.
5. Check that `docker ps` shows `telinha` as healthy, `journalctl -t tela-update`,
   and a login plus a stream. Delete `/root/tela.old` and the `telinha:local`
   image once it works.

## Roadmap

0.2.0: server rewritten on Bun, frontend on Svelte, light and dark themes, pt-BR and en.

## License

MIT
