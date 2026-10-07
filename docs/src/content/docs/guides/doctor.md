---
title: Doctor and troubleshooting
description: Run telinha doctor, read its checklist and the phone test, and fix the usual problems by symptom.
sidebar:
  order: 3
---

`telinha doctor` checks everything between a Discord member and a working
video: the configuration, the helper programs, the Discord app, the public
address, the local service, the router and updates. It then offers a test
from your phone, on mobile data, that measures the real path from outside your
network. Run it after the setup, after changing anything, and whenever
something stops working.

## Running it

```
telinha doctor              # every check, then the phone test
telinha doctor --local      # skip the checks that need the internet, and the phone test
telinha doctor --no-phone   # every check, no phone test
telinha doctor --json       # machine-readable result on stdout
```

On a terminal doctor is an interactive checklist. Without one (a pipe, a
script, a scheduled task) or with `--json` it prints plain lines instead; both
run the same checks.

- It reads the same configuration as `telinha run`: `telinha.env` plus the
  environment.
- Each check gets at most 10 seconds; a check that takes longer fails with
  "Did not finish within 10 s".
- `--local` skips the Discord, public IP, DNS and HTTPS checks along with the
  phone test.
- `--json` prints `{ checks, phone }` (`phone` only when the test ran); the
  phone link and the QR code then go to stderr.
- The exit code is 1 when a check or the phone test failed; warnings and
  skipped checks do not count. Ctrl+C in the checklist exits with 130.
- It speaks the language of the command line: `--lang pt-BR` or `LOCALE`.

Where to run it:

| Install | Command |
| --- | --- |
| Windows, Linux as a user | `telinha doctor` |
| Linux as root | `sudo telinha doctor` |
| Docker | `docker exec -it telinha bun server/src/index.ts doctor` |
| From a clone | `bun server/src/index.ts doctor` |

The setup shows the same checklist at its end (*Show the doctor report*), with
the results of the checks it already ran.

## The checklist

One row per check, in the order you would fix things. A spinner shows while a
check runs; then the row gets an icon and a one-line result:

| Icon | Meaning |
| --- | --- |
| `✔` | ok |
| `!` | warning: works, but something is off or could not be confirmed |
| `✖` | failure: this breaks Telinha for someone |
| `–` | skipped: not relevant to this setup, or an earlier check has to pass first |

Under the list a line counts them (`11 ok · 1 warning · 1 failed · 2 skipped`),
in the colour of the worst one. Move to a row and press Enter to open it: its
details, and for a row that is not ok a **Fix** line saying what to do. An ok
row opens to its details, or to *Nothing to do*.

| Key | What it does |
| --- | --- |
| `↑` `↓` (or `k` `j`) | Move between rows |
| `Enter`, `Space` or `→` | Open or close the row under the cursor |
| `r` | Run every check again, with fresh data: do it after fixing something |
| `p` | Start a new phone test (when Telinha is running) |
| `s` | Stop waiting for the phone |
| `q` or `Esc` | Quit; the exit code is 1 when a check or the phone test failed |

A row opened on a failed DNS check, for example:

```
✖ DNS                telinha.example.com points at 198.51.100.7, but the public IP is 203.0.113.9.
                     └ Fix
                       Change the A record of telinha.example.com to 203.0.113.9.
```

Fix from the top: a broken configuration skips most checks after it, and a
bot token Discord rejects skips the other Discord checks. Every check, what it
looks at and what its result means:
[Doctor checks](/telinha/reference/doctor-checks/).

## Plain output

Without a terminal, doctor prints one line per check, then a summary, with the
details dimmed and the fix after an arrow:

```
✓ Public IP          The internet sees this network as 203.0.113.9.
✗ DNS                telinha.example.com points at 198.51.100.7, but the public IP is 203.0.113.9.
                     → Change the A record of telinha.example.com to 203.0.113.9.
! Port forwarding    Not forwarded: UDP 7882.
                     → Forward them by hand on the router to 192.168.0.10: UDP 7882
```

The icons are `✓`, `!`, `✗` and `–`, with the same meanings as above. The phone
test is skipped without a terminal (its link needs someone to open it), unless
`--json` runs on one.

## The phone test

