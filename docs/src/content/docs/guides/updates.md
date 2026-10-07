---
title: Updates
description: How the native binary, a Docker host and a source checkout get new Telinha releases, how to pin a version, roll back, or turn updates off.
sidebar:
  order: 4
---

How Telinha updates depends on how you installed it:

| Install | Updates through | Default |
| --- | --- | --- |
| Native binary (Windows, Linux) | Telinha itself (`AUTO_UPDATE`) | on |
| Docker host | `telinha-update`, a systemd timer | off until you enable the timer |
| A clone of the repository | `git pull` | by hand |

`AUTO_UPDATE=on` anywhere but the native binary is a warning and is ignored.

## Native binary

### How it decides

Only stable releases: the target is whatever
`https://github.com/sombraSoft/telinha/releases/latest` points at, and a
pre-release is never installed from there. With `UPDATE_PIN` set (a tag such
as `v0.7.0`), it installs exactly that tag instead, pre-releases and
downgrades included, and stays on it.

### When

The first check runs 2 minutes after Telinha starts, then every
`UPDATE_CHECK_HOURS` (6). While rooms are open the update waits, but at most
`UPDATE_MAX_DEFER_HOURS` (12; `0` means do not wait) per release, so a room
stuck open cannot block the release that fixes it. A release whose files are
not published yet, or a network failure, is retried at the next check.

### How

Telinha downloads the archive for this machine (`telinha-<target>.tar.gz` or
`.zip`) and the release's `SHA256SUMS`, and installs nothing unless the sha256
matches. The running executable is renamed to `telinha.old-<version>` and the
new one takes its place; the service loop starts it at once. When the new
release pins newer helper programs, that first start downloads them and logs
`binaries updated: livekit` (or whichever changed). With `INGRESS=direct` it
also fetches the Caddy build of the new release, verified against that
release's `SHA256SUMS`, since every release ships its own.

On Windows the zip also carries the [tray icon](/telinha/guides/tray/),
`telinha-tray.exe`. When the icon is installed it is replaced the same way
(the old file kept as `telinha-tray.old-<version>.exe`), and the running icon
notices the new file and restarts itself on it. An icon you opted out of with
`telinha setup --no-tray` stays out: the update installs it only where
`bin\telinha-tray.exe` already exists. Otherwise it only refreshes the copy
kept as `bin\telinha-tray.dist.exe`, from which a later `telinha setup`
installs the icon.

Run in a console, Telinha installs the update but does not restart itself; it
logs "update to vX installed; restart telinha to apply it". The service loop
executable itself is replaced at the next `telinha service restart` or reboot.

### Rollback

When the new version fails to start twice in a row, the service loop puts the
previous executable back, keeps the new one as `telinha.failed-<tag>`, and
records the tag as failed in `data/run/update.json`. That tag is skipped until
a newer release exists; `telinha update --now` tries it again.

### Commands

```
telinha update --check     # current version, newest stable (or the pin), staged / failed / pending
telinha update             # with the service running: check and install now unless rooms are open
telinha update --now       # install even with rooms open; also retries a failed tag
```

With the service stopped, `telinha update` installs right away and the next
start uses it. On a Linux root install the service user owns `bin/`, so the
service updates itself: start it (`sudo telinha service start`) before
running `sudo telinha update`. The `update` check of
[`telinha doctor`](/telinha/guides/doctor/) shows a newer release, or an
update that is staged, failed or pending.

### Pinning

Add `UPDATE_PIN=v0.7.0` to `telinha.env` and restart Telinha
(`telinha service restart`). Delete the line to follow stable releases again.

### Turning it off

`AUTO_UPDATE=off` stops the periodic check. `telinha update` still works when
you run it.

## Docker host

### How it decides

`telinha-update` deploys the tag in `/opt/telinha/pin` when there is one, else
GitHub's newest stable release (which excludes pre-releases). The release
must carry `telinha-image.digest`, the image digest it was published with; a
release without it is not complete yet and is retried at the next run.

### When

The timer runs `telinha-update` 3 minutes after boot and then every 5 minutes.
It is opt-in: `sh install-docker.sh --auto-update` enables it once
`telinha.env` is filled in, or enable it yourself:

```
systemctl enable --now telinha-update.timer
```

While rooms are open (`/healthz` on the `LISTEN` port reports `rooms` above
0) a deploy waits, but at most `MAX_DEFER_HOURS` (12) per target. `--now`
skips the wait. When `/healthz` does not answer, nothing is running to
protect, so it does not wait.

### How

