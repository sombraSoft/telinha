---
title: FAQ
description: Answers to common questions about costs, domains, CGNAT, data, safety, removal and what is planned.
---

## Is it free?

Yes. Telinha is MIT licensed. The only costs are the ones you choose: a VPS if your home network cannot host it, and a domain name if you want your own (DuckDNS and sslip.io are free alternatives, see [Address, HTTPS and ingress modes](/telinha/guides/domains/)).

## Why not Discord Go Live?

Go Live is blocked in Brazil. Telinha gives the group the same thing on a machine you control: members log in with Discord, a role check gates entry, and the `/telinha` command opens a room and posts a live status card in the channel.

## How many people can watch?

There is no fixed limit in Telinha. The sharer uploads one stream to LiveKit and LiveKit sends a copy to each viewer, so what matters is the upload speed of the machine that runs Telinha. On a home line, the upload speed is the number to look at; on a VPS it is the plan's bandwidth.

## Does it work on phones?

Watching works in a phone browser. Sharing a screen is a browser feature, so it depends on what the phone's browser offers; a computer is the reliable way to share.

## Which browsers share best?

Chrome-family browsers. Streams use AV1 when the browser has a hardware encoder for it, else H.265, else H.264, always with an H.264 backup for viewers that cannot decode the first choice.

## Can I use it without a domain?

Yes. At home, use a free DuckDNS name, which also follows a changing IP. On a VPS with a fixed public IPv4, sslip.io needs no setup at all. See [Address, HTTPS and ingress modes](/telinha/guides/domains/) and [Choose your setup](/telinha/start/choose/).

## Can I run it behind CGNAT?

Not at home. With CGNAT your provider shares one public IPv4 between customers and nothing from the internet reaches your network, so port forwarding and UPnP cannot help. Ask the provider for a public IPv4 (often a free opt-out), or run Telinha on a small VPS. A Cloudflare Tunnel gets the pages through, but the media ports still need to be reachable. `telinha doctor` detects it with the `cgnat` check. A LiveKit Cloud mode for hosts that cannot open ports is planned. Details: [CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat).

## Can two deployments share a Discord server?

Yes, give each one a different `COMMAND_NAME` (and its own Discord application), so the slash commands do not collide. Each deployment serves one Discord server and one role.

## How do I change settings?

Run `telinha setup` again: every question defaults to the current value, secrets offer `(keep current)`, generated secrets stay, and keys the wizard does not manage (`ACME_EMAIL`, `SESSION_DAYS`, ...) are kept under an `Other settings` section of the file. The review can also write a new cookie secret, which logs everyone out. A running service restarts with the new file; a console run has to be restarted by hand. Or edit `telinha.env` and restart (`telinha service restart`, or restart the container). Every key is listed in [Configuration](/telinha/reference/configuration/).

## Where is my data?

Everything lives in the home directory:

| Platform | Home |
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
| `bin/livekit-server`, `caddy`, `cloudflared` (`.exe` on Windows) and `<tool>.version` | The helper binaries this configuration needs, sha256-checked when downloaded (by setup, or at a start that finds them missing or at an older pinned version); `PATH` is tried after `bin/` |
| `config/telinha.env` | The configuration, owner-only: Linux user install mode 0600; Linux root install `root:telinha` 0640 in a `root:telinha` 0750 `config/` (the service reads it through its group); on Windows an ACL with only you, SYSTEM and Administrators |
| `data/telinha.sqlite` | The room registry. If it is lost, only the links of rooms open at that moment stop working |
| `data/run/` | The rendered `livekit.yaml` and `Caddyfile` (rewritten before every start: edit `telinha.env`, never these) and run state: `children.json`, `public-ip`, `telinha.pid` (one `run` per home), `service.pid`, `control.token`, `update.json`, `upnp.json` |
| `data/caddy/` | Caddy's certificates and ACME account (direct mode) |
| `logs/telinha.log` (`.1` to `.5`) | The Windows service log, rotated at 10 MB (Linux logs to the journal) |
| `service/telinha-task.xml`, `install-result.json` | Windows: the registered task, and what the elevated install did |

## Is it safe to expose?

Every page is behind the Discord login and the role check. Telinha itself relays the LiveKit signaling and forwards only `/livekit/rtc`, so LiveKit's own API is never reachable from outside. Secrets never go on a command line (setup refuses `--discord-token` and friends and reads them from the environment or a file), and `telinha.env` is readable by its owner only (plus the service's group on a Linux root install). The helper binaries are pinned by sha256, and every release carries `SHA256SUMS` plus a build provenance attestation you can check by hand, see [Updates](/telinha/guides/updates/).

## How do I remove it?

Native install: remove the service, then delete the home directory.

```
telinha service uninstall --firewall
```

Run it from an administrator terminal on Windows. `uninstall` keeps the files, so delete the home directory yourself afterwards (see the table above). A Linux root install also has `/usr/local/lib/telinha` and `/usr/local/bin/telinha`.

Docker:

```
cd /opt/telinha && docker compose down -v
sudo systemctl disable --now telinha-update.timer
sudo rm -f /usr/local/sbin/telinha-update /etc/systemd/system/telinha-update.service /etc/systemd/system/telinha-update.timer
sudo rm -rf /opt/telinha
```

`down -v` also removes the `telinha-data` volume (the room registry and certificates).

## What is planned?

- Windows: a tray app, and code-signed binaries.
- Media: LiveKit Cloud (`MEDIA=cloud`) for hosts that cannot open ports, and TURN over TLS on 443.

None of these has a date.
