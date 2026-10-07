---
title: Tray icon
description: The Telinha icon next to the Windows clock, with what it shows, its menu, its notifications, starting it with Windows, and how to remove it.
sidebar:
  order: 6
---

On a Windows PC, Telinha puts an icon in the notification area next to the
clock. It shows whether Telinha is running, starts, stops and restarts it,
checks for and installs updates, and opens the page and the log. The icon is a
small separate program, `telinha-tray.exe`. The background task runs Telinha
with or without it, and closing the icon stops nothing.

It is one `.exe` built on the .NET Framework 4.8 that ships with Windows 10
(version 1903 or later) and Windows 11, so there is nothing else to install.
The same file runs on x64 and ARM PCs.

## Installing it

`telinha setup` installs the icon on a native Windows install. Its *Tray
icon* step asks *Show a Telinha icon next to the clock?* (yes by default) and,
after a yes, *Start the icon when you sign in to Windows?* (no by default; see
[Start with Windows](#start-with-windows)). On a re-run both start from what
the PC has now. The install then copies
`telinha-tray.exe` from the downloaded zip into `%LOCALAPPDATA%\Telinha\bin`,
next to `telinha.exe`, and starts it right after the service step, printing
`Tray icon started (next to the clock).` Windows may put a new icon in the
overflow behind the `^` arrow; drag it next to the clock to keep it in view.

Run the setup from a normal terminal, not *Run as administrator*. The icon
never runs elevated: everything its menu runs would run elevated too, and an
elevated icon could not be closed from a normal terminal. From an
administrator terminal the setup still copies the file but does not start the
icon, and prints
`Running as administrator: the tray icon was not started; run telinha tray start from a normal terminal.`
On a PC with UAC turned off, or signed in as the built-in Administrator,
there is no normal terminal: everything runs at the same level there, so the
icon starts anyway.

## What it shows

The icon carries a coloured dot:

| Dot | Meaning |
| --- | --- |
| Green | Telinha is running. |
| Amber | A newer stable release is available. |
| Red | A helper program or Telinha itself keeps restarting, the last update failed, or what you just clicked in the menu failed. |
| Grey | Not running, not answering, or starting. |

The tooltip and the first line of the menu say the same in words:
`Telinha 0.7.0: running, 2 room(s)`, `Telinha: not running`,
`Telinha: not answering` or `Telinha: starting…`.

*Starting…* shows while the service loop is bringing Telinha up: after a
restart, after an update, or on a slow start that downloads new helper
programs. The icon only reports Telinha as stopped when the background task
itself is gone, or when Telinha has not come up within 5 minutes while the
task runs.

A second line appears when there is something to add: the result of what you
just clicked (`Service started.`, `Up to date.`, or an error such as
`Could not start Telinha: …`) for about 30 seconds, otherwise
details such as `livekit: restarting (3 restarts in 10 min)`,
`update to v0.7.1 staged` or `pinned to v0.7.0`.

## The menu

| Item | What it does |
| --- | --- |
| Open Telinha | Opens `PUBLIC_URL` in the browser. A double-click on the icon does the same. |
| Start | Runs `telinha service start`. |
| Stop | Runs `telinha service stop`. A console run (`telinha run`) gets a graceful stop instead. |
| Restart | Asks Telinha to exit so the service loop starts it again at once. Only offered when it runs as the service. |
| Check for updates | Looks up the newest stable release, like `telinha update --check`. |
| Update now | Installs the newest stable release (or the pinned one) now, even with rooms open, like `telinha update --now`. The label carries the tag when one is available. The service restarts to apply it. |
| Open log | Opens `logs\telinha.log` with its default app, or the `logs` folder when there is no log yet. |
| Start with Windows | Starts the icon when you sign in; see below. |
| Quit | Closes the icon. Telinha keeps running. |

Items that do not apply are greyed out: *Start* while Telinha runs, *Stop*
and the update items while it does not answer, *Open Telinha* when
`PUBLIC_URL` is not an `http` or `https` address.

## Notifications

The icon shows a Windows notification, which also lands in the notification
centre, for these and nothing else:

- **Telinha stopped.** It was running and stopped answering with the
  service loop gone, or it has not come up within 5 minutes
  (`Telinha has not come up in 5 minutes; check the log.`). Not in the two
  minutes after you click *Stop*, *Restart* or *Update now*.
- **A crash loop.** A helper program restarted 3 times within 10 minutes
  (`livekit keeps crashing; check the log.`), or Telinha itself keeps
  restarting (`Telinha keeps restarting; check the log.`).
- **A new release.** `v0.7.1 is available.`, once per release, and never
  while `UPDATE_PIN` is set.
- **An update applied.** `Updated to v0.7.1.`, once per release, for an
  update applied while the icon runs (or just before it started). An update
  from before that, say while the icon was turned off, is not announced.

What you click in the menu never shows a notification, whether it works or
not. Its result (started, stopped, restarted, `Up to date.`, an update
installed) shows in the menu's second line and the tooltip. A failure shows
there too, for example `Could not start Telinha: …` or `Stop failed: …` with
the first line of the error, and turns the dot red while it stands.
Clicking a notification does nothing.

## Start with Windows

Off by default: after a reboot the icon comes back only when this is on. Turn
it on or off with the *Start with Windows* checkbox in the menu, with
`telinha tray autostart on` (or `off`), or with the setup's second tray
question (`--tray-autostart` without the setup screens). A setup without the
screens and without the flag leaves the setting as it is. It is the `Telinha` value of your user's `Run`
key in the registry, pointing at `bin\telinha-tray.exe`.

## Starting and stopping it by hand

After *Quit*, or after a sign-in without *Start with Windows*, start the icon
again with `telinha tray start` from a normal terminal; from an administrator
terminal it refuses, with the line shown above. `telinha tray status` says
whether it runs, its version and whether it starts with Windows, and
`telinha tray stop` closes it. All the actions are in
[Command line](/telinha/reference/cli/#telinha-tray).

The `tray` check of [`telinha doctor`](/telinha/guides/doctor/) reports the
same, warns when the icon runs a different version than Telinha, and says
whether the file is [code-signed](/telinha/guides/code-signing/).

## How it talks to Telinha

Only on this computer. The icon asks Telinha through the local control
endpoint on `LISTEN`, with the token in `data\run\control.token` (the same
one the `telinha` commands use), and runs the `telinha.exe` next to it for
*Start* and *Stop*. It reads `data\run\service.pid` to know whether the
service loop is alive, and `config\telinha.env` for `LISTEN`, `PUBLIC_URL`
and `LOCALE` (its language follows the same rule as the command line). It
writes `data\run\tray.json` while it runs and its own log to
`logs\telinha-tray.log`. It opens no internet connection of its own:
*Check for updates* asks Telinha, which asks GitHub.

## Updates

The Windows zips carry `telinha-tray.exe`. When Telinha updates itself it
replaces the icon's file the same way as `telinha.exe`, but only when the
icon is installed (otherwise it refreshes the copy kept for a later setup;
see below), and a rollback puts the previous one back too. The running
icon notices its file changed and restarts itself on the new version. See
[Updates](/telinha/guides/updates/#native-binary).

## Opting out

Answering *No icon* in the setup (or `telinha setup --no-tray`) turns *Start
with Windows* off, closes the icon and renames `bin\telinha-tray.exe` to
`bin\telinha-tray.dist.exe`, printing `Tray icon not installed.` That copy never runs; it is only kept
so the icon can come back without a download. Updates leave the icon out and
keep the copy current, and so does the PowerShell installer when you run it
again. A later setup that answers yes installs the icon again from that copy
(the question then starts on *No icon*); without the setup screens the flag
states the choice on each run, like `--no-service`, so a run without
`--no-tray` installs it. Without `bin\telinha-tray.exe` the `tray` check of
`telinha doctor` reads `Tray icon not installed.`, which is not a problem.

## Uninstalling

`telinha service uninstall` also closes the icon and removes its
*Start with Windows* entry. The file goes with the Telinha folder when you
delete it.
