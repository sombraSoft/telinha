# Telinha

Self-hosted screen share for a Discord group. Members log in with Discord, a
role check gates entry, and the `/tela` slash command posts a fresh room link
in the allowed channels. Media goes through a [LiveKit](https://livekit.io) SFU.

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
| `server/` | Node 22 server and Discord bot (`src/index.js`), session/OAuth helpers (`src/auth.js`), tests |
| `web/` | Plain-JS room page in `src/`; `build.ts` copies it plus `livekit-client` into `web/dist` |
| `scripts/image.ts` | `bun run image`: local container build plus smoke test |
| `Dockerfile` | Multi-stage build (Bun build, prod deps, Node 22 alpine runtime) |
| `deploy/` | Host side: `compose.yml`, `Caddyfile`, `livekit.yaml`, `env/*.example`, `install.sh`, `pin.sh` |
| `deploy/updater/` | `tela-update` and its systemd service/timer (pull-based CD) |
| `deploy/ipwatch/` | `tela-ipwatch`: restarts LiveKit when the residential public IP changes |
| `.github/workflows/` | `ci.yml`, `release.yml` |

## Development

Needs [Bun](https://bun.sh) 1.4.2 and Node 22+. Works on Windows and Linux.

```
bun install --frozen-lockfile
bun run build     # web/dist
bun run test      # node --test in server/
bun run image     # build telinha:dev with docker or podman, then run the smoke test
```

`bun run image` picks docker, else podman (starting the podman machine if it is
stopped). The smoke test (also run by the CI `image` job) syntax-checks the
server, runs the tests and checks that the four web files exist in the image.

## Releases

1. Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org).
2. release-please keeps a Release PR open with the version bump and changelog.
3. Merging it creates the tag `vX.Y.Z` and a GitHub release.
4. The same workflow builds `linux/amd64` and pushes
   `ghcr.io/sombrasoft/telinha` tagged `X.Y.Z`, `X.Y` and `latest`, with a
   provenance attestation.
5. Hosts running `tela-update` pick the new tag up within about 5 minutes.

Required checks on `main`: `test (ubuntu-latest)`, `test (windows-latest)`,
`lint` (shellcheck + actionlint), `gitleaks`, `image`.

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

Next (0.2.0): server rewritten on Bun, frontend on Svelte.

## License

MIT
