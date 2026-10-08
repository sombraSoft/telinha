# Telinha

Self-hosted screen share for a Discord group. Members log in with Discord, a
role check gates entry, and the `/telinha` slash command (renamable) opens a
room at `/r/<code>` and posts its live status card in the allowed channels.
Media goes through a [LiveKit](https://livekit.io) SFU: the bundled
`livekit-server`, or LiveKit Cloud for a host that cannot take media
connections.

Why: Discord Go Live is blocked in Brazil.

One process does everything. Telinha reads one `telinha.env`, renders
`livekit.yaml` (and in direct mode a small Caddyfile) into its Telinha folder, starts
and supervises `livekit-server` (or, with `MEDIA=cloud`, uses a LiveKit Cloud
project instead), plus `caddy` or `cloudflared` depending on the ingress mode,
gates every page behind the Discord login, proxies the LiveKit signaling
WebSocket at `/livekit/*` itself, serves TURN over TLS on port 443 on a VPS,
restarts LiveKit when the public IP changes, asks the router to forward its ports (UPnP / NAT-PMP / PCP) and keeps
a DuckDNS name current. It runs as a native program on Windows and Linux (one
executable that downloads `livekit-server` and `cloudflared` from upstream and
Telinha's own Caddy build from the release, all pinned by sha256, and updates
itself, with a tray icon next to the clock on Windows) or as one Docker
container that bundles them.

**Docs:** https://sombrasoft.github.io/telinha/ (English and Portuguese):
installing, choosing a setup, Discord app, domains, port forwarding
(including pages for common Brazilian ISP routers), doctor, updates, the
Windows tray icon, code signing, LiveKit Cloud, TURN over TLS and the
configuration and command-line reference.

## Install

Windows (PowerShell, no administrator needed):

```
irm https://github.com/sombraSoft/telinha/releases/latest/download/install.ps1 | iex
```

Linux:

```
curl -fsSL https://github.com/sombraSoft/telinha/releases/latest/download/install.sh | sh
```

Both download the program for this machine from the newest stable release,
check its sha256 against the release's `SHA256SUMS` and start `telinha setup`.

**From a clone** (development, or a platform without a release build): needs
[mise](https://mise.jdx.dev/getting-started.html), activated in your shell.

```
git clone https://github.com/sombraSoft/telinha && cd telinha
mise install && bun run build    # the toolchain mise.toml pins, then bun install and the git hooks
bun server/src/index.ts setup    # same setup screens; downloads the helper binaries into <telinha-folder>/bin
bun server/src/index.ts          # run in this console
```

Everything else, from the setup screens to port forwarding, is in the
[docs](https://sombrasoft.github.io/telinha/).

## Setup and doctor

On a terminal, `telinha setup` and `telinha doctor` are full-screen screens
(OpenTUI with Solid) in English or Brazilian Portuguese, drawn in the
terminal's own colours with the Telinha accent for the focus (light or dark is
detected; `TELINHA_THEME=light|dark` forces it, `NO_COLOR` turns the colours
off). They work from 80x24; a wider terminal puts the hint beside the card.
`telinha` alone with no `telinha.env` offers the setup first.

**Setup.** A sidebar lists the steps, `Where`, `Address`, `Discord`, `Ports`,
`Updates` (native installs only), `Review` and `Install`, with a check on the
ones answered. The right side is one question at a time, as a card with a hint
under or beside it that explains the choice (what a Cloudflare Tunnel is, why
DuckDNS uses a high port, where to find a token). Discord servers, roles and channels
are picked from lists read from Discord with the bot token, so no id is typed;
the bot token, the client secret and the DuckDNS token are checked as you go.

| Keys | |
| --- | --- |
| `↑` `↓`, `1`-`9`, `Enter` | Move, pick an option by its number, choose or confirm |
| `Space`, `a` | Mark one, or all, in a multiple choice (the channels) |
| `Esc` or `←` | Back to the previous question; the answers stay |
| `Tab` | Focus the steps: `↑` `↓` and `Enter` jump to any step already answered, `Esc` returns to the card |
| `Ctrl+U` | Clear a text field |
| Paste, `Ctrl+R` | Secrets are masked; paste with the terminal's paste (`Ctrl+V`), `Ctrl+R` shows or hides them |
| `PgUp` `PgDn` | Scroll a long Review |
| `Ctrl+C` | Quit; during the install, press it twice, since stopping half way can leave a half install |

Secrets are never rendered as text (the Review says only `set`, `kept` or
`generated`). `--yes` opens the screens on the first question that has no
default, or on the Review when every question has one. Flag mistakes
(`--host home --public-url https://x.example` without `--advanced`, say) show as a
notice on the first card, and the offending flags are not used as defaults.

The `Review` lists every answer grouped by step, the web address, and the notes
the lookups left, and writes nothing until you choose `Apply` (or `Apply with
a new cookie secret`, which logs everyone out; offered on a re-run). `Install`
is a live list of tasks: the Discord app, DuckDNS (only with a DuckDNS
address), `telinha.env`, the helper programs (with a download bar), the
service, the router and firewall, the start, the HTTPS certificate (direct
mode) and the doctor checks. The sudo moment on Linux (one `sudo` for the
unprivileged-port setting, only for a user install with ports below 1024)
suspends the screens so `sudo` can ask for the password, then they come back;
on Windows the service task waits for the single UAC prompt. A task that fails
shows its lines, a hint and `Retry`, `Skip` (leave it and go on) or `Back to
questions` (the question that task depends on, or the Review; applying again
reuses the secrets already generated). Going back is off while a task runs.
At the end the screens show the web address and offer the doctor report. Under
`--docker` the same screens ask the questions and write the file (`docker run`
needs `-it`), with no Updates step and no install tasks beyond the file.

**Doctor.** One row per check, a spinner while it runs, then `✔`, `!`, `✖` or
`–` and the one-line result. `Enter` (or `Space`, `→`) opens a row: its detail
and a `Fix` line for anything not ok; `r` runs every check again, `p` starts a
new phone test, `s` skips waiting for the phone, `q` or `Esc` quits (exit 1
when a check or the phone test failed). With the service running and the
checks done, a side panel shows the one-time link of the phone test, its QR
code and the live result (HTTPS, LiveKit connection, sending video, first
path, UDP and TCP); the same checklist opens from the end of the setup.

Without a terminal, with `--non-interactive` (setup) or with `--json` (doctor),
nothing opens: setup takes every answer from flags, the environment and the
existing file (secrets only from the environment or a `--<name>-file`) and
prints plain lines, and a flag mistake or a missing answer exits 2 naming it;
doctor prints its table (`--json` the data, with the phone link on stderr).

## Architecture

Telinha is the only HTTP front in every mode: Caddy (direct mode) only
terminates TLS, cloudflared (tunnel mode) only carries traffic. The login gate
and all routing live in telinha.

`INGRESS=direct` on a VPS (bundled Caddy gets a Let's Encrypt certificate over
ports 80 and 443):

```
browser --> caddy :443 (TLS; :80 redirects)           child of telinha
              --> telinha 127.0.0.1:8081 (LISTEN)
                    /healthz      --> answered, no login
                    /internal/*   --> local control endpoint (bearer token, never through a proxy)
                    /r/assets/*   --> the pages' hashed assets, no login
                    /doctor*      --> phone test (one-time link)
                    /auth/*       --> OAuth login, /auth/members (no gate)
                    everything    --> gate: Discord login + role
                      /livekit/rtc* --> LiveKit 127.0.0.1:7880   (signaling proxy, WebSocket)
                      /r/<code>     --> room page
                      /             --> redirect to /r/

media: browser <--> LiveKit   TCP 7881 / UDP 7882 (opened in the provider's firewall)
turn:  turn.<host>:443 (SNI) --> caddy layer4 (TLS, PROXY v2) --> livekit TURN 127.0.0.1:5349 (plain TCP) --> relay --> SFU
```

The `turn:` line exists with TURN on (`TURN=auto` on a VPS install with a
DuckDNS or sslip.io name, or `TURN=on`; only `MEDIA=self`, direct mode, 443,
never at home). Caddy's 443 listener runs the `layer4` listener wrapper before
TLS: a connection whose SNI is `turn.<host>` is terminated with Caddy's own
certificate for that name and proxied as plain TCP to LiveKit's TURN
(`external_tls: true`) with a PROXY protocol v2 header, so TURN sees the
browser's address instead of `127.0.0.1` (`proxy_protocol: true`; LiveKit
closes any connection on that port that does not come from loopback). Every
other connection falls through to the `tls` wrapper and the HTTP sites.
LiveKit advertises `turns:turn.<host>:443?transport=tcp`. No TURN/UDP and no
new port to open.

`INGRESS=direct` at home with DuckDNS (`ACME_DNS=duckdns`; home connections
usually block inbound 80/443, so Telinha never relies on them there):

```
browser --> caddy :8443 (TLS, Let's Encrypt via DuckDNS DNS-01; no :80)   child of telinha
              --> telinha 127.0.0.1:8081 --> (same routes as above)

media: browser <--> LiveKit   TCP 7881 / UDP 7882, plus TCP 8443 (forwarded on the router or by UPnP)
```

The Caddy that runs is Telinha's own build: upstream Caddy plus
`caddy-dns/duckdns` (the DNS challenge above) and `caddy-l4` (the TURN route
on 443), compiled with xcaddy from the recipe in `versions.json`. The Docker
image builds it in a Go stage; every release ships it per os/arch next to the telinha archives, and a
native install fetches the one of its own release and checks it against that
release's `SHA256SUMS`. The DuckDNS token reaches Caddy only through its
environment (the Caddyfile says `{env.DUCKDNS_TOKEN}`) and is blanked out of
Caddy's forwarded log lines.

`INGRESS=tunnel` (Cloudflare Tunnel, no inbound HTTP ports):

```
browser --> Cloudflare --> cloudflared                child of telinha
              --> telinha 127.0.0.1:8081 --> (same routes as above)

media: browser <--> LiveKit   TCP 7881 / UDP 7882 (forwarded on the router or by UPnP)
```

`INGRESS=external` (your own nginx, Traefik, Caddy, ...):

```
browser --> your proxy (TLS, WebSocket, X-Forwarded-For)
              --> telinha LISTEN --> (same routes as above)

media: browser <--> LiveKit   TCP 7881 / UDP 7882 (forwarded on the router or by UPnP)
```

The supervised children write their output into telinha's log as
`[livekit] ...`, `[caddy] ...`, `[cloudflared] ...`. A child that crashes is
restarted with backoff (1 s doubling up to 60 s, reset after a minute of
uptime) and never given up on. If LiveKit does not answer within 30 s at start,
telinha stops the other children and exits 1. Only signaling goes through the
signaling proxy (a few KB/s per client); media flows directly between the browser and
LiveKit on the media ports. The signaling proxy forwards only `/livekit/rtc` and
`/livekit/rtc/*`; anything else under `/livekit/` (notably LiveKit's Twirp
API) is a 404.

`MEDIA=cloud` (any ingress mode; LiveKit Cloud, or any LiveKit reachable at
one URL):

```
browser --> (caddy | cloudflared | your proxy) --> telinha LISTEN --> (same routes, no /livekit signaling proxy: 404)
browser <--> LiveKit Cloud   wss://<project>.livekit.cloud, signaling and media (URL handed out with the token)
telinha --> LiveKit Cloud    https://<project>.livekit.cloud, LiveKit room API (create, list participants, delete)
```

No `livekit-server` child, no media ports, no UPnP media mappings, no Windows
Firewall LiveKit rules and no LiveKit restart on an IP change (the IP watch
still renews the mappings and DuckDNS). `LIVEKIT_API_KEY`/`SECRET` are the
Cloud project's. The token endpoint returns the Cloud `wss://` URL, so the
browser connects to Cloud directly.

`/healthz` is never gated. Its full body (`ok`, `version`, `discord`, `dev`,
`rooms`, `children`) only goes to local callers (the compose healthcheck,
`telinha-update`, the smoke test); a request carrying `X-Forwarded-For`,
`X-Forwarded-Host`, `Forwarded` or `Cf-Connecting-Ip` gets `{ "ok": true }`.

The CLI talks to a running Telinha through `/internal/*` on `LISTEN`: status,
doctor sessions, updates and a graceful shutdown or restart. It answers only a
request with `Authorization: Bearer <token>` matching `data/run/control.token`
(0600, written once the listener is bound, removed at exit) and without any
forwarding header; everything else is the same 404 as an unknown path. The
doctor page's assets live under `/r/assets/` with the room page's, which is why
those are served without a login (hashed build output, no data).

## Layout

| Path | What |
| --- | --- |
| `server/` | Bun TypeScript program, run directly in dev and Docker, compiled for the native binary. `index.ts` entry, `cli/` the commands (`main.ts` dispatch, `args.ts`, `term.ts` plain output (colours, spinner, tables, links; no prompts), `strings.ts` EN/pt-BR, `control.ts` control-endpoint client, `setup.ts` the entry (flags, the file, the machine, the screens or the plain run) and `setup/` what it runs: `model.ts` the questions as data, `resolve.ts` answers to `telinha.env` values and flags to answers, `lookups.ts` the read-only Discord, DNS and port lookups, `state.ts` the navigation state, `apply.ts` the install tasks with their retry/skip/back decisions, `steps.ts` their side effects, `ui.ts` the contract the screens implement, `qstrings.ts` and `apply-strings.ts` the texts, plus `discord.ts`, `domain.ts`, `host.ts` and `envwrite.ts`; `doctor.ts` and `doctor-strings.ts`, `update.ts`, `service.ts`, `tray.ts` the `tray` command; `setup/tray.ts` the install's tray task), `tui/` the OpenTUI + Solid screens of setup and doctor (`runtime.tsx` the renderer and terminal safety, `theme.ts`, `keys.ts`, `ui/` the widgets, `setup/` and `doctor/` the screens, `load.ts`, `smoke.tsx`; loaded only on a terminal, through a dynamic import, so `run` never pulls it in), `run.ts` the service start-up and shutdown, `config.ts` env parsing and validation, `envfile.ts` `telinha.env` parser, `paths.ts` Telinha folder paths and binary lookup, `bins.ts` helper-binary download (sha256-pinned), `archive.ts` tar.gz/zip, `version.ts`, `embedded.ts` the page inside the binary, `supervisor.ts` child processes, `children.ts` which children a mode needs, `render.ts` `livekit.yaml` and Caddyfile (with the TURN `layer4` listener-wrapper block), `lock.ts` one run per Telinha folder, `log.ts` logger with rotation, `control.ts` the control endpoint, `ipwatch.ts` public IP watch, `netinfo.ts` IP/DNS/TLS probes, `ddns.ts` DuckDNS, `nat/` UPnP IGD, NAT-PMP, PCP and the port mapper, `doctor/` checks, phone-test sessions, routes and QR, `service/` Task Scheduler, systemd, Windows Firewall, the `service run` loop and `tray.ts` (the tray's file, Run value, launch and stop), `update/` release lookup, download, swap, rollback, `proxy.ts` the `/livekit/*` signaling proxy, `http.ts` gate and routes, `auth.ts` sessions/OAuth, `roles.ts` role check, `livekit.ts` tokens and LiveKit room API calls, `codes.ts` room codes, `rooms.ts` the Room module (open, admit, observe; owns the SQLite registry and the LiveKit rooms), `lifecycle.ts` card pacing, flushing and retries, `card.ts` the status card, `members.ts` the member directory, `static.ts` page serving, `pages.ts` HTML pages, `bot.ts` Discord bot, `i18n.ts` strings, tests in `test/` |
| `web/` | Svelte 5 + TypeScript room page on plain Vite (`src/App.svelte`, `components/`, `lib/`, `styles/`), served under `/r/`, plus the doctor page (`doctor.html`, `src/doctor/`, plain TypeScript); `bun run build` writes `web/dist` |
| `versions.json` | Pinned `livekit-server` and `cloudflared` versions with the sha256 of every asset (linux amd64/arm64, windows amd64/arm64; cloudflared has no windows arm64 build, the amd64 one is used), and the `caddy` build recipe: Caddy `version`, `xcaddy` and `modules` (no hashes: each release's `SHA256SUMS` pins its Caddy) |
| `mise.toml`, `mise.lock` | The dev and CI toolchain: Bun, Go and the linters, with each tool's download and checksum for every platform in the lock. `mise install` installs it, then runs `scripts/setup-dev.ts` (`bun install`). `scripts/toolchain.test.ts` holds every other Bun and Go copy (`packageManager`, each `@types/bun`, the `Dockerfile` images) to these versions |
| `scripts/bins.ts` | `bun run bins`: downloads and verifies the helper binaries (dev, the Docker build): `livekit-server` and `cloudflared` against `versions.json`, `caddy` from a Telinha release (`--release vX.Y.Z`, default the latest) against its `SHA256SUMS` |
| `scripts/caddy-build.ts` | `bun run caddy`: builds Telinha's Caddy with xcaddy (needs Go), cross-compiling with `--os`/`--arch`; on the host's own platform it asserts the version and the `dns.providers.duckdns` and `layer4` modules. Imports only `node:*`, so the Docker Go stage needs just it and `versions.json` |
| `tray/` | The Windows tray icon: C# on .NET Framework 4.8 (WinForms), one `telinha-tray.exe` (`Program.cs` start-up, `TrayApp.cs` icon and menu, `Monitor.cs` the state machine behind the dot and the notifications, `ControlClient.cs` the control endpoint, `Actions.cs`, `Autostart.cs` the Run value, `Relaunch.cs` the hand-over after an update, `Strings.cs` EN/pt-BR), MSTest tests in `tray/tests/`, `telinha.ico` |
| `.signpath/` | `artifact-configuration.xml`: which files of the Windows release artifact SignPath signs (`telinha.exe` for x64 and arm64, `telinha-tray.exe`) and the product name they must carry |
| `scripts/build-binary.ts` | Native binaries: compile, package (the Windows zips with the tray), `SHA256SUMS`; `pack` archives binaries built earlier (the release signs them in between); `pack-caddy` packs a built Caddy as its release archive |
| `scripts/tray-icon.ts` | Draws `tray/telinha.ico` from the favicon's shapes (16 to 256 px); deterministic |
| `scripts/versions.ts` | `check` (CI) and `refresh` (after a version bump) for `versions.json`; the caddy recipe is validated, never hashed |
| `scripts/dev.ts`, `stack.ts` | Local dev: fetches `livekit-server`, starts the Bun server (which supervises it) and Vite, cleans up on exit; `stack.ts --e2e` is Playwright's web server |
| `scripts/image.ts`, `smoke.sh` | `bun run image`: local container build plus the smoke test (`smoke.sh` ships in the image; it also checks the Caddy version and modules and has Caddy validate the DNS-01 Caddyfile) |
| `e2e/` | Playwright specs (`*.e2e.ts`): login, routes and redirects, screen share between two browser contexts, language and theme, the member list, room closing, the phone test page |
| `Dockerfile` | Multi-stage, multi-arch build (page build, prod deps, downloaded binaries, a `golang` stage that builds Caddy with `scripts/caddy-build.ts` and a `caddy-export` target the release uses for the per-platform assets, Bun alpine runtime with the three binaries and `OPENTUI_LIBC=musl` for the screens' native library, only the musl one installed); entrypoint `bun server/src/index.ts`, command `run` |
| `deploy/` | `install.sh`, `install.ps1` (the native installers), the Docker host side: `compose.yml`, `compose.journald.yml`, `telinha.env.example`, `install-docker.sh`, `telinha-update` and its systemd service/timer |
| `docs/` | The docs site (Astro Starlight, English and pt-BR): pages in `src/content/docs/` (pt-BR under `pt-br/`), the reference generator and the drift and lint tests in `scripts/`, the reference descriptions in `src/data/reference.ts`, components in `src/components/` |
| `.github/workflows/` | `ci.yml`, `release.yml` |
| `.github/workflows/docs.yml` | Builds the docs site and deploys it; called by `release.yml`, or run by hand |

## Development

Needs only [mise](https://mise.jdx.dev/getting-started.html), activated in
your shell. Works on Windows and Linux. `mise install` installs the versions
`mise.toml` pins (Bun, Go and the linters CI runs), then the dependencies with
`bun install`; run it again after a pull.

```
mise install               # the toolchain mise.toml pins, then bun install and the git hooks (lefthook.yml; LEFTHOOK=0 skips them)
bun run dev                # http://localhost:5173/r/ (Vite HMR + Telinha on Bun, which runs LiveKit)
bun run typecheck          # tsc and svelte-check in every workspace
bun run lint               # Biome: formatting, lint rules and import order (bun run format fixes what it can)
bun run test               # bun test: server, web, docs and scripts unit tests (the screens render in a test terminal)
bun run build              # web/dist
bun run e2e                # Playwright; needs bun run build first, and a Chromium (bunx playwright install chromium)
bun run image              # build telinha:dev with docker or podman, then run the smoke test
bun run bins               # download all three helper binaries for this host into .cache/telinha/bin (caddy from the latest release; a warning if it has none)
bun run caddy              # build Telinha's Caddy with xcaddy into .cache/telinha/bin (uses the Go that mise installs)
bun run versions check     # validate versions.json (refresh: recompute the livekit and cloudflared hashes)
bun run compile --smoke    # native binaries for this OS into dist-bin/ (needs bun run build first); --smoke also runs the terminal UI smoke
dotnet test tray/tests/telinha-tray.tests.csproj -c Release           # the tray's unit tests (Windows, .NET SDK 8+)
dotnet build tray/telinha-tray.csproj -c Release -p:Version=X.Y.Z     # tray/bin/Release/net48/telinha-tray.exe
bun run compile --tray tray/bin/Release/net48/telinha-tray.exe   # the same, with the tray in the Windows zips
bun scripts/tray-icon.ts   # rewrite tray/telinha.ico
bun run docs:dev           # the docs site at http://localhost:4321/telinha/
bun run docs:build         # docs/dist; the link validator fails the build on a broken link
```

`bun run dev` downloads `livekit-server` (pinned in `versions.json`,
sha256-verified) into `.cache/telinha/bin` on first run and starts Telinha
with `TELINHA_HOME=.cache/telinha`, `INGRESS=external`, `MEDIA=self`,
`LIVEKIT_NODE_IP=127.0.0.1`, `UPNP=off` and `AUTO_UPDATE=off`, so Telinha
supervises LiveKit exactly as in production and LiveKit advertises loopback
instead of a STUN-discovered public IP (it may still list the host's own IPv6
addresses). Vite proxies `/auth` and `/livekit` (WebSocket included) to the
Telinha on `127.0.0.1:8081`, so the browser goes through the real gate and
signaling proxy.

Telinha runs with `DEV_USER` set (default `1:Dev`, i.e. `<id>:<name>`), a
fake login that skips Discord and the bot. It is refused unless `PUBLIC_URL`
is `http://localhost` or `http://127.0.0.1`, `LISTEN` is a loopback address and
`INGRESS` is `external` (the default when `DEV_USER` is set), and in that mode
every request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` gets a
421, so a reverse proxy in front of it (or a DNS-rebinding page) never reaches
the fake login. Set `DEV_LOCALE=en` or `pt-BR` to force the locale. There is
no slash command in dev, so any valid room code (`/r/lamo-futi`, `/r/bada-kodi`)
opens a room on first use, and the member list is a fixed preview (the dev
user plus seven made-up members, some offline); a room still closes like a
real one (`CLOSE_EMPTY_SECONDS=30 bun run dev` to watch that happen). The dev
registry lives in `.cache/telinha/data/`; the E2E stack uses
`.cache/e2e-data/` with a fresh registry each run (its `run/children.json`
is kept, so a `livekit-server` left behind by a killed run is cleaned up)
and `CLOSE_EMPTY_SECONDS=4`, `POLL_SECONDS=1`; the browser reaches LiveKit through `ws://localhost:8081/livekit` like production.

**Terminal screens.** The screens under `server/src/tui` are `.tsx` files (OpenTUI
with Solid). `server/tsconfig.json` and `docs/scripts/tsconfig.json` set
`"jsx": "preserve"` and `"jsxImportSource": "@opentui/solid"`; the second is needed
because the docs generator imports `cli/setup.ts` and `cli/doctor.ts`, and `tsc`
follows their dynamic imports of the screens. Bun runs that JSX only through OpenTUI's
Solid transform: `bun test` loads it from the `[test]` preload in `bunfig.toml` and
`server/bunfig.toml` (without it Solid's server build renders the first frame but
never reacts to a key), and a run from source (dev, the Docker image) registers it at
runtime with `prepareTui()` in `server/src/tui/load.ts`, a no-op in the native binary,
which the build plugin already transformed. The model, state, lookups and apply
modules under `cli/setup/` are plain TypeScript with no Solid, tested without a
terminal; `server/test/tui-*.test.tsx` render the screens in a test terminal with frame
snapshots (`bun test server/test/tui-setup-frames.test.tsx -u` rewrites them after an
intended change to a screen). `TELINHA_THEME=light|dark` forces the colour mode when
you look at the screens in a terminal whose background the screens cannot read, and
`TELINHA_SMOKE_TUI=1 bun server/src/index.ts --version` runs the terminal UI smoke from
source. The OpenTUI packages are one Renovate group, `opentui`, updated by hand:
OpenTUI is 0.x, so a minor can break, and the terminal smokes reach only the first
setup screen. `solid-js` must equal `@opentui/solid`'s exact peer pin (a second copy
leaves OpenTUI without its renderer), so Renovate never proposes it: raise it by hand
in the `opentui` PR when the peer moves; `scripts/toolchain.test.ts` checks they agree.

`bun run dev` always runs the bundled LiveKit. To run against LiveKit Cloud
from a clone, start Telinha itself (`bun server/src/index.ts`) with a
`telinha.env` that adds `MEDIA=cloud` and the project's three keys,
`LIVEKIT_CLOUD_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`; no
`livekit-server` is downloaded or started. With `DEV_USER` set,
`LIVEKIT_CLOUD_URL` may also be a plain `ws://` or `http://` URL, such as a
local `livekit-server --dev` standing in for Cloud.

**Native binaries.** `bun run compile` (`scripts/build-binary.ts`) calls `Bun.build` with
`compile` (the API, because only it takes the Solid plugin that transforms the screens'
JSX) and `web/dist` embedded (run `bun run build` first) and writes
`dist-bin/<target>/telinha[.exe]` plus the release archives
`dist-bin/telinha-linux-{x64,arm64}.tar.gz` and
`dist-bin/telinha-windows-{x64,arm64}.zip` (each with `LICENSE`, the Windows
ones also with `telinha-tray.exe` given `--tray PATH`) and
`dist-bin/SHA256SUMS`. `--target` takes `linux-x64`, `linux-arm64`,
`windows-x64`, `windows-arm64`, `linux`, `windows` or `host` (repeatable;
default: this OS's two targets), `--version X.Y.Z` (default `package.json`),
`--out DIR`, `--smoke` (runs the host binary's `--version` and a terminal UI smoke,
`TELINHA_SMOKE_TUI=1`, which renders a tiny OpenTUI screen, presses a key and checks it
re-rendered, so a binary without OpenTUI's native library or without a reactive Solid
fails; it also checks the binary sizes and that Babel was not bundled).
`--no-pack` compiles only. `bun run compile pack --target <t> --from DIR` archives
binaries built earlier (`DIR/<target>/telinha[.exe]`, and for Windows
`DIR/tray/telinha-tray.exe` or `--tray`) without compiling.
`bun run compile sums` rewrites `SHA256SUMS` for whatever archives
are in `dist-bin/`, the `caddy-<target>` ones included, and
`bun run compile pack-caddy --target <t> --from DIR` packs a built Caddy as the
release archive of one target. OpenTUI's native library is a package per OS and CPU, and
a cross build embeds the target's: install them all with
`bun install --frozen-lockfile --os='*' --cpu='*'` first (CI does). Linux targets cross-compile from any host; Windows targets
build only on Windows, where Bun can write their version resource (product
name, publisher, version). The x64 targets are Bun's baseline builds. The
binary never reads a `.env` or `bunfig.toml` from the directory it runs in.

**Tray icon.** `tray/` is an SDK-style project targeting `net48` with the
`Microsoft.NETFramework.ReferenceAssemblies` package, so `dotnet build` on
Windows needs only the .NET SDK (no Visual Studio, no targeting pack). Both
projects restore from the `packages.lock.json` beside them
(`tray/Directory.Build.props`); a restore after a `PackageReference` change
updates the lock file, which goes in the same commit, and with `CI=true` (every
GitHub runner) the restore is locked and fails on a stale lock file. Run the
tests before the versioned build: `dotnet test` rebuilds the exe without
`-p:Version`. `-p:Version=X.Y.Z[-rc.N]` makes `ProductVersion` (and
`telinha-tray --version`) the release version and `FileVersion` `X.Y.Z.0`.
The tray only reads the Telinha folder (`data\run\service.pid`, `control.token`,
`telinha.env`) and talks to the control endpoint and `telinha.exe`; it writes
`data\run\tray.json` and `logs\telinha-tray.log`. It refuses to run elevated,
so try a build with `telinha tray start` from a normal terminal after copying
it into `<telinha-folder>\bin`.

**Image.** `bun run image` picks docker, else podman (starting the podman
machine if it is stopped). Caddy is compiled inside the build by the
`caddy-build` stage (`golang` alpine plus the bun binary running
`scripts/caddy-build.ts`, `GOTOOLCHAIN=auto` so a Caddy that needs a newer Go
still builds), on the build platform for the target one. The smoke test
(`scripts/smoke.sh`, also run by the CI `image` job) runs inside the image:
the server tests, the terminal UI smoke from source (`TELINHA_SMOKE_TUI=1`, which proves the
musl OpenTUI library loads and a key re-renders), the built page, `--version` of the three binaries, the
Caddy version against `versions.json` and its `dns.providers.duckdns` and
`layer4` modules, `caddy validate` of the DNS-01 Caddyfile rendered by the real
code (without the token in the file), then the real entry point in `DEV_USER` mode
until `/healthz` reports `"livekit":"up"`, a forwarded `/healthz` without
`children`, the gate (`/r/` redirects to the login, then serves the page with
the command meta), a 404 for `/livekit/` outside the `/rtc` allowlist, page
assets without a login, `/doctor` 404 without a link, the control endpoint (404
without the token or through a proxy, status with it), a second `run` on the
same data refusing to start while the first keeps running, and a graceful stop
through the control endpoint that leaves no token or pidfile behind.

**Docs site.** `docs/` is the third workspace: a Starlight site with English
pages at the root of `docs/src/content/docs/` and Brazilian Portuguese under
`pt-br/`, the same pages in both. The configuration, command-line and
doctor-check reference pages are generated from the server code before every
`docs:dev` and `docs:build` (`docs/scripts/generate.ts` writes
`docs/src/data/generated.json`; the prose for each key, flag and check lives in
`docs/src/data/reference.ts`). `docs/scripts/reference.test.ts`, part of
`bun run test`, fails when a key, flag, command or check has no description,
when a page exists in only one language or has no title or description, and
when a page names an env key, flag or command the code does not have. The site
is built and deployed by `.github/workflows/docs.yml`, which `release.yml`
calls after publishing a stable release.

## Room lifecycle

A Telinha link does not live forever:

- Only the slash command (`/telinha`, or `COMMAND_NAME`) creates rooms. Each
  gets a pronounceable code like `lamo-futi` (two words of two
  consonant-vowel syllables, about 25 bits; six syllables once codes start to
  collide), checked against the registry, and lives at
  `<PUBLIC_URL>/r/lamo-futi`. Telinha records the room in
  `DATA_DIR/telinha.sqlite`, creates it through the LiveKit room API
  and posts the card. The bundled LiveKit runs with `room.auto_create: false`,
  so an old token cannot bring a closed room back, and tokens last 10 minutes
  anyway (LiveKit refreshes them for connected participants). Telinha cannot
  set that on a LiveKit Cloud project: with `MEDIA=cloud` the docs and the
  doctor's `livekit-cloud` check tell the user to turn automatic room creation
  off in the project's settings, and a room recreated by a still-valid token
  is removed by its `emptyTimeout`. The code is not the
  secret: the login gate is.
- Every `POLL_SECONDS` Telinha lists the participants of each open room.
  The slash command's message is a live card: who is streaming (with the
  quality the page reports, e.g. `1080p60 · H265`), who else is in the room
  while someone streams, and since when. It is edited only when it changes, at
  most every 5 s, without pinging anyone. Editing goes through the bot's REST
  API, which needs View Channel and Read Message History in the command's
  channels (slash-command replies alone need neither); without them the card
  stays as posted (logged once as "card not editable"), and everything else
  works.
- A room closes for good after `CLOSE_EMPTY_SECONDS` with nobody in it, or
  that long after the command when nobody ever joined. Telinha deletes the
  LiveKit room and turns the card into a summary (how long it lasted, everyone
  who came) without the button.
- The page needs a room from the command: `/r/` alone, or an unknown or closed
  room, shows a notice pointing to `/<command>` (the token endpoint answers 404
  or 410).
- `/` redirects to `/r/`.

While a room is open Telinha keeps it in LiveKit, so a LiveKit restart (the
in-process IP watch, a crash, an update) only blips it: the page fetches a new
token and rejoins once (a stream has to be shared again).

If the card's message is deleted, or the bot can't edit it (403), the room
keeps its lifecycle and the card is left alone. A closed card that could not
be sent yet is retried after a restart. The registry is `data/telinha.sqlite` (natively) or the `telinha-data` volume
in `deploy/compose.yml`; losing it only means the links of rooms open at that
moment stop working.

The page has four themes (Dark, Ash, Onyx, Light; "system" follows the OS) and
two languages (pt-BR, en). Both are picked in the top bar and kept in
`localStorage`. By default the language comes from the Discord locale of the
logged-in user, and the bot answers in the invoker's locale (ephemeral) or the
Discord server's locale (public post).

Streams use AV1 when the browser has a hardware encoder for it, else H.265
(Chrome only offers it with one), else H.264, always with an H.264 backup for
viewers that can't decode the first choice. Hardware HEVC (seen with NVIDIA on
Windows) sends nothing when any simulcast layer has an odd width or height, so
the page crops each frame to a multiple of 8 and the lower layers are exactly
1/2 and 1/4 of it. Known gap: shrinking a live share well below 960 px wide
drops the top layer (#9).

## Member list

Beside who is in the room, the people list shows everyone else with the role,
Discord style: **Online** (online, idle, do not disturb) and **Offline**
(collapsed until opened; the choice is kept in `localStorage`). The page polls
`GET /auth/members` every 15 s while the tab is visible; it answers
`{ members: [{ id, name, avatar, status }] }` (`no-store`), 401 without a
session and 403 without the role, checked by the handler itself since the gate
lets `/auth/*` through. Until the bot has loaded the guild the list is empty.

The bot fetches the guild's members once per gateway connection and keeps the
directory current from member and presence events, so it needs the two
privileged intents, Server Members and Presence (setup switches both on; see
the [Discord app](https://sombrasoft.github.io/telinha/start/discord/) page).
Without them the bot fails to log in ("disallowed intents"). Only the role
members' presences are cached.

## Releases

1. Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org).
2. release-please keeps a Release PR open with the version bump and changelog.
3. Merging it creates a **draft** GitHub release (`"draft": true` in
   `release-please-config.json`). A draft has no tag and is never `latest`, so
   `releases/latest/download/*`, the installers and both updaters never see a
   release without its assets. Every later job checks out the release commit.
4. `binaries` (`ubuntu-24.04`) runs `bun scripts/build-binary.ts --target
   linux --version X.Y.Z --smoke` for `linux-x64` and `linux-arm64`.
   `binaries-windows` (`windows-2025`, where Bun writes the Windows version
   resource) runs the tray's tests, builds `telinha-tray.exe` with
   `-p:Version=X.Y.Z`, compiles `windows-x64` and `windows-arm64` with
   `--smoke --no-pack`, and uploads the three exes as one artifact. Then
   `sign-windows` has SignPath sign them (Authenticode, product name Telinha;
   a SignPath Foundation policy is approved by hand per release), checks that
   every signature is `Valid`, and packs `telinha-windows-x64.zip` and
   `telinha-windows-arm64.zip` (`telinha.exe`, `telinha-tray.exe`, `LICENSE`)
   with `build-binary.ts pack`. When signing is not configured for the
   repository the step is skipped with a notice naming what is missing, and
   the zips carry the unsigned exes; a denied, failed or timed-out signing
   request fails the job instead. Free code signing provided by SignPath.io,
   certificate by SignPath Foundation; see
   [Code signing](https://sombrasoft.github.io/telinha/guides/code-signing/)
   for the policy. In parallel `caddy` (matrix:
   `linux-x64`, `linux-arm64`, `windows-x64`, `windows-arm64`, all on
   `ubuntu-24.04`, since Go cross-compiles) builds our Caddy through the
   Dockerfile's `caddy-export` target and packs it as `caddy-<target>.tar.gz`
   or `.zip`, and `image` builds `linux/amd64` and `linux/arm64` and pushes
   `ghcr.io/sombrasoft/telinha` tagged `X.Y.Z`, `X.Y` and `latest`, with a
   provenance attestation on the index digest.
5. `release-assets` (after `binaries`, `sign-windows`, `caddy` and `image`)
   writes `SHA256SUMS` for the four telinha archives (so the sums and the
   attestation cover the signed Windows exes), the
   four `caddy-*` archives, `telinha-deploy.tar.gz` and `telinha-image.digest`,
   attests all of them and `SHA256SUMS` (one GitHub build provenance
   attestation), uploads
   `telinha-linux-x64.tar.gz`, `telinha-linux-arm64.tar.gz`,
   `telinha-windows-x64.zip`, `telinha-windows-arm64.zip`, the `caddy-*`
   archives, `SHA256SUMS`,
   `telinha-image.digest` (the index digest, one `sha256:...` line;
   `telinha-update` trusts nothing else), `telinha-deploy.tar.gz`
   (`compose.yml`, `compose.journald.yml`, `telinha.env.example`,
   `install-docker.sh`, `telinha-update` and its units, `telinha-image.digest`), `install.sh` and
   `install.ps1`, then publishes the release, which creates the tag
   `vX.Y.Z` and, for a stable version, makes it `latest`. A failure anywhere
   leaves only a draft to finish or delete.
6. For a stable version, `docs` then publishes the docs site: it calls
   `.github/workflows/docs.yml`, which builds the site from the release commit
   and deploys it.
7. Native installs pick the release up at their next check (every 6 hours by
   default, later while rooms are open); hosts running `telinha-update` within
   about 5 minutes.

Pre-releases: add a `Release-As: X.Y.Z-rc.N` footer to a commit. `release.yml`
marks hyphenated tags as GitHub pre-releases, and the image gets only the
`X.Y.Z-rc.N` tag (no `latest`, no `X.Y`). `releases/latest` never points at
them; the native updater and `telinha-update` ignore them unless pinned
(`UPDATE_PIN`, `telinha-update pin`).

The `main` ruleset requires two checks. `required` is a job in `ci.yml` that
passes only when the jobs it `needs` pass: `test (ubuntu-24.04)`,
`test (windows-2025)` (which also runs the tray's MSTest suite), `lint`
(shellcheck of `deploy/install-docker.sh`, `deploy/install.sh`,
`deploy/telinha-update` and `scripts/smoke.sh`, a PowerShell parse and pinned
PSScriptAnalyzer run of `deploy/install.ps1`, jactionlint (the maintained
actionlint fork; shellcheck on `run:` blocks too), hadolint of the
`Dockerfile` (`.hadolint.yaml` lists the rules it ignores and why),
editorconfig-checker, Biome (`biome ci`: formatting, lint rules, import
order; a warning fails it too), a `mise.lock` freshness check and
`bun scripts/versions.ts check`; the linters are the ones `mise.toml` pins), `gitleaks` (the commits a PR or push adds,
with the gitleaks `mise.toml` pins), `image` (builds both architectures,
smoke-tests amd64), `docs` (builds the docs site, link validator included),
`e2e` (Playwright on ubuntu), `caddy (windows-x64)` (the Windows Caddy through
the same Dockerfile stage the release uses) and `binaries (ubuntu-24.04)` /
`binaries (windows-2025)`, which compile the native targets and smoke-test
them: `--version`, then a real `run` in `DEV_USER` mode until `/healthz`
reports LiveKit up (the binary downloads `livekit-server` itself), the gate and
`/doctor` answers, a graceful stop; the terminal UI smoke of each binary
(`TELINHA_SMOKE_TUI=1`, also for `linux-arm64` under QEMU, which runs
`--version`) and a check of the binary sizes; the real setup screens of the Linux
binary in a pseudo-terminal (`script`: the output has its escape sequences and
whitespace stripped, then the first question's title must be there; after
Ctrl+C the exit code must be 130 and the alternate screen left), and setup
without a terminal exiting 2 at once; and the version resource (`ProductName`
Telinha) of both Windows binaries. The `image` job runs the same two checks on
`docker run [-it] ... setup --docker`, which needs the target's musl OpenTUI
library selected by `OPENTUI_LIBC=musl`. The binaries jobs
install every OS and CPU package (`bun install --os='*' --cpu='*'`) so each target
embeds its own OpenTUI library. On
Windows that job also builds the tray with the version, checks its version
resource and `--version`, that each zip holds
exactly `telinha.exe`, `telinha-tray.exe` and `LICENSE`, a tray smoke test
(started without elevation: `tray.json`, `telinha tray status`,
`telinha tray stop`), and an Authenticode check that signs copies of
`telinha.exe` and `telinha-tray.exe` with a throwaway self-signed certificate
and runs them, so a signature never breaks either. Renovate's automerge waits
on `required`, so on all of these. `pr-title` (`pr-title.yml`) checks the
PR title is a Conventional Commit with one of the types `feat`, `fix`, `docs`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`; it runs again
when the title is edited.

On a PR, the `changes` job skips the jobs a change cannot affect (`ci.yml`
lists which paths each job builds): a Dockerfile-only PR runs `image`,
`caddy`, `lint` and `gitleaks`. A change to shared config (`ci.yml`, any
`package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `mise.toml`,
`mise.lock`, `global.json`) runs everything, and so does every push to `main`.

Renovate runs weekly (early Monday, America/Sao_Paulo) for Bun deps, the
tray's NuGet packages (with their `packages.lock.json` files), the
Dockerfile (its `golang` and bun images included), `deploy/compose.yml`,
GitHub Actions and everything in `versions.json`: the two downloaded binaries,
and Caddy, xcaddy and the Caddy modules of our build. Every action is pinned
to a commit SHA (with a `# vX.Y.Z` comment) and every third-party image to a
digest; Renovate keeps both current. A release must be 3 days old before
Renovate opens a PR for it (until then it waits on the Dependency Dashboard);
security fixes and digest pins skip the wait. Non-major updates are grouped and
automerge through a PR once checks pass. Anything LiveKit
(`livekit-client`, `livekit-server-sdk`, `livekit/livekit`), Biome and all
majors are manual. `versions.json` bumps never automerge. A Caddy, xcaddy or module bump
is judged by the `image` job, which builds it and smoke-tests the version and
modules. A cloudflared or LiveKit bump changes only the `version`, so the
hashes are stale and the `image` and `e2e` jobs fail until someone refreshes
them on the Renovate branch:

```
git fetch origin && git switch <renovate branch>
bun scripts/versions.ts refresh    # downloads every asset, rewrites the sha256 values (cross-checks upstream checksums)
git commit -am "fix(deps): refresh versions.json hashes" && git push
```

Caddy (with xcaddy and the modules) and cloudflared bumps come as one `child-binaries` PR, LiveKit's in the
`livekit` group, Astro and Starlight in the `docs-site` group (merged by hand:
Starlight is 0.x, and a minor can change the site while the `docs` build still
passes), OpenTUI and its Solid binding in the `opentui` group (merged by hand
too: the terminal smokes reach only the first setup screen; `solid-js` follows
their peer by hand); all `versions.json` bumps are `fix` commits so they cut a
release, and native installs download the new helper binaries on their next
start.

Versions stay below 1.0. `bump-minor-pre-major` is on, so while in 0.x a
`fix` bumps the patch and a `feat` or breaking change bumps the minor. 1.0.0
only happens when a commit carries a `Release-As: 1.0.0` footer.

## License

MIT
