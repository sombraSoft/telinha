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
signaling WebSocket at `/livekit/*` itself, restarts LiveKit when the public IP
changes, asks the router to forward its ports (UPnP / NAT-PMP / PCP) and keeps
a DuckDNS name current. It runs as a native program on Windows and Linux (one
executable that downloads the three helper binaries it needs, pinned by
sha256, and updates itself) or as one Docker container that bundles them.

## Install

Windows (PowerShell, no administrator needed):

```
irm https://github.com/sombraSoft/telinha/releases/latest/download/install.ps1 | iex
```

Linux:

```
curl -fsSL https://github.com/sombraSoft/telinha/releases/latest/download/install.sh | sh
```

Both download the archive for this machine and `SHA256SUMS` from the newest
stable release, check the sha256 (a mismatch stops the install), put the
program into the home dir's `bin/`, print `telinha --version` and start
[`telinha setup`](#setup-wizard). Nothing else is downloaded by the scripts:
setup fetches `livekit-server` and `caddy` or `cloudflared` itself.

- `install.ps1` installs `telinha.exe` into `%LOCALAPPDATA%\Telinha\bin`
  (a running copy is renamed to `telinha.old-manual-<seconds>.exe` first and
  swept later), adds that directory to your user `PATH` (this window and new
  ones), then runs setup. Environment: `TELINHA_VERSION=v0.7.0` installs that
  tag, `TELINHA_HOME` another directory (kept as a user variable),
  `TELINHA_NO_SETUP=1` skips setup.
- `install.sh` asks native or Docker on a terminal (native is the default).
  Native as root installs a root-owned `/usr/local/lib/telinha/telinha`
  (`/usr/local/bin/telinha` runs it with the home baked in) and setup copies it
  to `/opt/telinha/bin/telinha` for the system service, which updates that copy
  itself; root never runs the service's copy. As a user it installs
  `~/.local/share/telinha/bin/telinha` (`$XDG_DATA_HOME` respected; it prints
  the `PATH` line to add, and setup installs a user service). It needs `curl`
  or `wget`, `tar` and `sha256sum` or `shasum`. Docker (root) downloads
  `telinha-deploy.tar.gz`, checks it against `SHA256SUMS` and runs its
  `install-docker.sh` (see [Running with Docker](#running-with-docker-linux)).
  Non-interactive:
  `curl ... | sh -s -- --native` (or `--docker`, `--no-setup`), or
  `TELINHA_INSTALL=native|docker`; `TELINHA_VERSION` and `TELINHA_HOME` work as
  on Windows.

Downloading the archive by hand works too: unpack it anywhere and run
`telinha setup` (or double-click `telinha.exe`: with no `telinha.env` yet it
offers to start the setup).

**Builds.** `linux-x64`, `linux-arm64`, `windows-x64`, `windows-arm64`. The x64
builds run on any x86-64 CPU (no AVX2 needed, so older Celeron and Atom home
servers work); Windows on ARM runs the arm64 build (with the x64 `cloudflared`
under emulation, as Cloudflare ships no ARM build for Windows). The Linux
builds need glibc: on Alpine and other musl systems `install.sh` switches to
the Docker install (`--native` refuses). macOS is not supported yet.

**Verifying a download.** Every release carries `SHA256SUMS` and a GitHub
build provenance attestation covering the four archives, the Docker bundle
`telinha-deploy.tar.gz`, `telinha-image.digest` and `SHA256SUMS`:

```
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify telinha-linux-x64.tar.gz --repo sombraSoft/telinha
gh attestation verify telinha-windows-x64.zip --repo sombraSoft/telinha
```

On Windows without `sha256sum`: `Get-FileHash telinha-windows-x64.zip` and
compare with the line in `SHA256SUMS`. The binaries are not code-signed yet.
The self-updater checks the sha256 of every update against that release's
`SHA256SUMS`; it does not verify the attestation.

The home dir (`TELINHA_HOME` overrides it; `--home DIR` on any command does the
same): `%LOCALAPPDATA%\Telinha` on Windows, `/opt/telinha` for a Linux root
install, `~/.local/share/telinha` for a Linux user install.

| Path | What |
| --- | --- |
| `bin/telinha[.exe]` | The program (installers and updater write it) |
| `bin/telinha.old-<version>[.exe]`, `bin/telinha.failed-<tag>[.exe]` | The executable an update replaced, or one that was rolled back; removed after the next good start (on Windows one the service still runs from stays until the service restarts) |
| `bin/livekit-server`, `caddy`, `cloudflared` (`.exe` on Windows) and `<tool>.version` | The helper binaries this configuration needs, downloaded and sha256-checked by setup and at every start; `PATH` is tried after `bin/` |
| `config/telinha.env` | The configuration, owner-only: Linux mode 0600 in a 0700 dir; Windows ACL with only you, SYSTEM and Administrators |
| `data/telinha.sqlite` | Room registry |
| `data/run/` | Rendered `livekit.yaml` and `Caddyfile` (rewritten before every child start: edit `telinha.env`, never these), `children.json`, `public-ip`, `telinha.pid` (one `run` per home), `service.pid`, `control.token`, `update.json` (staged / failed / pending update), `upnp.json` (router mappings) |
| `data/caddy/` | Caddy's certificates and ACME account (direct mode) |
| `logs/telinha.log` (`.1` to `.5`) | The Windows service log, rotated at 10 MB (Linux logs to the journal) |
| `service/telinha-task.xml`, `install-result.json` | Windows: the registered task, and what the elevated install did |

The command line (every command takes `--lang en|pt-BR`, `--home DIR`, `--yes`;
the language otherwise comes from `LOCALE` in `telinha.env`, else the system):

| Command | What |
| --- | --- |
| `telinha` / `telinha run` | Start Telinha in this console (Ctrl+C stops it). With no `telinha.env` on a terminal it offers the setup instead |
| `telinha setup [flags]` | The wizard; `--non-interactive` with flags and environment ([below](#non-interactive)), `--docker` inside the image |
| `telinha doctor [--json] [--no-phone] [--local]` | Checks everything, then the phone test ([Doctor](#doctor)) |
| `telinha update [--check \| --now]` | Look for or install a new release ([Updates](#updates)) |
| `telinha service install [--firewall] [--user]` | Register the service (Windows: from an administrator terminal; `telinha setup` does it with one UAC prompt) |
| `telinha service uninstall [--firewall] \| start \| stop \| restart \| status` | Manage it; `uninstall` keeps the files |
| `telinha service run` | The supervising loop the service manager starts; not for hand use |
| `telinha --version`, `telinha help [command]` | `telinha 0.7.0 (abc1234, bun 1.4.2, windows-x64)`; help in the chosen language |

Exit codes: `0` ok, `1` error, `2` usage (bad flag, missing non-interactive
answer), `3` restart requested (`run` asking the service loop to start it again,
after an update). `doctor` exits 1 when a check failed; `service status` exits 1
when the service is not installed or not running.

**From a clone** (development, or a platform without a release build): needs
[Bun](https://bun.sh) 1.4.2.

```
git clone https://github.com/sombraSoft/telinha && cd telinha
bun install --frozen-lockfile && bun run build
bun server/src/index.ts setup    # same wizard; downloads the helper binaries into <home>/bin
bun server/src/index.ts          # run in this console
```

Run from source there is no service install and no self-update (`git pull`,
`bun install`, `bun run build`, restart).

## Setup wizard

`telinha setup` asks in English or Brazilian Portuguese (picked from the
system, asked once, kept as `LOCALE`) and explains every step in a line or two.
Nobody copies ids by hand: servers, roles and channels are picked from lists.

1. **The machine.** Shows the OS, the public IP and the router if one answers
   UPnP, NAT-PMP or PCP, and asks where Telinha runs: at home behind a router,
   a VPS with its own public IP, or behind Cloudflare only.
2. **Address** ([Domains](#domains)): your own domain (its A record is
   compared with the public IP), DuckDNS (the token is tried at once), sslip.io
   (VPS only), a Cloudflare Tunnel, or your own reverse proxy. With the bundled
   Caddy it asks whether public ports 80 and 443 reach the machine: yes; only
   443, forwarded to another local port (`HTTPS_PORT=<port>`, `HTTP_PORT=0`, the
   certificate then comes through the TLS-ALPN challenge on 443); or neither,
   which recommends the tunnel. At home it asks whether Telinha may open the
   ports through UPnP (`UPNP`).
3. **Media ports** TCP 7881 and UDP 7882, changeable, checked to be free here.
4. **Discord.** The bot token first (Developer Portal -> Applications -> New
   Application -> Bot -> Reset Token); the client id comes from it. The wizard
   then switches **Server Members Intent** and **Presence Intent** on through
   the API, checks the client secret (OAuth2 -> Client Secret -> Reset Secret)
   with a client-credentials grant, and shows the login redirect
   `<PUBLIC_URL>/auth/callback`. **That one Discord cannot set through its
   API**: add it under OAuth2 -> Redirects -> Add Redirect -> Save Changes; the
   wizard waits and re-reads the app until it is there (skipping is allowed,
   doctor checks it later). If the bot is in no server yet it prints the invite
   link (permissions View Channel, Send Messages and Read Message History;
   it can open the browser) and waits. Then pick the server, the role that may
   enter (or everyone), the command channels, the command name and the group
   name.
5. **Updates** (native binary): on or off (`AUTO_UPDATE`).
6. **Secrets and review.** Generates `COOKIE_SECRET` and the LiveKit key pair
   when missing, shows every value (secrets as generated / kept / set), and
   writes `telinha.env` only after the same validation `run` does at start.
7. **Natively**, after the file: downloads the helper binaries; installs and
   starts the service ([Running as a service](#running-as-a-service); on
   Windows that is one UAC prompt, for the task and the firewall rules); for a
   Linux user install with ports below 1024, the one `sudo` step described in
   [Ports](#ports-upnp-and-firewall); probes the router (CGNAT and double NAT
   warnings, the ports to forward by hand without UPnP); waits for the service,
   runs `telinha doctor` with the phone test, and prints the next steps.

**Re-running** it is how settings change. Every question defaults to the
current value, secrets offer `(keep current)`, generated secrets stay, and keys
the wizard does not manage (`ACME_EMAIL`, `SESSION_DAYS`, ...) are kept under an
`Other settings` section. The review can also write a new cookie secret (logs
everyone out). A running service restarts with the new file; a console run has
to be restarted by hand.

### Non-interactive

`telinha setup --non-interactive` (implied without a terminal) takes every
answer from flags, then the environment (any `telinha.env` key), then the
existing file. A missing answer exits 2 naming the flag or variable.

| Flag | Sets |
| --- | --- |
| `--public-url URL` | `PUBLIC_URL` |
| `--ingress direct\|tunnel\|external` | `INGRESS` |
| `--http-port N`, `--https-port N` | `HTTP_PORT`, `HTTPS_PORT` |
| `--duckdns-domain NAME` | `DDNS_PROVIDER=duckdns`, `DUCKDNS_DOMAIN`, and `PUBLIC_URL=https://NAME.duckdns.org` unless `--public-url` is given |
| `--media-tcp N`, `--media-udp N`, `--node-ip IP` | `MEDIA_TCP_PORT`, `MEDIA_UDP_PORT`, `LIVEKIT_NODE_IP` |
| `--guild ID`, `--role ID`, `--channels ID,ID` | `GUILD_ID`, `ROLE_ID`, `CHANNEL_IDS` |
| `--command NAME`, `--group NAME` | `COMMAND_NAME`, `GROUP_NAME` |
| `--client-id ID` | `DISCORD_CLIENT_ID`; read from the token otherwise, required with `--no-discord-check` |
| `--upnp auto\|off`, `--auto-update on\|off`, `--lang en\|pt-BR` | `UPNP`, `AUTO_UPDATE`, `LOCALE` |
| `--no-service`, `--no-firewall`, `--no-upnp`, `--no-doctor` | Skip that step |
| `--no-discord-check` | No Discord API calls; the ids are taken as given |
| `--docker` | Inside the image: write the file only |

**Secrets never go on the command line** (the process list and shell history
show it). They come from the environment under their `telinha.env` name or
from a file; `-` reads stdin, one secret per run. `--discord-token`,
`--client-secret`, `--tunnel-token` and `--duckdns-token` are refused with a
usage error saying so.

| Secret | Environment | File |
| --- | --- | --- |
| Bot token | `DISCORD_TOKEN` | `--discord-token-file PATH` |
| Client secret | `DISCORD_CLIENT_SECRET` | `--client-secret-file PATH` |
| Tunnel token | `TUNNEL_TOKEN` | `--tunnel-token-file PATH` |
| DuckDNS token | `DUCKDNS_TOKEN` | `--duckdns-token-file PATH` |

Required: `--public-url` (or `--duckdns-domain`), the bot token, the client
secret, `--guild`, `--role`, `--channels`, plus the tunnel or DuckDNS token in
those modes.

```
telinha setup --non-interactive --public-url https://telinha.example.com \
  --guild <id> --role <id> --channels <id>,<id> \
  --discord-token-file ./discord-token --client-secret-file - < ./client-secret
```

### Docker

`install-docker.sh` offers the wizard when `telinha.env` is missing or still
has placeholders and it runs on a terminal (`--setup` forces it, `--no-setup`
skips it). It runs the image:

```
docker run --rm -it --user 0 -e TELINHA_HOME=/telinha \
  -v /opt/telinha/config:/telinha/config ghcr.io/sombrasoft/telinha:latest setup --docker
```

(`--user 0` because `/opt/telinha/config` is root's; the file ends up 0600.)
`--docker` asks the same questions except updates, writes
`/opt/telinha/config/telinha.env` and skips binaries, service, firewall, router
and doctor; it ends with the compose command. `install.sh --docker` hands
`install-docker.sh` your terminal, so the wizard is offered there too;
`install.sh --docker --no-setup` skips it.

## Domains

People need an HTTPS name. Four ways:

**Your own domain.** Point an A record at the public IP and use
`PUBLIC_URL=https://telinha.example.com` (`INGRESS=direct`, Caddy gets a Let's
Encrypt certificate). Setup and doctor compare the record with the public IP.
On a changing home IP use your DNS provider's dynamic DNS, or DuckDNS.

**DuckDNS** (free, follows a changing IP, works on any host): duckdns.org ->
sign in -> add a subdomain -> copy the token at the top.

```
PUBLIC_URL=https://my-group.duckdns.org
DDNS_PROVIDER=duckdns
DUCKDNS_DOMAIN=my-group          # the subdomain alone; a pasted .duckdns.org is stripped with a warning
DUCKDNS_TOKEN='...'
```

Telinha updates the record at start, then looks up the public IP every 5
minutes and updates it when the IP changed or the last update failed, at least
once a day, and right away when the IP watch sees a change (log
`ddns: my-group.duckdns.org -> 203.0.113.9`; the token is never logged). With
`LIVEKIT_NODE_IP` set it only sends that IP, at start and daily. A
`PUBLIC_URL` on another host is a warning.

**No domain, static IP (sslip.io).** On a VPS with a fixed public IPv4,
`PUBLIC_URL=https://203-0-113-9.sslip.io` resolves to `203.0.113.9` with no
setup at all; set `LIVEKIT_NODE_IP=203.0.113.9` too (setup does both, and
offers this only for a VPS). sslip.io is a shared domain: Let's Encrypt may
refuse a certificate in a week when too many were issued for it. Your own
domain or DuckDNS is more reliable.

**Cloudflare Tunnel** (`INGRESS=tunnel`): no inbound web ports, so it suits
networks that cannot forward 80/443. Needs a domain on Cloudflare. Zero Trust
-> Networks -> Tunnels -> create a tunnel (cloudflared) -> copy its token into
`TUNNEL_TOKEN`, and give the tunnel a public hostname whose service is
`http://localhost:<LISTEN port>` (default `http://localhost:8081`);
`PUBLIC_URL=https://<that hostname>`. Works on every build (Windows on ARM
included). The media ports still need forwarding: tunnels do not carry WebRTC.

**CGNAT.** Many residential lines share one public IPv4 between customers
(carrier-grade NAT): the router's WAN address is in `100.64.0.0/10`, and nothing
from the internet reaches the network, port forwarding and UPnP included.
`telinha doctor` detects it (the `cgnat` check compares the router's external
IP, read through UPnP / NAT-PMP / PCP, with the IP the internet sees) and the
setup warns. A Cloudflare Tunnel gets the pages through, but the media ports
cannot: ask the ISP for a public IPv4 (often a free opt-out of CGNAT), or run
Telinha on a small VPS. A private WAN address instead means a second router in
front (double NAT): forward the ports on that one too, or put one of them in
bridge mode.

## Ports, UPnP and firewall

| Port (default) | When | What |
| --- | --- | --- |
| TCP `MEDIA_TCP_PORT` (7881) | always | WebRTC media over TCP (networks that block UDP) |
| UDP `MEDIA_UDP_PORT` (7882) | always | WebRTC media over UDP (the normal path) |
| TCP `HTTPS_PORT` (443) | `direct` | Caddy, TLS; the public side is the `PUBLIC_URL` port |
| TCP `HTTP_PORT` (80) | `direct`, unless `0` | Let's Encrypt HTTP challenge, HTTP->HTTPS redirect |

`LISTEN` (8081) and `LIVEKIT_PORT` (7880) are loopback only and never need
forwarding.

**UPnP.** With `UPNP=auto` (the default) Telinha asks the router to forward
those ports to this machine while it runs, through UPnP IGD (v1 or v2), PCP or
NAT-PMP, whichever answers. Leases are an hour, renewed well before they run
out and re-added after an IP change (routers often drop them on a reconnect);
a clean stop removes them, and a crash's leftovers (`data/run/upnp.json`) are
removed at the next start. Without a gateway it says so once and looks again
every 10 minutes. The log:

```
upnp: mapped TCP 7881 -> 192.168.0.10:7881 (lease 3600s)
upnp: mapped UDP 7882 -> 192.168.0.10:7882 via NAT-PMP (lease 3600s)
upnp: could not map TCP 443: port 443 is mapped to another device 192.168.0.20
upnp: no UPnP/NAT-PMP gateway found; forward the ports on the router by hand
```

Many routers ship with UPnP off; turning it on in the router's admin page, or
forwarding the ports by hand and setting `UPNP=off`, are equivalent. A VPS has
no gateway and just logs the line above. `telinha doctor`'s `gateway` and
`mappings` checks show what the router agreed to.

**Windows Firewall.** `telinha service install --firewall` (which the setup's
UAC step runs) first removes every inbound rule bound to `livekit-server.exe`
or `caddy.exe` in `bin\` (a dismissed Windows Security Alert from a console run
leaves Block rules, and Block wins over Allow), then adds inbound allow rules
for all profiles, each bound to its program; re-run it after changing ports,
`telinha service uninstall --firewall` removes them:

| Rule | Program | Port |
| --- | --- | --- |
| `Telinha LiveKit TCP` | `livekit-server.exe` | TCP `MEDIA_TCP_PORT` |
| `Telinha LiveKit UDP` | `livekit-server.exe` | UDP `MEDIA_UDP_PORT` |
| `Telinha HTTPS` (direct) | `caddy.exe` | TCP `HTTPS_PORT` |
| `Telinha HTTP` (direct, `HTTP_PORT` not 0) | `caddy.exe` | TCP `HTTP_PORT` |

**Linux.** Telinha adds no firewall rules. With ufw or firewalld active, open
the ports yourself, and on a VPS also the provider's cloud firewall. `telinha
doctor` prints these commands with your ports (`listeners` check) when it finds
`ufw` or `firewall-cmd`:

```
sudo ufw allow 7881/tcp && sudo ufw allow 7882/udp && sudo ufw allow 80,443/tcp
sudo firewall-cmd --permanent --add-port=7881/tcp --add-port=7882/udp --add-service=http --add-service=https && sudo firewall-cmd --reload
```

Ports below 1024: the root install's systemd unit grants
`CAP_NET_BIND_SERVICE` to the service (a process capability, inherited by
caddy, so a re-downloaded caddy keeps it). A user install cannot bind 80/443
unless the kernel allows unprivileged low ports; setup offers this one `sudo`
step, which survives every update:

```
sudo sh -c 'printf "net.ipv4.ip_unprivileged_port_start=80\n" > /etc/sysctl.d/50-telinha.conf && sysctl --system'
```

(It covers IPv6 too, despite the name.) The alternative is `HTTPS_PORT=8443`,
`HTTP_PORT=0` and the router forwarding public 443 to 8443; setup writes that
when you decline the sysctl.

## Doctor

`telinha doctor` runs every check in order (10 s each at most) and prints one
row per check (`✓` ok, `!` warning, `✗` failure, `–` skipped) with what to do
about anything that is not ok. `--local` skips the checks that need the
internet (and the phone test), `--json` prints `{ checks, phone }`. Exit 1
when a check or the phone test failed.
It reads the same configuration as `run` (file plus environment), so it also
works in the container: `docker exec -it telinha bun server/src/index.ts doctor`.

| Check | What it looks at |
| --- | --- |
| `config` | `telinha.env` loads and validates; warnings, unknown keys; fails when other users can read the file |
| `binaries` | The helper binaries this configuration needs, at the pinned versions |
| `discord-token` | The bot token works; the client id is its application |
| `discord-intents` | Server Members and Presence intents are on |
| `discord-guild` | The bot is in `GUILD_ID` (else the invite link) |
| `discord-role`, `discord-channels` | `ROLE_ID` exists; `CHANNEL_IDS` are text or announcement channels of that server |
| `discord-redirect` | `<PUBLIC_URL>/auth/callback` is a redirect of the app |
| `public-ip` | The IP the internet sees |
| `dns` | The `PUBLIC_URL` host's A record (asked of 1.1.1.1 and 8.8.8.8) against the public IP; for a tunnel, that it resolves |
| `tls` | The certificate is valid for the host (warning under 14 days left) and `<PUBLIC_URL>/healthz` answers from outside |
| `listeners` | Telinha answers locally, every child is up, LiveKit and the media TCP port listen; the low-port hint for Linux users and the ufw/firewalld commands |
| `service` | Installed, running, starts at boot |
| `gateway` | A UPnP / NAT-PMP / PCP router and its external IP |
| `cgnat` | The router's external IP against the public IP: CGNAT fails, double NAT warns |
| `mappings` | Every needed port mapped by the router (else the list to forward by hand) |
| `update` | A newer stable release, or a staged, failed or pending update (native only) |

**The phone test.** With the service running, doctor asks it for a one-time
link and prints it with a QR code:

```
Open this on your phone with Wi-Fi OFF (mobile data):
  https://telinha.example.com/doctor?t=...
```

Opened on mobile data the test comes from outside your network, which is the
point. No Discord login is needed: the link works once and only within 10
minutes, and the cookie it leaves (15 minutes) opens nothing but the doctor
page and the LiveKit relay, for a private room of its own. The page runs, and
both the page and the terminal show:

| Row | Measures |
| --- | --- |
| HTTPS | The page loaded over HTTPS, and its latency |
| LiveKit connection | Signaling through `/livekit` on `PUBLIC_URL` |
| Sending video | Publishing a tiny test video track |
| First path | The protocol and IP the connection took, and its round trip |
| UDP / TCP | Media forced over each protocol in turn |

Reading a failure: LiveKit connection failed means Telinha is not reachable at
`PUBLIC_URL` from the internet (see the `dns`, `tls` and router checks); HTTPS
and LiveKit fine but UDP and TCP failed means the media ports are closed
(forward both); only UDP failed means UDP is not forwarded (video still works
over TCP, with more delay); only TCP failed means TCP is not forwarded (needed
where UDP is blocked); a first path to an IP that is not the public IP means a
wrong `LIVEKIT_NODE_IP`. Doctor waits up to 10 minutes (Ctrl+C skips);
`--no-phone` skips the test, and it is skipped without a terminal or with the
service stopped.

## Running as a service

**Windows.** `telinha service install` (from an administrator terminal; setup
does it with one UAC prompt) registers a Task Scheduler task named `Telinha`
that starts at boot, whether or not anyone is logged on, as your account
without storing a password, and **unelevated**: the internet-facing server and
its children run with a plain user token (nothing at runtime needs admin:
firewall rules are made at install time, updates write inside the home dir).
The task runs `telinha.exe service run --home "<home>"`, a small loop that
starts `telinha run`, starts it again at once after an update and with backoff
after a crash (1 s doubling up to 60 s), rolls back an update that fails to
start, and writes the log to `logs\telinha.log` (rotated at 10 MB, five kept).
Task Scheduler restarts the loop itself if it ever dies.

```
telinha service status       # installed / running / starts at boot, plus the task's last result
telinha service stop         # graceful through the local control endpoint, then schtasks /End (a stop Task Scheduler does not undo)
telinha service start | restart
telinha service uninstall --firewall   # removes the task and the rules; files stay
Get-Content "$env:LOCALAPPDATA\Telinha\logs\telinha.log" -Tail 50 -Wait
```

A console run works as well: `telinha run` in a terminal (or double-clicking
`telinha.exe`), Ctrl+C stops it. Only one `run` per home dir: a second one (a
console run while the service is up, a second double-click) leaves the first
alone and exits 1 with
`Telinha is already running (pid N). Use: telinha service status | telinha service stop`
(after a double-click it waits for Enter so the window does not vanish).

**Linux.** As root, `telinha service install` creates a `telinha` system user
and the unit `/etc/systemd/system/telinha.service`
(`ExecStart="/opt/telinha/bin/telinha" service run`, `Restart=on-failure`, the
low-port capability, `ProtectSystem=strict` with only `bin/`, `data/` and
`logs/` writable), then enables and starts it. The service user owns just
those three (it updates its own binary in `bin/`); `/opt/telinha` and
`config/` stay root's (`config/telinha.env` is `root:telinha` 0640), so
nothing root writes or runs lives in a directory the service user controls. `systemctl` manages it like any unit; `telinha service
start|stop|restart|status|uninstall` map to the same calls.

```
journalctl -u telinha -f                # telinha plus [livekit], [caddy], [cloudflared]
sudo telinha doctor                     # root's own copy of the CLI, talking to the service
```

As a user (or with `--user`), the unit goes to
`~/.config/systemd/user/telinha.service` (`systemctl --user`,
`journalctl --user -u telinha -f`), and `loginctl enable-linger $USER` keeps
it running without a login session (printed as a `sudo` hint when it needs
authentication: without it Telinha stops when you log out). For ports 80/443 see the sysctl in
[Ports](#ports-upnp-and-firewall).

**Docker**: compose's `restart: unless-stopped` is the service; see
[Running with Docker](#running-with-docker-linux).

## Updates

The native binary keeps itself current (`AUTO_UPDATE=on`, the default there;
Docker has [`telinha-update`](#updates-with-telinha-update) instead and a
source checkout is updated with git, where `AUTO_UPDATE=on` is a warning and
ignored):

- **Stable releases only**: the target is what
  `github.com/sombraSoft/telinha/releases/latest` points at (no API, no rate
  limit); a pre-release there is never installed. `UPDATE_PIN=v0.7.0` installs
  exactly that tag (pre-releases and downgrades allowed) and stays on it.
- First check 2 minutes after start, then every `UPDATE_CHECK_HOURS` (6).
- It downloads `telinha-<target>.tar.gz|zip` and `SHA256SUMS` of the tag and
  installs nothing unless the sha256 matches. A release whose assets are not
  there yet, or no network, is retried at the next check.
- **Deferral**: while rooms are open the update waits, at most
  `UPDATE_MAX_DEFER_HOURS` (12) per target, so a stuck room cannot block the
  release that fixes it.
- The running executable is renamed to `telinha.old-<version>` and the new one
  takes its place; the service loop starts it at once. A new release that pins
  newer helper binaries downloads them on that start
  (`binaries updated: livekit`).
- **Rollback**: when the new version fails to start twice in a row, the loop
  puts the previous executable back, records the tag as failed in
  `data/run/update.json`, and the timer skips that tag until a newer release
  exists.
- A console run installs the update but does not restart itself: it logs
  `update to vX installed; restart telinha to apply it`. The loop executable
  itself is replaced at the next `telinha service restart` or reboot.

```
telinha update --check     # current version, newest stable (or the pin), staged / failed / pending
telinha update             # with the service running: check and install now unless rooms are open
telinha update --now       # install even with rooms open; also retries a failed tag
```

With the service stopped, `telinha update` installs right away and the next
start uses it.

## Architecture

Telinha is the only HTTP front in every mode: Caddy (direct mode) only
terminates TLS, cloudflared (tunnel mode) only carries traffic. The login gate
and all routing live in telinha.

`INGRESS=direct` (bundled Caddy gets a Let's Encrypt certificate):

```
browser --> caddy :443 (TLS; :80 redirects)           child of telinha
              --> telinha 127.0.0.1:8081 (LISTEN)
                    /healthz      --> answered, no login
                    /internal/*   --> local control endpoint (bearer token, never through a proxy)
                    /r/assets/*   --> the pages' hashed assets, no login
                    /doctor*      --> phone test (one-time link)
                    /auth/*       --> OAuth login, /auth/members (no gate)
                    everything    --> gate: Discord login + role
                      /livekit/rtc* --> LiveKit 127.0.0.1:7880   (signaling relay, WebSocket)
                      /r/<code>     --> room page
                      /             --> redirect to /r/

media: browser <--> LiveKit   TCP 7881 / UDP 7882 (forwarded on the router or by UPnP)
```

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
relay (a few KB/s per client); media flows directly between the browser and
LiveKit on the media ports. The relay forwards only `/livekit/rtc` and
`/livekit/rtc/*`; anything else under `/livekit/` (notably LiveKit's Twirp
API) is a 404.

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
| `server/` | Bun TypeScript server, run directly in dev and Docker, compiled for the native binary. `index.ts` entry, `cli/` the commands (`main.ts` dispatch, `args.ts`, `term.ts` prompts, `strings.ts` EN/pt-BR, `control.ts` control-endpoint client, `setup.ts` and `setup/` the wizard, `doctor.ts`, `update.ts`, `service.ts`), `run.ts` the service start-up and shutdown, `config.ts` env parsing and validation, `envfile.ts` `telinha.env` parser, `paths.ts` home dirs and binary lookup, `bins.ts` helper-binary download (sha256-pinned), `archive.ts` tar.gz/zip, `version.ts`, `embedded.ts` the page inside the binary, `supervisor.ts` child processes, `children.ts` which children a mode needs, `render.ts` `livekit.yaml` and Caddyfile, `lock.ts` one run per home, `log.ts` logger with rotation, `control.ts` the control endpoint, `ipwatch.ts` public IP watch, `netinfo.ts` IP/DNS/TLS probes, `ddns.ts` DuckDNS, `nat/` UPnP IGD, NAT-PMP, PCP and the port mapper, `doctor/` checks, phone-test sessions, routes and QR, `service/` Task Scheduler, systemd, Windows Firewall and the `service run` loop, `update/` release lookup, download, swap, rollback, `proxy.ts` `/livekit/*` relay, `http.ts` gate and routes, `auth.ts` sessions/OAuth, `roles.ts` role check, `livekit.ts` tokens and RoomService calls, `codes.ts` room codes, `rooms.ts` room registry (SQLite), `lifecycle.ts` room poller, `card.ts` the status card, `members.ts` the member directory, `static.ts` page serving, `pages.ts` HTML pages, `bot.ts` Discord bot, `i18n.ts` strings, tests in `test/` |
| `web/` | Svelte 5 + TypeScript room page on plain Vite (`src/App.svelte`, `components/`, `lib/`, `styles/`), served under `/r/`, plus the doctor page (`doctor.html`, `src/doctor/`, plain TypeScript); `bun run build` writes `web/dist` |
| `versions.json` | Pinned `livekit-server`, `caddy` and `cloudflared` versions with the sha256 of every asset (linux amd64/arm64, windows amd64/arm64; cloudflared has no windows arm64 build, the amd64 one is used) |
| `scripts/bins.ts` | `bun run bins`: downloads and sha256-verifies the helper binaries (dev, the Docker build) |
| `scripts/build-binary.ts` | Native binaries: compile, package, `SHA256SUMS` |
| `scripts/versions.ts` | `check` (CI) and `refresh` (after a version bump) for `versions.json` |
| `scripts/dev.ts`, `stack.ts` | Local dev: fetches `livekit-server`, starts the Bun server (which supervises it) and Vite, cleans up on exit; `stack.ts --e2e` is Playwright's web server |
| `scripts/image.ts`, `smoke.sh` | `bun run image`: local container build plus the smoke test (`smoke.sh` ships in the image) |
| `e2e/` | Playwright specs (`*.e2e.ts`): login, routes and redirects, screen share between two browser contexts, language and theme, the member list, room closing, the phone test page |
| `Dockerfile` | Multi-stage, multi-arch build (page build, prod deps, binaries, Bun alpine runtime with the three binaries); entrypoint `bun server/src/index.ts`, command `run` |
| `deploy/` | `install.sh`, `install.ps1` (the native installers), the Docker host side: `compose.yml`, `compose.journald.yml`, `telinha.env.example`, `install-docker.sh`, `telinha-update` and its systemd service/timer |
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
bun run bins               # download all three helper binaries for this host into .cache/telinha/bin
bun run versions check     # validate versions.json (refresh: recompute every hash)
bun run compile --smoke    # native binaries for this OS into dist-bin/ (needs bun run build first)
```

`bun run dev` downloads `livekit-server` (pinned in `versions.json`,
sha256-verified) into `.cache/telinha/bin` on first run and starts the server
with `TELINHA_HOME=.cache/telinha`, `INGRESS=external`, `MEDIA=self`,
`LIVEKIT_NODE_IP=127.0.0.1`, `UPNP=off` and `AUTO_UPDATE=off`, so the server
supervises LiveKit exactly as in production and LiveKit advertises loopback
instead of a STUN-discovered public IP (it may still list the host's own IPv6
addresses). Vite proxies `/auth` and `/livekit` (WebSocket included) to the
server on `127.0.0.1:8081`, so the browser goes through the real gate and
signaling relay.

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

**Native binaries.** `bun run compile` (`scripts/build-binary.ts`) runs `bun build --compile`
with `web/dist` embedded (run `bun run build` first) and writes
`dist-bin/<target>/telinha[.exe]` plus the release archives
`dist-bin/telinha-linux-{x64,arm64}.tar.gz` and
`dist-bin/telinha-windows-{x64,arm64}.zip` (each with `LICENSE`) and
`dist-bin/SHA256SUMS`. `--target` takes `linux-x64`, `linux-arm64`,
`windows-x64`, `windows-arm64`, `linux`, `windows` or `host` (repeatable;
default: this OS's two targets), `--version X.Y.Z` (default `package.json`),
`--out DIR`, `--smoke` (runs the host binary's `--version`).
`bun run compile sums` rewrites `SHA256SUMS` for whatever archives
are in `dist-bin/`. Linux targets cross-compile from any host; Windows targets
build only on Windows, where Bun can write their version resource (product
name, publisher, version). The x64 targets are Bun's baseline builds. The
binary never reads a `.env` or `bunfig.toml` from the directory it runs in.

## Configuration

Everything lives in one `KEY=value` file, `telinha.env`, which `telinha setup`
writes ([`deploy/telinha.env.example`](deploy/telinha.env.example) lists every
key with comments). Real environment variables override the file; one set to
the empty string does not. A key the server does not know logs
`config: unknown key FOO in telinha.env` and is otherwise ignored.

**Quoting.** Docker compose's `env_file` interpolates `$VAR`, processes `\`
escapes in double quotes and strips ` #...` comments; telinha's own parser
reads values literally. The one spelling both read the same is a single-quoted
value, so **single-quote every value containing `$`, `\` or `#`**
(`COOKIE_SECRET='a$b#c'`). Telinha warns at start about an unquoted one. The
example file single-quotes every secret placeholder, and setup single-quotes
every secret it writes.

Identity and Discord:

| Key | Default | Notes |
| --- | --- | --- |
| `DISCORD_TOKEN` | required | Bot token |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | required | OAuth app; redirect `<PUBLIC_URL>/auth/callback` |
| `GUILD_ID`, `ROLE_ID` | required | One guild per deployment; members with the role may enter |
| `CHANNEL_IDS` | required | Comma list; the slash command works only there |
| `COMMAND_NAME` | `telinha` | Slash command name: lowercase, 1-32 letters, digits, `-` or `_` |
| `GROUP_NAME` | guild name | Shown in pages and the command's replies |
| `COOKIE_SECRET` | required | `openssl rand -base64 48` (setup generates it) |
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
| `DDNS_PROVIDER` | `none` | `duckdns` keeps `<DUCKDNS_DOMAIN>.duckdns.org` pointing at this network |
| `DUCKDNS_DOMAIN` | required with `duckdns` | The subdomain alone (`a-z`, `0-9`, `-`) |
| `DUCKDNS_TOKEN` | required with `duckdns` | The token from duckdns.org |

Media:

| Key | Default | Notes |
| --- | --- | --- |
| `MEDIA` | `self` | `self` runs the bundled LiveKit; `cloud` is reserved and rejected |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | required | Any pair you make up (secret 32+ chars; setup generates them); handed to LiveKit through its environment |
| `LIVEKIT_PORT` | `7880` | LiveKit signaling/API, loopback only |
| `MEDIA_TCP_PORT` | `7881` | ICE over TCP; forward it on the router |
| `MEDIA_UDP_PORT` | `7882` | ICE over UDP; forward it on the router |
| `UPNP` | `auto` | `auto` asks the router to forward the media ports (and in direct mode `HTTPS_PORT`/`HTTP_PORT`); `off` = by hand |
| `LIVEKIT_NODE_IP` | none | Static public IPv4: skips STUN and turns the IP watch off |
| `LIVEKIT_API_URL` | `http://127.0.0.1:<LIVEKIT_PORT>` | LiveKit HTTP API as telinha reaches it |
| `LIVEKIT_PUBLIC_URL` | `PUBLIC_URL` as `ws(s)://` + `/livekit` | Signaling URL the browser uses (telinha's relay) |
| `IP_WATCH_SECONDS` | `300` | Public IP check interval; `0` off |

Rooms:

| Key | Default | Notes |
| --- | --- | --- |
| `CLOSE_EMPTY_SECONDS` | `300` | A room closes for good after this long empty |
| `POLL_SECONDS` | `5` | How often rooms are checked |

Native install:

| Key | Default | Notes |
| --- | --- | --- |
| `AUTO_UPDATE` | `on` natively, `off` in Docker and from source | `on` installs new stable releases once no room is open; `on` outside the native binary is a warning and ignored |
| `UPDATE_PIN` | none | A release tag (`v0.7.0`, `v0.7.0-rc.1`) to install and stay on |
| `UPDATE_CHECK_HOURS` | `6` | 1-168 |
| `UPDATE_MAX_DEFER_HOURS` | `12` | Longest wait for open rooms per release, 0-720; `0` = do not wait |
| `LOCALE` | system language | `en` or `pt-BR` for the command line and setup (pages follow the browser) |

Locations:

| Key | Default | Notes |
| --- | --- | --- |
| `TELINHA_HOME` | per platform ([Install](#install)) | Root of `bin/ config/ data/ logs/`; the image sets `/telinha` |
| `TELINHA_ENV` | `<home>/config/telinha.env` | Which file to load; only as a real environment variable |
| `DATA_DIR` | `<home>/data` | Registry, rendered configs and state (`run/`), Caddy certificates (`caddy/`) |
| `BIN_DIR` | `<home>/bin` | Looked at before `PATH` for the helper binaries |
| `WEB_DIR` | the page inside the native binary, else `web/dist` next to the sources | Built page |

Dev only: `DEV_USER`, `DEV_LOCALE` (see Development). Reserved for LiveKit
Cloud / TURN, accepted without a warning and ignored for now:
`LIVEKIT_CLOUD_URL`, `TURN_TLS_PORT`.

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

Helper binaries: the native binary checks them at every start and downloads a
missing one, or the version a new release pins (`binaries updated: ...`);
offline with the binaries in place it carries on. From source and in the image
nothing is downloaded at start, and a missing one stops start-up with
`livekit-server not found: put it in <bin> (bun scripts/bins.ts livekit) or on PATH`.

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
`HTTPS_PORT` (443) to the host, plus the two media ports (or let UPnP do it).
Router port translation works: with `PUBLIC_URL=https://telinha.example.com`
(public 443) and the router mapping 443 to the host's 8443, set
`HTTPS_PORT=8443`. A `PUBLIC_URL` port that differs from `HTTPS_PORT` is only a
warning (`config: PUBLIC_URL port 443 differs from HTTPS_PORT 8443; assuming
the router translates 443 -> 8443`), never an error. Natively, binding 80/443
works as described in [Ports](#ports-upnp-and-firewall); in the image Caddy
has `cap_net_bind_service`, so it binds 80/443 as the unprivileged `bun` user.

**tunnel.** No inbound HTTP ports. Cloudflare Zero Trust -> Networks ->
Tunnels -> create a tunnel, copy its token into `TUNNEL_TOKEN` (uncomment it), and give it a
public hostname whose service is `http://localhost:<LISTEN port>` (default
`http://localhost:8081`). No Caddy runs in this mode.

**external.** Your proxy terminates TLS and forwards to `LISTEN`. It must pass
WebSocket upgrades (the signaling relay at `/livekit/rtc`) and must set
`X-Forwarded-For` (every mainstream proxy does by default): telinha uses the
forwarding headers to tell a public `/healthz` request from a local one, and to
keep the control endpoint local. The gate is still telinha's; `/auth/check`
remains available if your proxy wants a `forward_auth` of its own.

**Media (`MEDIA=self`).** Browsers send media straight to LiveKit, so forward
TCP `MEDIA_TCP_PORT` (7881) and UDP `MEDIA_UDP_PORT` (7882) to the host in
every ingress mode (tunnels do not carry WebRTC), by hand or through UPnP.
LiveKit learns its public IP through STUN once at start; on a residential line
the IP watch polls `https://1.1.1.1/cdn-cgi/trace` (then
`https://api.ipify.org`) every `IP_WATCH_SECONDS` and, when the IP changes,
renews the router mappings, nudges DuckDNS and restarts the LiveKit child
(rooms blip, see Room lifecycle). With a static IP set `LIVEKIT_NODE_IP`
instead. Without a domain and behind CGNAT: see [Domains](#domains).

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
in-process IP watch, a crash, an update) only blips it: the page fetches a new
token and rejoins once (a stream has to be shared again).

Card edits use the bot token, so the bot must still see the channel. If the
message is deleted, or the bot can't edit it (403), the room keeps its
lifecycle and the card is left alone. A closed card that could not be sent
yet is retried after a restart.
The registry is `data/telinha.sqlite` (natively) or the `telinha-data` volume
in `deploy/compose.yml`; losing it only means the links of rooms open at that
moment stop working.

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
(`/r/` redirects to the login, then serves the page with the command meta), a
404 for `/livekit/` outside the `/rtc` allowlist, page assets without a login,
`/doctor` 404 without a link, the control endpoint (404 without the token or
through a proxy, status with it), a second `run` on the same data refusing to
start while the first keeps running, and a graceful stop through the control
endpoint that leaves no token or pidfile behind.

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
Intent** and **Presence Intent** (setup switches both on). Without them the
bot fails to log in ("disallowed intents"). Only the role members' presences
are cached.

## Running with Docker (Linux)

Needs Docker Engine with the compose plugin. The image
`ghcr.io/sombrasoft/telinha` is multi-arch (`linux/amd64`, `linux/arm64`) and
bundles `livekit-server`, `caddy` and `cloudflared`; its entrypoint is the
`telinha` command line (`bun server/src/index.ts`, default command `run`). The
host keeps everything in `/opt/telinha`:

| Path | What |
| --- | --- |
| `/opt/telinha/compose.yml` | One service, `telinha`, host networking, `init: true`, volume `telinha-data` at `/telinha/data` |
| `/opt/telinha/compose.journald.yml` | Optional override: journald logging, tag `telinha` |
| `/opt/telinha/compose.override.yml` | Yours, optional; compose (and `telinha-update`) pick it up automatically |
| `/opt/telinha/config/telinha.env` | The configuration (`chmod 600`) |
| `/opt/telinha/.env` | `TELINHA_VERSION`, `TELINHA_DIGEST`, written by `telinha-update`; without it compose runs `latest` |
| `/opt/telinha/pin`, `deferred` | `telinha-update` state |

With the installer: `curl -fsSL .../install.sh | sh -s -- --docker` (see
[Install](#install)), or from a clone or the release tarball:

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
into `/usr/local/sbin` and its units into `/etc/systemd/system`. On a terminal,
while `telinha.env` still has empty or `<placeholder>` values, it starts the
[setup wizard](#docker) in the image of the bundle's `telinha-image.digest`, by
digest (`--setup` always, `--no-setup` never), and it warns while values are
still missing. With `TELINHA_VERSION=<tag>` it also writes that version to
`/opt/telinha/.env`, so compose runs it rather than `latest`. Then either start once by hand:

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

UPnP and DuckDNS work in the container as natively (host networking); the
native self-update does not apply (`AUTO_UPDATE` stays off). The other commands
run inside it: `docker exec -it telinha bun server/src/index.ts doctor`.

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

### Updates with telinha-update

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
(`telinha-image.digest`; missing means the release is not complete yet,
retried next tick), pulls `ghcr.io/sombrasoft/telinha:<version>` and the same image
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

On Windows the [native install](#install) is the simpler path. Docker Desktop
also works: `network_mode: host` needs Docker Desktop 4.34 or newer with
**Settings -> Resources -> Network -> Enable host networking** turned on.
WebRTC media over UDP through that path is unverified. Use `INGRESS=tunnel`
there (nothing to bind on 80/443). `install-docker.sh` and `telinha-update`
are Linux only.

## Releases

1. Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org).
2. release-please keeps a Release PR open with the version bump and changelog.
3. Merging it creates a **draft** GitHub release (`"draft": true` in
   `release-please-config.json`). A draft has no tag and is never `latest`, so
   `releases/latest/download/*`, the installers and both updaters never see a
   release without its assets. Every later job checks out the release commit.
4. `binaries` (matrix: `ubuntu-latest` builds `linux-x64` and `linux-arm64`,
   `windows-latest` builds `windows-x64` and `windows-arm64`, where Bun writes
   the Windows version resource) runs `bun scripts/build-binary.ts --target
   linux|windows --version X.Y.Z --smoke`. In parallel `image` builds
   `linux/amd64` and `linux/arm64` and pushes `ghcr.io/sombrasoft/telinha`
   tagged `X.Y.Z`, `X.Y` and `latest`, with a provenance attestation on the
   index digest.
5. `release-assets` writes `SHA256SUMS` for the four archives,
   `telinha-deploy.tar.gz` and `telinha-image.digest`, attests all of them and
   `SHA256SUMS` (one GitHub build provenance attestation), uploads
   `telinha-linux-x64.tar.gz`, `telinha-linux-arm64.tar.gz`,
   `telinha-windows-x64.zip`, `telinha-windows-arm64.zip`, `SHA256SUMS`,
   `telinha-image.digest` (the index digest, one `sha256:...` line;
   `telinha-update` trusts nothing else), `telinha-deploy.tar.gz`
   (`compose.yml`, `compose.journald.yml`, `telinha.env.example`,
   `install-docker.sh`, `telinha-update` and its units, `telinha-image.digest`), `install.sh` and
   `install.ps1`, then publishes the release, which creates the tag
   `vX.Y.Z` and, for a stable version, makes it `latest`. A failure anywhere
   leaves only a draft to finish or delete.
6. Native installs pick the release up at their next check (every 6 hours by
   default, later while rooms are open); hosts running `telinha-update` within
   about 5 minutes.

Pre-releases: add a `Release-As: X.Y.Z-rc.N` footer to a commit. `release.yml`
marks hyphenated tags as GitHub pre-releases, and the image gets only the
`X.Y.Z-rc.N` tag (no `latest`, no `X.Y`). `releases/latest` never points at
them; the native updater and `telinha-update` ignore them unless pinned
(`UPDATE_PIN`, `telinha-update pin`).

Required checks on `main`: `test (ubuntu-latest)`, `test (windows-latest)`,
`lint` (shellcheck of `deploy/install-docker.sh`, `deploy/install.sh`,
`deploy/telinha-update` and `scripts/smoke.sh`, a PowerShell parse and
PSScriptAnalyzer run of `deploy/install.ps1`, actionlint,
`bun scripts/versions.ts check`), `gitleaks`, `image` (builds both
architectures, smoke-tests amd64). Two jobs also run on every PR but are not
required yet: `e2e` (Playwright on ubuntu) and `binaries (ubuntu-latest)` /
`binaries (windows-latest)`, which compile the native targets and smoke-test
them: `--version`, then a real `run` in `DEV_USER` mode until `/healthz`
reports LiveKit up (the binary downloads `livekit-server` itself), the gate and
`/doctor` answers, a graceful stop; `linux-arm64 --version` under QEMU; and the
version resource (`ProductName` Telinha) of both Windows binaries.

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
release, and native installs download the new helper binaries on their next
start.

Versions stay below 1.0. `bump-minor-pre-major` is on, so while in 0.x a
`fix` bumps the patch and a `feat` or breaking change bumps the minor. 1.0.0
only happens when a commit carries a `Release-As: 1.0.0` footer.

## Roadmap

- Docs site: Starlight in English and pt-BR, published on release, with
  port-forwarding pages for common Brazilian ISP routers.
- Windows: a tray app, and code-signed binaries.
- Media: LiveKit Cloud (`MEDIA=cloud`) for hosts that cannot open ports, and
  TURN over TLS on 443 via caddy-l4.

## License

MIT
