---
title: TURN over TLS on port 443
description: How a VPS install relays video through turn.<host> on port 443 for viewers on networks that only allow 443, and how to turn it on, check it and turn it off.
sidebar:
  order: 9
---

Some networks only let browsers reach TCP port 443: offices, schools, some
mobile carriers and public Wi-Fi. There the room page opens (it is HTTPS on
443) but the video never connects, because WebRTC wants UDP `MEDIA_UDP_PORT`
or TCP `MEDIA_TCP_PORT`. TURN is WebRTC's standard way around that: the
browser sends its media through a relay server instead, here over a TLS
connection to `turn.<host>:443`, which to the network looks like any HTTPS
site. LiveKit has a TURN server built in, and on a VPS Telinha puts it behind
the same port 443 as the pages.

Browsers only relay when a direct path fails, so for everyone else nothing
changes.

## Who gets it

TURN over TLS runs on a VPS in direct mode on port 443:

- `MEDIA=self` (with `MEDIA=cloud`, [LiveKit Cloud](/telinha/guides/livekit-cloud/)
  brings its own TURN);
- `INGRESS=direct`, because Caddy has to own port 443;
- a VPS: `HOSTING` other than `home`;
- `HTTPS_PORT=443` and a `PUBLIC_URL` without a port, because LiveKit always
  tells browsers `turn.<host>:443`;
- a DNS name in `PUBLIC_URL`, not an IP address.

Home installs get no TURN: home connections do not let port 443 in. For
viewers on strict networks with Telinha at home, use
[LiveKit Cloud](/telinha/guides/livekit-cloud/).

`TURN=on` where one of these does not hold stops the start with the reason,
for example:

```
TURN=on is not possible here: it needs INGRESS=direct (Caddy must own port 443). TURN over TLS on 443 is for a VPS in direct mode on port 443.
```

The other reasons it gives are `MEDIA=cloud brings LiveKit Cloud's own TURN`,
`home installs get no TURN: home connections do not let port 443 in`,
`it needs HTTPS on port 443 (HTTPS_PORT=443 and a PUBLIC_URL without a port)`
and `it needs a DNS name in PUBLIC_URL (turn.<host> must resolve)`.

## How it works

```
browser --> turn.<host>:443   TLS, the name (SNI) says turn.<host>
  --> caddy :443, layer4: matches the name, terminates TLS with its turn.<host> certificate
  --> PROXY protocol v2 header + plain TCP
  --> LiveKit TURN 127.0.0.1:5349 (TURN_PORT)  --> relay --> LiveKit SFU, same machine

any other name on :443 --> caddy's HTTPS sites, as always
```

- Caddy's listener on 443 reads the name each new connection asks for (SNI)
  before anything else. A connection for `turn.<host>` is taken aside by the
  layer4 module of Telinha's Caddy build; every other one carries on to the
  pages.
- Caddy terminates TLS for it with the certificate it keeps for `turn.<host>`,
  obtained and renewed the same way as the main address's.
- Caddy hands the decrypted stream, plain TCP, to LiveKit's TURN server on
  `TURN_PORT` (5349), which runs without TLS of its own (LiveKit's
  `external_tls`).
- Because Caddy connects from the same machine, LiveKit would see every
  viewer as `127.0.0.1`. So Caddy puts a PROXY protocol header carrying the
  phone's real address in front of the stream, and LiveKit's TURN reads it:
  it then tells the browser its real address rather than the VPS's loopback,
  which some browsers (Firefox, for one) reject.
- LiveKit lists `turns:turn.<host>:443?transport=tcp` among the servers it
  gives every browser. A browser tries the direct UDP and TCP paths first and
  falls back to the relay when they fail.

## DNS

`turn.<host>` must resolve to the VPS, the same IP as `PUBLIC_URL`'s host:

- **DuckDNS**: nothing to do. DuckDNS answers for every name below yours, so
  `turn.my-group.duckdns.org` already resolves to the same IP as
  `my-group.duckdns.org`.
- **sslip.io**: nothing to do. `turn.203-0-113-9.sslip.io` resolves to
  `203.0.113.9`, like the address itself.
- **Your own domain**: add an A record. With
  `PUBLIC_URL=https://telinha.example.com`, add a record of type `A`, name
  `turn.telinha` (giving `turn.telinha.example.com`), value the VPS's public
  IPv4, in the same DNS settings as the first record.

## Turning it on

`TURN=auto`, the default, turns it on only for a VPS install (`HOSTING=vps`,
which the setup writes) with a DuckDNS or sslip.io name, where `turn.<host>`
resolves with no work on your side. There it is simply on.

With your own domain, or a `telinha.env` without `HOSTING` (written by hand,
or a Docker install given its keys with `-e`), it stays off: Caddy would
otherwise keep asking Let's Encrypt for a certificate for a name that does not
exist yet. Create the DNS record first, then set:

```
TURN=on
```

in `telinha.env` and restart (`telinha service restart`), or run
`telinha setup` and answer yes to *Also serve video through port 443 for
strict networks?* in its Video step (it shows the record to create and checks
that it resolves), or `telinha setup --non-interactive --turn on`. On a VPS with your own domain the
`turn` row of `telinha doctor` reminds you of both steps, with the record to
create.

Once on, Telinha's start line in the log ends with `turn=turn.<host>`.
`TURN_PORT` (5349) is the local port between Caddy and LiveKit; change it only
when something else on the machine uses 5349.

## Firewall

Nothing new to open: TURN arrives on 443, which is already open for the pages.

`TURN_PORT` is listening on every interface (LiveKit binds its TURN and its
relay to the same addresses), but LiveKit only accepts connections on it that
come from Caddy on the same machine, with the PROXY header, and closes every
other one at once. Keep it closed in the provider's firewall and in ufw or
firewalld anyway, together with UDP 30000-40000, the range of relay sockets
LiveKit's TURN uses to reach LiveKit's own SFU on the machine. Nothing from
outside needs either.

## Check it

```
telinha doctor
```

The **TURN over TLS** row (`turn`) checks the parts:

1. `turn.<host>` resolves to the public IP (or `LIVEKIT_NODE_IP`);
2. `turn.<host>:443` presents a valid certificate;
3. LiveKit's TURN is listening on `127.0.0.1:<TURN_PORT>`.

When all three pass it says so, and that whether a phone can relay is what the
phone test shows. Step 3 only opens and closes a connection, so LiveKit may log
one rejected connection per doctor run. The **Local listeners** row shows the
same local port as `TURN (TURN_PORT)`.

The relay itself is proven by the **phone test**: with TURN on it gains a last
step, *TURN over TLS on 443* on the phone and **TURN/TLS 443** in the
terminal, that forces the connection through `turn.<host>:443` and checks that
the media was relayed over TLS. A failure there is a warning, not a failure of
the whole test (direct paths may work fine); look at the `turn` row for the
DNS record and the certificate. See
[Doctor and troubleshooting](/telinha/guides/doctor/#the-phone-test).

## Turning it off

Set `TURN=off` in `telinha.env` and restart, or answer no to the TURN
question of `telinha setup`, or run `telinha setup --non-interactive --turn off`. Caddy then stops taking
`turn.<host>` aside and LiveKit stops offering the relay; viewers on strict
networks lose the video, everyone else notices nothing.
