---
title: Code signing
description: Which Telinha programs are code-signed, how to check a signature on Windows, what an unsigned build looks like, and the code signing policy with its privacy statement.
sidebar:
  order: 7
---

The Windows programs of a Telinha release, `telinha.exe` and
`telinha-tray.exe`, are signed with an Authenticode signature by the release
workflow. Free code signing provided by [SignPath.io](https://signpath.io),
certificate by [SignPath Foundation](https://signpath.org).

A signature tells Windows, and you, who published the file and that nobody
changed it since. The Linux binaries are not signed; every release archive,
on both systems, is also covered by the release's `SHA256SUMS` and a GitHub
build attestation, as described in
[Verifying a release by hand](/telinha/guides/updates/#verifying-a-release-by-hand).

## Checking a signature

**In Explorer.** Right-click `telinha.exe` (in `%LOCALAPPDATA%\Telinha\bin`
once installed) → *Properties* → *Digital Signatures*. The list shows the
signer and the time it was signed; *Details* → *View Certificate* shows the
certificate. An unsigned file has no *Digital Signatures* tab. The *Details*
tab shows the product name `Telinha` and the release version.

**In PowerShell:**

```powershell
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Telinha\bin\telinha.exe" | Format-List Status, StatusMessage, SignerCertificate
```

`Valid` means signed, by the certificate shown, and unchanged since.
`NotSigned` is an unsigned build. `HashMismatch` means the file was changed
after it was signed: do not run it.

**With Telinha.** The `tray` check of
[`telinha doctor`](/telinha/guides/doctor/) adds `signed by …` or
`not code-signed` for the [tray icon](/telinha/guides/tray/)'s file.

## What an unsigned build looks like

Only builds made by the release workflow are signed. A release can also be
published unsigned, and anything you build yourself (`bun run compile`) is
unsigned. Such a build works the same, but Windows says less about it:

- A zip downloaded by hand from the releases page may be stopped by
  SmartScreen's *Windows protected your PC*. Click *More info*, check the
  file name, then *Run anyway*. (The PowerShell installer downloads the zip
  itself and checks its sha256, so this screen does not appear there.)
- The administrator (UAC) prompt of the setup shows *Publisher: Unknown*.
  *Show more details* shows the path: it should be the `telinha.exe` in
  `%LOCALAPPDATA%\Telinha\bin`.

A signed build names its publisher in both places instead. A new release can
still meet SmartScreen for a while, until Windows has seen the certificate
enough; *More info* then shows the publisher, not *Unknown publisher*.

## Code signing policy

This policy covers the Windows programs signed through the SignPath
Foundation for the [Telinha project](https://github.com/sombraSoft/telinha).

### Team roles

- **Committers:** the maintainers with write access to the repository
  ([sombraSoft](https://github.com/sombraSoft)). They may change the code
  without another review.
- **Reviewers:** every change from anyone else, such as a pull request from a
  contributor, is reviewed by a committer before it is merged.
- **Approvers:** a maintainer approves each signing request by hand before
  anything is signed.

Team members use multi-factor authentication on GitHub and on SignPath.

### What is signed

Only `telinha.exe` (the `windows-x64` and `windows-arm64` builds) and
`telinha-tray.exe`, built from Telinha's own source by the release workflow on
GitHub Actions from the release commit on `main`. Never local builds, pull
request builds or builds from a fork. Every signed file carries the product
name `Telinha` and the release version.

The helper programs Telinha downloads are not signed by this project:
`livekit-server.exe` and `cloudflared.exe` come from their own publishers'
releases as they are, and Telinha's `caddy.exe` build is not signed.

### Privacy

This program will not transfer any information to other networked systems
unless specifically requested by the user.

Telinha is a server: hosting screen-sharing rooms for your Discord server is
what you ask it to do. These are all the systems a configured Telinha talks
to for that, each with the `telinha.env` key that governs it.

**Always, while it runs:**

- **Discord** (`discord.com` and its gateway): the bot's connection and API
  calls (the slash command, the room cards, the member list with presence),
  and each participant's Discord login (OAuth2). Uses `DISCORD_TOKEN`,
  `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
- **The participants' browsers:** the pages, and the video through LiveKit,
  which runs on this machine. The pages load avatars from Discord's image
  server (`cdn.discordapp.com`), and LiveKit gives the browsers its built-in
  STUN servers (`stun.l.google.com`, `stun1.l.google.com` and
  `global.stun.twilio.com`) to find their own public address. Telinha
  configures no others.
- **LiveKit's STUN lookups:** at every start LiveKit asks the same STUN
  servers for this machine's public IP, unless `LIVEKIT_NODE_IP` is set.
- **GitHub, for the helper programs** (native installs): `livekit-server`
  from LiveKit's releases, `cloudflared` from Cloudflare's (with a tunnel) and
  `caddy` from Telinha's own release (with `INGRESS=direct`), downloaded from
  `github.com` when one is missing or a new Telinha release pins another
  version, each checked against a sha256.

**On by default, and can be turned off:**

- **Public-IP lookups** at `https://1.1.1.1/cdn-cgi/trace`, then
  `https://api.ipify.org` if that fails: every `IP_WATCH_SECONDS` (300) to
  notice a new home IP, and every 5 minutes for DuckDNS. `IP_WATCH_SECONDS=0`
  stops the watch; a static `LIVEKIT_NODE_IP` stops both.
- **Update checks on GitHub** (native installs):
  `https://github.com/sombraSoft/telinha/releases/latest` a few minutes after
  start and then every `UPDATE_CHECK_HOURS`, and the release archive and its
  `SHA256SUMS` when installing one. `telinha setup` asks; `AUTO_UPDATE=off`
  turns it off.
- **The router, on your local network,** over UPnP, NAT-PMP and PCP, to
  forward the ports Telinha needs and read its external IP. `UPNP=off` turns
  it off.

**Only when you choose it:**

- **Let's Encrypt**, with `INGRESS=direct`: Caddy gets and renews the HTTPS
  certificate from it, either over ports 80 and 443 (Let's Encrypt connects
  back to check them) or, with `ACME_DNS=duckdns`, through a DNS record that
  Caddy sets at DuckDNS and then looks up at 1.1.1.1 and 8.8.8.8. With
  `ACME_EMAIL` set and no `ACME_DNS`, ZeroSSL is the fallback when Let's
  Encrypt fails, and the address goes to both.
- **DuckDNS**, with `DDNS_PROVIDER=duckdns`: `https://www.duckdns.org/update`
  with `DUCKDNS_DOMAIN` and `DUCKDNS_TOKEN`, every 5 minutes and when the IP
  changes.
- **Cloudflare Tunnel**, with `INGRESS=tunnel`: `cloudflared` keeps outgoing
  connections to Cloudflare, which carry the pages, using `TUNNEL_TOKEN`. It
  runs with its own update check turned off.

**When you run a command.** `telinha setup`, `telinha doctor`,
`telinha update`, the installers and the tray icon's menu make some of the
same calls when you use them: the Discord API (to check the token, the
intents, the server, the role, the channels and the login redirect), the
public-IP lookups, the address's DNS record at 1.1.1.1 and 8.8.8.8, a request
to your own `PUBLIC_URL` (its certificate and `/healthz`), a DuckDNS token check, the router probe
and GitHub releases. The doctor's phone test is a page your phone opens on
your own Telinha.

Telinha collects no telemetry: no usage statistics, crash reports or
analytics go to its authors or to anyone else.