It pulls `ghcr.io/sombrasoft/telinha:<version>` and the same image by the
published digest, and refuses to deploy (removing the pulled tag) when the two
are not the same image. Then it runs
`docker compose up -d --remove-orphans --wait --wait-timeout 180` in
`/opt/telinha`, and only after the healthcheck passes does it record the
version and digest in `/opt/telinha/.env` and remove the previous image.

`/opt/telinha/compose.yml` is never touched. It changes only when you re-run
`install-docker.sh` from a newer `telinha-deploy.tar.gz` (or clone); do that
when a release's notes mention a compose change.

### Rollback

When the new version never turns healthy, `telinha-update` goes back to the
previous one (`.env` still names it and its image is still there) and records
the tag in `/opt/telinha/failed`, which `telinha-update status` shows. The
timer skips that tag until a newer release comes out, so the host does not
bounce between versions every 5 minutes; `--now`, `pin` and `unpin` try it
again. A first deploy has nothing to go back to: fix `telinha.env`, then run
`telinha-update --now`.

### Commands

```
telinha-update                  # deploy the pinned tag, else the newest stable release
telinha-update --now            # same, but do not wait for open rooms
telinha-update status           # pin, deployed version + digest, newest stable, deferral
journalctl -t telinha-update    # what the timer did
```

Every subcommand needs root (`/opt/telinha` is mode 700). Without
`telinha-update`, by hand:

```
cd /opt/telinha && docker compose pull && docker compose up -d
```

That follows `latest`, or the `TELINHA_VERSION` in `/opt/telinha/.env`.

### Pinning

```
telinha-update pin v0.6.0       # hold at a tag (pre-releases like v0.7.0-rc.1 too), deploy now
telinha-update unpin            # follow the newest stable release again, deploy now
```

`pin` checks that the release exists first. Both take a trailing `--now` to
skip the wait for open rooms.

### Turning it off

Do not enable the timer, or disable it:

```
systemctl disable --now telinha-update.timer
```

Settings for `telinha-update` go in a drop-in
(`systemctl edit telinha-update.service`, which `install-docker.sh` never
overwrites) as `Environment=` lines, or in the shell for a run by hand:

| Variable | Default | Effect |
| --- | --- | --- |
| `TELINHA_DIR` | `/opt/telinha` | Where compose and the state live |
| `MAX_DEFER_HOURS` | `12` | Longest wait for open rooms per target |
| `VERIFY_ATTESTATION` | unset | `1`: also check the image's GitHub attestation with `gh attestation verify`; needs `gh` installed and logged in (`GH_TOKEN` in the drop-in, or `gh auth login` as root), else the deploy is refused |
| `ALLOW_UNVERIFIED` | unset | `1`: skip the published-digest check (an escape hatch, logged loudly) |

## From source

### How it decides

You do: Telinha runs whatever you have checked out.

### When

Whenever you pull.

### How

```
git pull
mise install
bun run build
```

Then restart `bun server/src/index.ts`. Nothing is downloaded at start from
source; when a release pins newer helper programs, the `binaries` check of
`bun server/src/index.ts doctor` says so and prints the command that fetches
them.

### Rollback

Check out the previous release tag (`git checkout v0.6.0`), then install,
build and restart as above. Tags up to v0.7.0 have no `mise.toml`: run
`bun install --frozen-lockfile` there instead of `mise install`.

### Commands

`git pull`, `git checkout <tag>`, and the build commands above.

### Pinning

Stay on a tag: `git checkout v0.6.0`.

### Turning it off

Nothing updates by itself; there is nothing to turn off.

## Verifying a release by hand

Every release carries `SHA256SUMS` and a GitHub build provenance attestation
covering the four archives, `telinha-deploy.tar.gz`, `telinha-image.digest`
and `SHA256SUMS`. With the files downloaded into one folder:

```
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify telinha-linux-x64.tar.gz --repo sombraSoft/telinha
gh attestation verify telinha-windows-x64.zip --repo sombraSoft/telinha
```

On Windows without `sha256sum`, run `Get-FileHash telinha-windows-x64.zip` in
PowerShell and compare the hash with the archive's line in `SHA256SUMS`. The
Docker image is attested by digest, the `sha256:...` line in
`telinha-image.digest`:

```
gh attestation verify oci://ghcr.io/sombrasoft/telinha@sha256:... --repo sombraSoft/telinha
```

The native updater checks the sha256 of every update against that release's
`SHA256SUMS`; it does not check the attestation. A signed release's Windows
programs also carry an Authenticode signature; see
[Code signing](/telinha/guides/code-signing/).
