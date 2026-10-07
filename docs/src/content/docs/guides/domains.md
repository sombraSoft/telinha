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

The setup asks *Where will Telinha run?* first, and the options depend on
the answer. `HOSTING` in `telinha.env` records it (`home` or `vps`).

**At home** it asks *Do you have a domain on Cloudflare?* Home internet
connections usually do not let the web ports 80 and 443 in, so Telinha never
counts on them there:

| Answer | Option | `INGRESS` | Ports to forward for the pages |
| --- | --- | --- | --- |
| Yes | [Cloudflare Tunnel](#cloudflare-tunnel) | `tunnel` | none |
| No | [DuckDNS on port 8443](#duckdns-on-port-8443) | `direct` | TCP 8443 |

**On a VPS** it asks *How will people reach Telinha?* A VPS has 80 and 443 of
its own:

| Option | `INGRESS` | Good for | Inbound web ports |
| --- | --- | --- | --- |
| [Your own domain](#your-own-domain) | `direct` | You own a domain | TCP 443 and 80 |
| [DuckDNS](#duckdns) | `direct` | No domain, a free name | TCP 443 and 80 |
| [sslip.io](#sslipio) | `direct` | No domain and no account | TCP 443 and 80 |
| [Cloudflare Tunnel](#cloudflare-tunnel) | `tunnel` | A domain on Cloudflare, no open web ports | none |
| [Your own reverse proxy](#your-own-reverse-proxy) | `external` | You already run nginx, Caddy, Traefik... | your proxy's |

In `direct` mode the bundled Caddy gets a Let's Encrypt certificate for the
`PUBLIC_URL` host and proxies everything to `LISTEN`. In `tunnel` mode
`cloudflared` carries the pages and no Caddy runs. In `external` mode your
proxy does both jobs.

The video takes none of these paths. With `MEDIA=self` (the default)
browsers send media straight to LiveKit on TCP `MEDIA_TCP_PORT` (7881) and UDP
`MEDIA_UDP_PORT` (7882), so those two ports must reach the machine in every
mode, a tunnel included: see
[Which ports](/telinha/guides/port-forwarding/#which-ports). With
`MEDIA=cloud` the video goes through [LiveKit Cloud](/telinha/guides/livekit-cloud/)
instead and no media port has to reach the machine.

## At home

### Cloudflare Tunnel

The home choice when you have a domain on Cloudflare, and an option on a VPS
too. No inbound web ports: `cloudflared` opens an outgoing connection to
Cloudflare, which serves your hostname through it. The address has no port
in it, so it opens from any network, and it works on every build (Windows on
ARM included). It needs a domain whose DNS is on Cloudflare.

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
[CGNAT and double NAT](#cgnat-and-double-nat) first: with `MEDIA=cloud` the
tunnel carries the pages and LiveKit Cloud the video.

### DuckDNS on port 8443

The home choice without a domain. DuckDNS gives you a free
`<name>.duckdns.org` that follows your changing IP. On duckdns.org: sign in,
add a subdomain, and copy the token shown at the top of the page. The setup
tries the token at once and writes:

```
PUBLIC_URL=https://my-group.duckdns.org:8443
INGRESS=direct
HTTPS_PORT=8443
HTTP_PORT=0
ACME_DNS=duckdns
DDNS_PROVIDER=duckdns
DUCKDNS_DOMAIN=my-group
DUCKDNS_TOKEN='...'
```

Telinha serves HTTPS on a port of its own, 8443 unless you pick another
(1024-65535), and the address carries it. Let's Encrypt asks for proof that
you control the name; with `ACME_DNS=duckdns` Caddy gives it through the
DuckDNS API, by setting a TXT record with your token (the DNS challenge), so
no connection from Let's Encrypt has to reach your network and nothing
listens on 80 or 443. The router forwards only TCP 8443, next to the media
ports, and UPnP can do that.

Links carry the port, like `https://my-group.duckdns.org:8443/r/...`. Some
strict networks (offices, schools) only let browsers reach port 443, so people
there cannot open them; a domain on Cloudflare
([Cloudflare Tunnel](#cloudflare-tunnel)) has no such limit.

The first certificate usually takes 1-3 minutes: Caddy sets the record, waits
until public DNS shows it, then Let's Encrypt checks it. In the log the Caddy
lines start with `[caddy]`; look for `trying to solve challenge` with
`dns-01`, then `certificate obtained successfully`. The token never shows up
there: Caddy gets it through its environment, the rendered `Caddyfile` holds
only a placeholder for it, and Telinha blanks it out of Caddy's output. The certificate needs
the Caddy that Telinha downloads or bundles, which has the DuckDNS module;
`telinha doctor` checks that (the `binaries` row) and shows the method in the
`certificate` row.

Telinha also keeps the name pointed at your network. It updates the record at
start, then looks up the public IP every 5 minutes and updates the record when
the IP changed or the last update failed, at least once a day, and right away
when the [IP watch](#dynamic-ip) sees a change. The log shows
`ddns: my-group.duckdns.org -> 203.0.113.9`.

`DUCKDNS_DOMAIN` is the subdomain alone (`a-z`, `0-9`, `-`); a pasted
`.duckdns.org` is stripped with a warning. With `ACME_DNS=duckdns` the
`PUBLIC_URL` host must be under `duckdns.org`: DuckDNS can only set records
for its own names.

## On a VPS

A VPS has its own public IP and nothing in front of it but the provider's
firewall, so with the first three options below Caddy gets the certificate
the usual way, over ports 80 and 443, which you open in that firewall. The
[Cloudflare Tunnel](#cloudflare-tunnel) works on a VPS exactly as at home.
With the first three options on 443, Telinha can also serve
[TURN over TLS on port 443](/telinha/guides/turn/) on `turn.<host>`, for
viewers on networks that only let 443 through: on by itself with DuckDNS and
sslip.io, one DNS record and `TURN=on` with your own domain.

### Your own domain

Create an A record for a name you own pointing at the public IPv4 of the
server. In plain steps: in the DNS settings of the company you bought the
domain from, add a record of type `A`, name `telinha` (giving
`telinha.yourdomain.com`), value the server's public IP (the setup and
`telinha doctor` show it). Changes can take a few minutes to reach everyone.
Then:

```
PUBLIC_URL=https://telinha.example.com
INGRESS=direct
```

Caddy gets the certificate by itself once TCP 80 and 443 reach the server.
`ACME_EMAIL` optionally gives Let's Encrypt an address for expiry notices.
The setup and `telinha doctor` (the `dns` check) compare the record with the
public IP and tell you when they differ.

### DuckDNS

A free name instead of a domain, on 443 like your own domain, with no port in
the address:

```
PUBLIC_URL=https://my-group.duckdns.org
DDNS_PROVIDER=duckdns
DUCKDNS_DOMAIN=my-group
DUCKDNS_TOKEN='...'
```

Telinha keeps the record pointed at the server as described in
[DuckDNS on port 8443](#duckdns-on-port-8443). With `LIVEKIT_NODE_IP` set it
sends that IP instead of looking one up.

### sslip.io

No domain and a fixed public IPv4:
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

### Your own reverse proxy

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

## Advanced: ports 80 and 443 at home

The setup's home question has a third answer, *Advanced*, for two cases it
never picks on its own: you opened ports 80 and 443 on your router to this
machine yourself, or you run your own reverse proxy. With the first, Telinha
writes the VPS values (`HTTP_PORT=80`, `HTTPS_PORT=443`, no `ACME_DNS`) for
your own domain or DuckDNS and gets the certificate over those ports, but it
never asks the router for them: keep them forwarded yourself. A
non-interactive `telinha setup` at home needs `--advanced` to write either
setup, and `telinha doctor` reports it in the `certificate` row as a note,
not a warning.

If the router translates instead (public 443 to another port on the
machine), set that port as `HTTPS_PORT` and keep `PUBLIC_URL` without it. A
`PUBLIC_URL` port that differs from `HTTPS_PORT` is only a warning:
`config: PUBLIC_URL port 443 differs from HTTPS_PORT 8443; assuming the router translates 443 -> 8443`.
With `HTTP_PORT=0` Let's Encrypt then validates over TLS on public 443 (the
TLS-ALPN challenge). A `PUBLIC_URL` on a port other than 443 without
`ACME_DNS=duckdns` is refused when `HTTP_PORT=0`, because Let's Encrypt only
ever connects to public 80 or 443.

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

A Cloudflare Tunnel gets the pages through CGNAT, but not the media ports;
LiveKit Cloud can carry the media instead. The options:

- Ask the ISP for a public IPv4. It is often a free opt-out of CGNAT; ask for
  a "public IP" or for "removing CGNAT".
- Keep the host where it is and set `MEDIA=cloud`: a
  [LiveKit Cloud](/telinha/guides/livekit-cloud/) project carries the video
  and needs no open port, and a Cloudflare Tunnel carries the pages. The free
  Build plan allows 5,000 participant-minutes and 50 GB downstream a month,
  with up to 100 participants connected at once, as a hard cap.
- Run Telinha on a small [VPS](/telinha/start/vps/), which has a public IP
  and no router.

## Dynamic IP

LiveKit learns its public IP once, at start (STUN), and hands it to browsers.
On a residential line the IP watch keeps that right: it asks
`https://1.1.1.1/cdn-cgi/trace` (then `https://api.ipify.org`) for the public
IP every `IP_WATCH_SECONDS` (300; `0` turns it off), and when the IP changes it
renews the router mappings, nudges DuckDNS and restarts LiveKit (with
`MEDIA=cloud` there is no local LiveKit to restart, and the line ends in
`nothing to restart`):

```
public IP 203.0.113.9 -> 198.51.100.7, restarting livekit
```

A LiveKit restart only blips open rooms: the page gets a new token and rejoins
once, and whoever was sharing has to share again. The DNS name has to follow
the new IP as well, which is what DuckDNS or your provider's dynamic DNS does.

With a static public IP, set `LIVEKIT_NODE_IP` to it instead: LiveKit skips
STUN and the IP watch is off.
