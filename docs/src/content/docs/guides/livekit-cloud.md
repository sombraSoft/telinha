---
title: LiveKit Cloud
description: Let a LiveKit Cloud project carry the video (MEDIA=cloud) when the machine cannot take media connections, behind CGNAT or with nothing forwarded.
sidebar:
  order: 8
---

By default Telinha runs LiveKit itself (`MEDIA=self`): the SFU that
receives the shared screen and sends it to every viewer is a child of Telinha
on the same machine, and its two media ports have to reach that machine from
the internet. With `MEDIA=cloud` a [LiveKit Cloud](https://livekit.io/cloud)
project does that job instead. Telinha still serves the pages, the Discord
login and the bot; the video goes between the browsers and LiveKit's servers,
and no media port is opened anywhere.

## When to use it

- **Your line is behind CGNAT**, so nothing from the internet reaches your
  network (see [CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat)).
  With a Cloudflare Tunnel for the pages and LiveKit Cloud for the video, a
  home PC needs no forwarded port at all.
- **You cannot forward ports** on the router, or would rather not.
- **Viewers on strict networks**: LiveKit Cloud runs its own TURN servers, so
  people on networks that only allow port 443 can still watch, wherever
  Telinha runs.

The price is the free plan's monthly limits (below), and that the video goes
through a company other than you (see [Privacy](#privacy)). A home line with a
public IP and forwarded ports, or a VPS, needs neither.

The pages still need a way in: people open `PUBLIC_URL` as always. That is a
[Cloudflare Tunnel](/telinha/guides/domains/#cloudflare-tunnel) (a domain on
Cloudflare; the only home option behind CGNAT), a
[DuckDNS address on port 8443](/telinha/guides/domains/#duckdns-on-port-8443)
(TCP 8443 forwarded) or a [VPS](/telinha/start/vps/).

## Create the project

1. Sign up at [cloud.livekit.io](https://cloud.livekit.io) and create a
   project.
2. In the project's Settings → Project, copy the project URL. It looks like
   `wss://my-group-abc123.livekit.cloud` (the dashboard's code samples call it
   `LIVEKIT_URL`). It becomes `LIVEKIT_CLOUD_URL`.
3. In Settings → Keys, create an API key and copy the key and its secret. They
   become `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. Keep the secret like a
   password: whoever has it can join and run any room of the project.

### Turn automatic room creation off

In the project's settings, turn automatic room creation off. LiveKit Cloud
normally creates a room the moment someone joins one that does not exist.
Telinha does not need that: it creates every room itself when `/telinha` runs
and deletes it when it closes. With automatic creation on, someone opening a
just-closed room with a token handed out before it closed (tokens last 10
minutes) would bring back an empty room that nobody follows. Telinha refuses
new tokens for closed rooms either way, and such a room disappears by itself
once it stays empty, but with the option off it never appears. `telinha doctor`
repeats this advice on its LiveKit Cloud row.

## The free plan

LiveKit Cloud's free Build plan includes, per project:

| Allowance | Build plan |
| --- | --- |
| WebRTC participant-minutes | 5,000 a month |
| Downstream data transfer | 50 GB a month |
| Connected participants | 100 at the same time, across all rooms |

On the free plan these are a hard cap: once the minutes or the transfer are
used up, LiveKit Cloud refuses new connections until the next month, and with
100 people connected the next one is refused. Participant-minutes count every
person connected to a room, the sharer included: a two-hour session with one
sharer and four viewers uses 5 × 120 = 600 minutes, so 5,000 last about eight
such evenings. A long high-resolution share can use up the 50 GB first. The
project's dashboard on cloud.livekit.io shows the usage; the paid plans raise
the limits.

## Set it up

Run `telinha setup` and choose *LiveKit Cloud* in its Video step: it asks
the project URL, the API key and the secret (pasted into a masked field), and
skips the media ports. At home behind CGNAT the setup picks Cloud for you.

Without the setup screens, switch with the non-interactive setup. The secret
never goes on the command line: pass it as a file (`-` reads stdin) or as the
`LIVEKIT_API_SECRET` environment variable.

```
telinha setup --non-interactive --media cloud \
  --cloud-url wss://my-group-abc123.livekit.cloud \
  --livekit-key APIxxxxxxxxxxxx --livekit-secret-file - < ./livekit-secret
```

Every other answer comes from the existing `telinha.env`; on a fresh install
add the flags of a full non-interactive setup (see
[CLI](/telinha/reference/cli/)). The setup writes:

```
MEDIA=cloud
LIVEKIT_CLOUD_URL=wss://my-group-abc123.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET='...'
```

It drops `MEDIA_TCP_PORT` and `MEDIA_UDP_PORT` (nothing binds them) and the
LiveKit key pair it had generated for the local LiveKit, then restarts the
service. Missing `--cloud-url`, `--livekit-key` or the secret are listed
together and the setup exits 2.

By hand works too, and is the way for Docker: put those four lines in
`telinha.env` (single-quote the secret), remove the two media port lines, and
restart (`telinha service restart`; for Docker
`docker compose up -d --force-recreate` in `/opt/telinha`).
`LIVEKIT_CLOUD_URL` also takes the `https://` form, and a pasted path, query
or trailing slash is dropped.

## What changes when it runs

- **No LiveKit child.** `telinha run` starts only Caddy or `cloudflared` (or
  nothing with `INGRESS=external`), and its start line says `media=cloud`.
- **No media ports.** UPnP asks the router only for 8443 (DuckDNS at home),
  the Windows Firewall gets no LiveKit rules (the setup's service step, or
  `telinha service install --firewall`, rewrites them), and the doctor lists
  no media port to forward.
- **No signaling proxy at `/livekit`.** The room page receives the Cloud project's URL with
  its token and connects to LiveKit Cloud directly, for signaling and media.
- **Rooms behave the same.** Telinha creates each room through the project's
  room API, follows who is in it, and deletes it when it closes, which
  disconnects everyone. Tokens still last 10 minutes, and a link to a closed
  room is refused by Telinha before LiveKit Cloud is asked anything.
- **The IP watch** keeps renewing the router mappings and DuckDNS when the
  public IP changes; there is no LiveKit to restart.
- **Ignored keys.** `LIVEKIT_PORT`, `MEDIA_TCP_PORT`, `MEDIA_UDP_PORT`,
  `LIVEKIT_API_URL` and `LIVEKIT_PUBLIC_URL` only apply to `MEDIA=self`; set
  to anything but their default they log
  `config: LIVEKIT_PORT only applies to MEDIA=self; ignored`.
- **No TURN of Telinha's own.** `TURN=on` is refused with `MEDIA=cloud`:
  LiveKit Cloud brings its own.

## Check it

```
telinha doctor
```

- The **LiveKit Cloud** row (`livekit-cloud`) lists the project's rooms with
  your key and secret, which proves the URL and the key pair together:
  `Connected to my-group-abc123.livekit.cloud: 0 room(s) open there.` It fails
  when LiveKit Cloud rejects the key or secret (copy them again from Settings
  → Keys) or cannot be reached (check `LIVEKIT_CLOUD_URL` and the machine's
  internet access).
- The **Carrier NAT** row (`cgnat`) only warns behind CGNAT: just the pages
  need a way in.
- The **phone test** connects straight to the Cloud project. Its UDP and TCP
  rows show no port number, because the ports are LiveKit Cloud's; when both
  fail, the phone's network blocks WebRTC and there is nothing to open on your
  side.

## Privacy

With `MEDIA=cloud` the shared screen and sound pass through LiveKit's servers.
They travel encrypted, but a company other than you handles them, under
LiveKit's own terms and privacy policy. The room tokens Telinha signs also
carry each person's Discord display name, user id and avatar, as they do with
the bundled LiveKit, and the room names are the room codes. With `MEDIA=self`
none of this reaches anyone else's machine.

## Switching back

```
telinha setup --non-interactive --media self
```

The setup removes `LIVEKIT_CLOUD_URL` and the Cloud key pair, generates a new
local pair, and the next start runs LiveKit on the machine again. Forward TCP
7881 and UDP 7882 again (or let UPnP do it), and see
[Port forwarding](/telinha/guides/port-forwarding/).
