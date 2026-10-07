---
title: FAQ
description: Answers to common questions about costs, domains, CGNAT, strict networks, data, safety and removal.
---

## Is it free?

Yes. Telinha is MIT licensed. The only costs are the ones you choose: a VPS if your home network cannot host it, and a domain name if you want your own (DuckDNS and sslip.io are free alternatives, see [Address, HTTPS and ingress modes](/telinha/guides/domains/)).

## Why not Discord Go Live?

Go Live is blocked in Brazil. Telinha gives the group the same thing on a machine you control: members log in with Discord, a role check gates entry, and the `/telinha` command opens a room and posts a live status card in the channel.

## How many people can watch?

There is no fixed limit in Telinha. The sharer uploads one stream to LiveKit and LiveKit sends a copy to each viewer, so what matters is the upload speed of the machine that runs Telinha. On a home line, the upload speed is the number to look at; on a VPS it is the plan's bandwidth. With `MEDIA=cloud` LiveKit Cloud does the sending, and its free plan's monthly limits are what count (see [LiveKit Cloud](/telinha/guides/livekit-cloud/#the-free-plan)).

## Does it work on phones?

Watching works in a phone browser. Sharing a screen is a browser feature, so it depends on what the phone's browser offers; a computer is the reliable way to share.

## Which browsers share best?

Chrome-family browsers. Streams use AV1 when the browser has a hardware encoder for it, else H.265, else H.264, always with an H.264 backup for viewers that cannot decode the first choice.

## Can I use it without a domain?

Yes. At home, answer *No* to *Do you have a domain on Cloudflare?* in the setup: Telinha uses a free DuckDNS name, which also follows a changing IP, and serves HTTPS on port 8443 with a certificate it gets through DuckDNS, so nothing has to open on 80 or 443. The links then carry the port (`https://my-group.duckdns.org:8443/r/...`), and some strict networks (offices, schools) only let browsers reach port 443, so people there cannot open them; a domain on Cloudflare (Cloudflare Tunnel) avoids that. On a VPS with a fixed public IPv4, sslip.io needs no setup at all. See [Address, HTTPS and ingress modes](/telinha/guides/domains/) and [Choose your setup](/telinha/start/choose/).

## Why does my link have :8443 in it?

Because Telinha runs at home with a DuckDNS address. Home internet connections usually do not let the web ports 80 and 443 in, so Telinha serves HTTPS on a port of its own, 8443 (or the one you picked), and the address has to say which. It is a normal HTTPS address with a valid certificate. If people on a strict network cannot open it, use a domain on Cloudflare: run `telinha setup` again and answer *Yes* to *Do you have a domain on Cloudflare?* See [DuckDNS on port 8443](/telinha/guides/domains/#duckdns-on-port-8443).

## Can I run it behind CGNAT?

Yes, with two pieces. With CGNAT your provider shares one public IPv4 between customers and nothing from the internet reaches your network, so port forwarding and UPnP cannot help. The pages need a Cloudflare Tunnel (a domain on Cloudflare) or a VPS. The video needs either a public IPv4 (ask the provider; often a free opt-out) or `MEDIA=cloud`: [LiveKit Cloud](/telinha/guides/livekit-cloud/) carries the media and needs no open port, and its free Build plan allows 5,000 participant-minutes and 50 GB downstream a month, with up to 100 participants connected at once. Or run the whole thing on a small VPS. `telinha doctor` detects CGNAT with the `cgnat` check. Details: [CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat).

## Can people on a strict network (only port 443) watch?

Some networks (offices, schools, some mobile carriers) only let browsers reach port 443, which blocks the media ports. On a VPS on port 443, Telinha serves [TURN over TLS on port 443](/telinha/guides/turn/): the browser falls back to relaying the video through `turn.<host>:443`, which looks like any HTTPS site to the network. It is on by itself with a DuckDNS or sslip.io name; with your own domain it takes one DNS record and `TURN=on`. At home Telinha serves no TURN (home connections do not let port 443 in), but a [LiveKit Cloud](/telinha/guides/livekit-cloud/) project brings LiveKit's own TURN servers, wherever Telinha runs.

## Can two deployments share a Discord server?

Yes, give each one a different `COMMAND_NAME` (and its own Discord application), so the slash commands do not collide. Each deployment serves one Discord server and one role.

## How do I change settings?

Run `telinha setup` again: every question starts at the current value, Enter keeps a secret as it is, generated secrets stay, and keys setup does not manage (`ACME_EMAIL`, `SESSION_DAYS`, ...) are kept under an `Other settings` section of the file. The Review can also write a new cookie secret, which logs everyone out. A running service restarts with the new file; a console run has to be restarted by hand. Or edit `telinha.env` and restart (`telinha service restart`, or restart the container). Every key is listed in [Configuration](/telinha/reference/configuration/).

## Where is my data?

Everything lives in the Telinha folder:

| Platform | Telinha folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Telinha` |
| Linux, as root | `/opt/telinha` |
| Linux, as a user | `~/.local/share/telinha` |
| Docker | `/opt/telinha` on the host for the compose files and `config/telinha.env`, the `telinha-data` volume for the data |

Inside it (`TELINHA_HOME`, or `--home DIR` on any command, points at another one):

| Path | What |
| --- | --- |
| `bin/telinha[.exe]` | The program (the installers and the updater write it) |
| `bin/telinha.old-<version>[.exe]`, `bin/telinha.failed-<tag>[.exe]` | The executable an update replaced, or one that was rolled back; removed after the next good start (on Windows one the service still runs from stays until the service restarts) |
| `bin/telinha-tray.exe` | Windows: the [tray icon](/telinha/guides/tray/); updates replace it like `telinha.exe` (with the same `.old-` and `.failed-` leftovers) |
| `bin/livekit-server`, `caddy`, `cloudflared` (`.exe` on Windows) and `<tool>.version` | The helper binaries this configuration needs, sha256-checked when downloaded (by setup, or at a start that finds them missing or at an older pinned version); `PATH` is tried after `bin/`. `caddy` is Telinha's own Caddy build (with the DuckDNS DNS module and layer4), fetched from the Telinha release and checked against its `SHA256SUMS` |
| `config/telinha.env` | The configuration, owner-only: Linux user install mode 0600; Linux root install `root:telinha` 0640 in a `root:telinha` 0750 `config/` (the service reads it through its group); on Windows an ACL with only you, SYSTEM and Administrators |
| `data/telinha.sqlite` | The room registry. If it is lost, only the links of rooms open at that moment stop working |
| `data/run/` | The rendered `livekit.yaml` and `Caddyfile` (rewritten before every start: edit `telinha.env`, never these) and run state: `children.json`, `public-ip`, `telinha.pid` (one `run` per Telinha folder), `service.pid`, `control.token`, `update.json`, `upnp.json`, and on Windows `tray.json` (written by the tray icon while it runs) |
| `data/caddy/` | Caddy's certificates and ACME account (direct mode) |
| `logs/telinha.log` (`.1` to `.5`) | The service's log on Windows, rotated at 10 MB (Linux logs to the journal) |
| `logs/telinha-tray.log` | Windows: the tray icon's own log |
| `service/telinha-task.xml`, `install-result.json` | Windows: the registered task, and what the elevated install did |

## Is it safe to expose?

Every page is behind the Discord login and the role check. Telinha itself proxies the LiveKit signaling and forwards only `/livekit/rtc`, so LiveKit's own API is never reachable from outside (with `MEDIA=cloud` browsers talk to LiveKit Cloud directly, with a room token that lasts 10 minutes). Secrets never go on a command line (setup refuses `--discord-token` and friends and reads them from the environment or a file), and `telinha.env` is readable by its owner only (plus the service's group on a Linux root install). The helper binaries are pinned by sha256, and every release carries `SHA256SUMS` plus a build provenance attestation you can check by hand; both cover Telinha's own Caddy build too, see [Updates](/telinha/guides/updates/).

## How do I remove it?

Native install: remove the service, then delete the Telinha folder.

```
telinha service uninstall --firewall
```

Run it from an administrator terminal on Windows; there it also closes the tray icon and turns its *Start with Windows* off. `uninstall` keeps the files, so delete the Telinha folder yourself afterwards (see the table above). A Linux root install also has `/usr/local/lib/telinha` and `/usr/local/bin/telinha`.

Docker:

```
cd /opt/telinha && docker compose down -v
sudo systemctl disable --now telinha-update.timer
sudo rm -f /usr/local/sbin/telinha-update /etc/systemd/system/telinha-update.service /etc/systemd/system/telinha-update.timer
sudo rm -rf /opt/telinha
```

`down -v` also removes the `telinha-data` volume (the room registry and certificates).
