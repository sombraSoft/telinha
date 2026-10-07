---
title: Running as a service
description: How Telinha keeps running in the background on Windows, on Linux as root or as a user, and in Docker, and the commands to manage it.
sidebar:
  order: 5
---

As a service, Telinha starts with the computer, comes back after a crash or
an update, and keeps running when nobody is logged in. `telinha setup`
installs it for you; this page is what it set up and how to manage it. The
`service` check of [`telinha doctor`](/telinha/guides/doctor/) tells you
whether it is installed, running and set to start at boot. All the commands
and flags are in [Command line](/telinha/reference/cli/).

## Windows

`telinha service install` registers a Task Scheduler task named `Telinha`. The
setup runs it with one administrator (UAC) prompt, together with the firewall
rules; to redo it, run `telinha setup` again. The task:

- starts at boot, whether or not anyone is logged on;
- runs as your account without storing a password;
- runs **unelevated**: the internet-facing server and its helpers get a plain
  user token. Nothing at runtime needs administrator rights: the firewall
  rules are made at install time and updates write inside the Telinha folder.

The task runs `telinha.exe service run --home "<home>"`, a small loop that
starts `telinha run`, starts it again at once after an update and with a
growing pause after a crash (1 s, doubling up to 60 s), rolls back an update
that fails to start, and writes the log to `logs\telinha.log` in the Telinha
folder (rotated at 10 MB, five files kept). Task Scheduler restarts the loop
itself if it ever dies.

```
telinha service status       # installed / running / starts at boot, plus the task's last result
telinha service stop         # graceful stop, then ends the task (Task Scheduler does not undo it)
telinha service start
telinha service restart
telinha service uninstall --firewall   # removes the task and the firewall rules; the files stay
Get-Content "$env:LOCALAPPDATA\Telinha\logs\telinha.log" -Tail 50 -Wait
```

The firewall rules are described in
[Port forwarding](/telinha/guides/port-forwarding/#firewalls).

A console run works as well: `telinha run` in a terminal, or a double-click on
`telinha.exe`; Ctrl+C stops it. Only one `telinha run` per Telinha folder: a
second one (a console run while the service is up, a second double-click)
leaves the first alone and exits 1 with
"Telinha is already running (pid N). Use: telinha service status | telinha service stop".
After a double-click it waits for Enter, so the window does not vanish.

## Linux as root

`sudo telinha service install` (the setup runs it for a root install) creates
a `telinha` system user and the unit `/etc/systemd/system/telinha.service`,
then enables and starts it. The unit:

- runs `"/opt/telinha/bin/telinha" service run` as the `telinha` user, the
  same loop as on Windows, with `Restart=on-failure` on top;
- grants `CAP_NET_BIND_SERVICE`, so Caddy can bind ports 80 and 443 on a VPS.
  It is a process capability that Caddy inherits, so a newly downloaded Caddy
  keeps it;
- uses `ProtectSystem=strict`, with only `bin/`, `data/` and `logs/`
  writable.

The service user owns just those three folders (it updates its own binary in
`bin/`). `/opt/telinha` and `config/` stay root's, and `config/telinha.env` is
`root:telinha` with mode 0640, so nothing root writes or runs lives in a
folder the service user controls. For the same reason, `sudo telinha` runs
root's own copy of the command line (`/usr/local/bin/telinha`), never the
service's.

```
sudo systemctl status telinha
journalctl -u telinha -f        # Telinha's lines plus [livekit], [caddy], [cloudflared]
sudo telinha doctor             # root's copy of the command line, talking to the service
```

`systemctl` manages it like any other unit, and
`telinha service start|stop|restart|status|uninstall` map to the same calls.

## Linux as a user

Without root (or as root with `--user`), `telinha service install` writes a
user unit to `~/.config/systemd/user/telinha.service` and starts it:

```
systemctl --user status telinha
journalctl --user -u telinha -f
loginctl enable-linger $USER
```

A user service normally stops when you log out, and the end of an SSH session
counts. Lingering keeps it running: the install runs
`loginctl enable-linger` for you, and prints it as a `sudo` command when it
needs authentication.

At home the standard setups need no low port: a DuckDNS address listens on
8443 and a Cloudflare Tunnel listens on nothing, so a user install works as
it is.

### Low ports on a VPS user install

A user service cannot bind ports below 1024 unless the kernel allows
unprivileged low ports, which `direct` mode on a VPS needs for 80 and 443.
The setup offers this one `sudo` step, and it survives every update:

```
sudo sh -c 'printf "net.ipv4.ip_unprivileged_port_start=80\n" > /etc/sysctl.d/50-telinha.conf && sysctl --system'
```

It covers IPv6 too, despite the name. When you decline it, the setup prints
the command for later and changes nothing else; the `listeners` check of
`telinha doctor` prints it again while nothing listens on the HTTPS port. A
root install needs none of this.

## Docker

Compose is the service: `deploy/compose.yml` sets `restart: unless-stopped`,
so the container comes back with Docker after a reboot or a crash. Manage it
from `/opt/telinha`:

```
cd /opt/telinha && docker compose up -d
docker compose restart
docker compose down
docker logs -f telinha
```

Your own settings go in `/opt/telinha/compose.override.yml`, which compose and
`telinha-update` pick up automatically. One file holds them all, for example
logging to journald (so the log survives container recreation, read with
`journalctl -t telinha`) and a memory cap, LiveKit included:

```yaml
services:
  telinha:
    logging:
      driver: journald
      options:
        tag: telinha
    mem_limit: 1g
```

The journald part is also shipped as `/opt/telinha/compose.journald.yml`; copy
it to `compose.override.yml` when that is all you need.

The healthcheck fetches `http://127.0.0.1:8081/healthz`. If you change the
`LISTEN` port, override the healthcheck in the same file with your port:

```yaml
services:
  telinha:
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          body=$$(wget -qO- http://127.0.0.1:9000/healthz) &&
          case "$$body" in *'"restarting"'*) exit 1 ;; esac
```

Setting it up: [Docker](/telinha/start/docker/). Keeping it current:
[Updates](/telinha/guides/updates/#docker-host).
