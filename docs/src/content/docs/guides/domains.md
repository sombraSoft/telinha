---
title: Address, HTTPS and ingress modes
description: How people reach Telinha over HTTPS, with your own domain, DuckDNS, sslip.io, a Cloudflare Tunnel or your own reverse proxy.
sidebar:
  order: 1
---

People open Telinha in a browser, and browsers only share screens on HTTPS
pages, so Telinha needs an HTTPS address. That address is `PUBLIC_URL` in
`telinha.env`, and `INGRESS` says what answers it. `telinha setup` asks which
of the options below you want and writes the keys; to change it later, run the
setup again, or edit `telinha.env` and restart. Every key is described in
[Configuration](/telinha/reference/configuration/).

## Which one

| Option | `INGRESS` | Good for | Inbound web ports |
| --- | --- | --- | --- |
| [Your own domain](#your-own-domain) | `direct` | You own a domain | TCP 443 and 80 |
| [DuckDNS](#duckdns) | `direct` | No domain, home line with a changing IP | TCP 443 and 80 |
| [sslip.io](#sslipio) | `direct` | No domain, a VPS with a fixed IP | TCP 443 and 80 |
| [Cloudflare Tunnel](#cloudflare-tunnel) | `tunnel` | Networks that cannot open 80/443; needs a domain on Cloudflare | none |
| [Your own reverse proxy](#your-own-reverse-proxy) | `external` | You already run nginx, Caddy, Traefik... | your proxy's |

In `direct` mode the bundled Caddy gets a Let's Encrypt certificate for the
`PUBLIC_URL` host and proxies everything to `LISTEN`. In `tunnel` mode
`cloudflared` carries the pages and no Caddy runs. In `external` mode your
proxy does both jobs.

The video takes none of these paths. Browsers send media straight to LiveKit
on TCP `MEDIA_TCP_PORT` (7881) and UDP `MEDIA_UDP_PORT` (7882), so those two
ports must reach the machine in every mode, a tunnel included: see
[Which ports](/telinha/guides/port-forwarding/#which-ports).

## Your own domain

Create an A record for a name you own pointing at the public IPv4 of the
network Telinha runs on. In plain steps: in the DNS settings of the company
you bought the domain from, add a record of type `A`, name `telinha` (giving
`telinha.yourdomain.com`), value your public IP (the setup and
`telinha doctor` show it). Changes can take a few minutes to reach everyone.
Then:

```
PUBLIC_URL=https://telinha.example.com
INGRESS=direct
```

Caddy gets the certificate by itself once TCP 80 and 443 reach the machine.
`ACME_EMAIL` optionally gives Let's Encrypt an address for expiry notices.
The setup and `telinha doctor` (the `dns` check) compare the record with the
public IP and tell you when they differ.

On a home line whose IP changes, use your DNS provider's dynamic DNS, or
DuckDNS below.

## DuckDNS

Free, follows a changing IP, works on any host. On duckdns.org: sign in, add a
subdomain, and copy the token shown at the top of the page.

```
PUBLIC_URL=https://my-group.duckdns.org
DDNS_PROVIDER=duckdns
DUCKDNS_DOMAIN=my-group
DUCKDNS_TOKEN='...'
```

`DUCKDNS_DOMAIN` is the subdomain alone (`a-z`, `0-9`, `-`); a pasted
`.duckdns.org` is stripped with a warning. A `PUBLIC_URL` on another host is a
warning too.

Telinha updates the record at start, then looks up the public IP every 5
minutes and updates the record when the IP changed or the last update failed,
at least once a day, and right away when the [IP watch](#dynamic-ip) sees a
change. The log shows `ddns: my-group.duckdns.org -> 203.0.113.9`; the token
is never logged. With `LIVEKIT_NODE_IP` set it sends that IP instead of
looking one up.

## sslip.io

No domain and a fixed public IPv4, which in practice means a VPS:
`https://203-0-113-9.sslip.io` resolves to `203.0.113.9` with no account and no
setup. Set the IP as `LIVEKIT_NODE_IP` too:

```
PUBLIC_URL=https://203-0-113-9.sslip.io
LIVEKIT_NODE_IP=203.0.113.9
```

The setup writes both, and offers this option only for a VPS. sslip.io is a
shared domain, and Let's Encrypt limits how many certificates it issues per
domain each week, so a certificate can be refused when too many were issued
for sslip.io recently. Your own domain or DuckDNS is more reliable.

## Cloudflare Tunnel

No inbound web ports: `cloudflared` opens an outgoing connection to
Cloudflare, which serves your hostname through it. It suits networks that
cannot forward 80/443, and it works on every build (Windows on ARM included).
It needs a domain whose DNS is on Cloudflare.

In the Cloudflare dashboard: Zero Trust → Networks → Tunnels → create a tunnel
(type cloudflared), copy its token, and give the tunnel a public hostname whose
service is `http://localhost:<LISTEN port>` (by default
`http://localhost:8081`).

```
PUBLIC_URL=https://telinha.example.com
INGRESS=tunnel
TUNNEL_TOKEN='...'
```

The media ports still need forwarding: a tunnel does not carry WebRTC. If the
reason you chose a tunnel is that nothing at all reaches your network, read
[CGNAT and double NAT](#cgnat-and-double-nat) first.

## Your own reverse proxy

`INGRESS=external`: your proxy terminates TLS and forwards to `LISTEN`
(`127.0.0.1:8081` by default; when the proxy runs on another machine, set
`LISTEN` to an address it can reach and keep that port closed to the
internet). The proxy must:

- pass WebSocket upgrades, at least for the signaling relay at `/livekit/rtc`;
- set `X-Forwarded-For` (every mainstream proxy does by default): Telinha uses
  the forwarding headers to tell a public `/healthz` request from a local one,
  and to keep its control endpoint local.

The login gate is still Telinha's. `/auth/check` stays available if your proxy
wants a `forward_auth` of its own. With Caddy as the proxy, the defaults
already do all of this:

```
telinha.example.com {
	reverse_proxy 127.0.0.1:8081
}
```

Forward the media ports as in every other mode.

## Port translation

When 443 on the machine is taken, or a Linux user install cannot bind ports
below 1024, the router can translate: public 443 goes to, say, 8443 on the
machine.

```
PUBLIC_URL=https://telinha.example.com
HTTPS_PORT=8443
HTTP_PORT=0
```

The router forwards public TCP 443 to the machine's 8443. A `PUBLIC_URL` port
that differs from `HTTPS_PORT` is only a warning:
`config: PUBLIC_URL port 443 differs from HTTPS_PORT 8443; assuming the router translates 443 -> 8443`.
With UPnP on, Telinha asks the router for exactly that translation.

`HTTP_PORT=0` turns the HTTP listener (the redirect to HTTPS) off. Let's
Encrypt can then validate over TLS on 443 (the TLS-ALPN challenge), so port 80
does not need to be open. The setup writes these values when you decline the
low-port step on a Linux user install; see
[Running as a service](/telinha/guides/service/#linux-as-a-user).

## CGNAT and double NAT

Many residential lines share one public IPv4 between customers (carrier-grade
NAT): the router's WAN address is in `100.64.0.0/10`, and nothing from the
internet reaches your network, port forwarding and UPnP included.
`telinha doctor` detects it: the `cgnat` check compares the router's external
IP, read through UPnP, NAT-PMP or PCP, with the IP the internet sees, and the
setup warns too. To test by hand, see
[Is it CGNAT?](/telinha/guides/port-forwarding/#is-it-cgnat).

A WAN address in a private range (`10.x`, `172.16.x` to `172.31.x`,
`192.168.x`) means double NAT instead: a second router sits in front of yours,
often the ISP's modem. Forward the ports on that one too, or put one of the
two in bridge mode.

A Cloudflare Tunnel gets the pages through CGNAT, but not the media ports. The
options:

- Ask the ISP for a public IPv4. It is often a free opt-out of CGNAT; ask for
  a "public IP" or for "removing CGNAT".
- Run Telinha on a small [VPS](/telinha/start/vps/), which has a public IP
  and no router.

## Dynamic IP

LiveKit learns its public IP once, at start (STUN), and hands it to browsers.
On a residential line the IP watch keeps that right: it asks
`https://1.1.1.1/cdn-cgi/trace` (then `https://api.ipify.org`) for the public
IP every `IP_WATCH_SECONDS` (300; `0` turns it off), and when the IP changes it
renews the router mappings, nudges DuckDNS and restarts LiveKit:

```
public IP 203.0.113.9 -> 198.51.100.7, restarting livekit
```

A LiveKit restart only blips open rooms: the page gets a new token and rejoins
once, and whoever was sharing has to share again. The DNS name has to follow
the new IP as well, which is what DuckDNS or your provider's dynamic DNS does.

With a static public IP, set `LIVEKIT_NODE_IP` to it instead: LiveKit skips
STUN and the IP watch is off.