With the service running and the checks done, doctor asks Telinha for a
one-time link. In the checklist it appears in a panel beside the list (under
it on a narrow terminal, where the code takes the screen until the phone
answers) with a QR code, and the same panel then shows the result:

```
Open this on your phone with Wi-Fi OFF (mobile data):
  https://telinha.example.com/doctor?t=...
```

Mobile data matters: on your own Wi-Fi the phone is inside your network and
proves nothing about the router. No Discord login is needed. The link works
once and only within 10 minutes, and the cookie it leaves (15 minutes) opens
nothing but the test page and the LiveKit relay, for a private room of its
own. The page runs the test; the phone and the terminal both show the result,
and the rows join the checklist as a *Phone test* group; a failed one carries its fix.

Doctor waits up to 10 minutes for the phone. Press `s` (Ctrl+C in the plain
output) to stop waiting, and `p` for a new link when one expires or you
skipped. The test is skipped with `--no-phone` or `--local`, without an
interactive terminal, and when Telinha is not running (start it with
`telinha service start`).

The QR code is drawn whole or not at all: when the window is too small for it,
even with the header out of the way, the panel shows the link alone; make the
window larger to get the code.

### What each row measures

| Row | Measures |
| --- | --- |
| HTTPS | The page loaded over HTTPS, and how long it took |
| LiveKit connection | Signaling through `/livekit` on `PUBLIC_URL` |
| Sending video | Publishing a tiny test video track |
| First path | The protocol and IP the connection took, and its round trip |
| UDP / TCP | Media forced over each protocol in turn, on `MEDIA_UDP_PORT` and `MEDIA_TCP_PORT` |

### Reading a failure

| What failed | What it means |
| --- | --- |
| LiveKit connection | Telinha is not reachable at `PUBLIC_URL` from the internet: see the DNS, HTTPS certificate and router checks |
| UDP and TCP, with HTTPS and LiveKit fine | The media ports are closed: forward both |
| Only UDP | UDP is not forwarded; video still works over TCP, with more delay |
| Only TCP | TCP is not forwarded; viewers whose network blocks UDP cannot watch |
| First path to an IP that is not your public IP | LiveKit advertises the wrong address: check `LIVEKIT_NODE_IP` |

## Troubleshooting

Each problem below names the check that catches it; the
[Doctor checks](/telinha/reference/doctor-checks/) reference describes every
one.

### Nothing loads from outside

The page opens on your network but not on mobile data. Look at, in order:

- `dns`: the name must point at your public IP (`public-ip`). Right after you
  create or change a record, it can take a while to spread.
- `tls`: besides the certificate, it fetches `<PUBLIC_URL>/healthz` from the
  internet. A failure there with a valid certificate means the request does
  not reach Telinha.
- `gateway`, `cgnat` and `mappings`: the router forwards TCP 8443 (a DuckDNS
  address at home) to this machine, or the tunnel is up (`listeners`), and the
  line is not behind CGNAT. On a VPS, 443 and 80 are open in the provider's
  firewall. See [Port forwarding](/telinha/guides/port-forwarding/).
- `listeners`: Telinha and its helpers are up locally.

### Works from outside but not from your own network

Friends get in and the phone test on mobile data passes, but the address
times out from the machine running Telinha or another device on the same
network. The router does not do NAT loopback (also called hairpin NAT or NAT
reflection): it cannot send a connection to its own public address back
inside. Nothing is wrong with the install. Turn NAT loopback on if the router
has the option; otherwise devices on that network cannot join. A hosts-file
line pointing the name at the machine's local IP does not fix it: the page
loads, but LiveKit announces the public IP for the video. On a VPS this does
not happen.

### Login goes back to Discord or shows "Invalid OAuth2 redirect_uri"

Discord only sends people back to addresses registered on the app, and its
API cannot register one for you. `discord-redirect` fails and prints the
address to add: Developer Portal → your app → OAuth2 → Redirects → add
`<PUBLIC_URL>/auth/callback` → Save Changes. After changing `PUBLIC_URL`, add
the new one. Step by step: [Discord app](/telinha/start/discord/).

### "Disallowed intents"

The bot needs the Server Members and Presence intents; without them Discord
refuses its login with "disallowed intents". `discord-intents` fails. Run
`telinha setup` again (it switches them on), or turn them on in the Developer
Portal on your app's Bot page.

### The page loads but video never connects

HTTPS works, so the web side is fine; the media ports are not. The phone test
shows UDP and TCP failed. Forward TCP `MEDIA_TCP_PORT` (7881) and UDP
`MEDIA_UDP_PORT` (7882) to this machine, open them in the machine's firewall,
and on a VPS in the provider's firewall too. `mappings` shows what the router
agreed to; on Linux `listeners` prints the ufw or firewalld commands. Behind
CGNAT (`cgnat` fails) no forwarding helps: see
[CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat).

### Only UDP or only TCP fails

One of the two rules is missing or points at the wrong protocol. Only UDP
failed: video falls back to TCP, with more delay. Only TCP failed: most
people are fine, but viewers on networks that block UDP get nothing. Check the
rule for the failing one on the router, and the matching firewall rule;
`mappings` lists a port the router refused.

### Video goes to the wrong address

The phone test's First path row goes to an IP that is not your public IP.
With `LIVEKIT_NODE_IP` set, LiveKit advertises exactly that address: fix it,
or remove it on a home line so LiveKit finds the address itself (and the IP
watch follows changes, see [Dynamic IP](/telinha/guides/domains/#dynamic-ip)).

### The certificate is not issued

`tls` fails in `direct` mode. Caddy gets the certificate from Let's Encrypt by
itself; its attempts are in the log as `[caddy]` lines. The `certificate` row
says which way it goes.

**At home with DuckDNS** (the DNS challenge, `ACME_DNS=duckdns`), no port
plays a part in the certificate:

- The DuckDNS token must be right: the `dns` row asks DuckDNS whether it
  accepts the token (sending the IP the record already holds, so nothing
  changes) and fails when it does not; run `telinha setup` again to enter
  the right one. A wrong token shows up as `ddns:` errors in the log too.
- `listeners` must show Caddy on `HTTPS_PORT` (8443): another program on that
  port stops it.
- `binaries` fails when the `caddy` in use lacks the DuckDNS module (an
  upstream or distro Caddy on `PATH`): run `telinha setup` again to get
  Telinha's own build into `bin/`; the one on `PATH` is left alone.
- The first certificate usually takes 1-3 minutes: Caddy waits until public
  DNS shows the challenge record. Run `telinha doctor` again before changing
  anything.

**On a VPS** (the HTTP challenge), the name must point here (`dns`) and ports
80 and 443 must reach Caddy: open them in the provider's firewall and in ufw
or firewalld (`listeners` prints the commands).

- `listeners` says nothing listens on the HTTPS port, on a Linux user
  install: ports below 1024 need the one-time sysctl step it prints. See
  [Running as a service](/telinha/guides/service/#low-ports-on-a-vps-user-install).
- On sslip.io the shared domain can hit Let's Encrypt's weekly limit; a
  DuckDNS name or your own domain avoids it.

### "Telinha is already running"

Only one `telinha run` per home directory. A second one (a console run while
the service is up, a second double-click) leaves the first alone and exits 1:

```
Telinha is already running (pid 1234). Use: telinha service status | telinha service stop
```

To run in a console, stop the service first; otherwise use the running one.

### The Windows service does not start

`service` warns when the service is not installed, not running or not set to
start at boot. Then:

```
telinha service status
Get-Content "$env:LOCALAPPDATA\Telinha\logs\telinha.log" -Tail 50
```

`telinha service status` shows the Task Scheduler task's last result next to
its state; the log shows why `telinha run` exited. To register the service
again, run `telinha setup` again: it does it with one administrator prompt.
More in [Running as a service](/telinha/guides/service/#windows).

### Linux: reading the log

```
journalctl -u telinha -f                # system service
journalctl --user -u telinha -f         # user service
```

The log holds Telinha's lines plus its helpers', prefixed `[livekit]`,
`[caddy]` and `[cloudflared]`.

### Docker: logs and the healthcheck

```
docker logs -f telinha
docker ps
```

The container is `unhealthy` in `docker ps` while a helper (LiveKit, Caddy,
`cloudflared`) is down and waiting to restart: for example Caddy cannot bind
its port, or the tunnel token is wrong. The log says which. `telinha-update`
rolls back a release that never turns healthy. With the journald override,
`journalctl -t telinha` keeps the log across container recreation; see
[Running as a service](/telinha/guides/service/#docker).
