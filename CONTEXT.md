# Telinha

A self-hosted screen-sharing app for a Discord server: one install runs the web page, the Discord bot and the helpers that carry media and web traffic.

## Language

### Rooms

**Room**:
One screen-sharing space opened by `/telinha` (or the dev login) and closed for good once empty or ended.
_Avoid_: Telinha (for a single room; lowercase "uma telinha" is allowed only as pt-BR UI copy)

**Room code**:
The identifier of a room (e.g. `lamo-futi`), in its link and as the LiveKit room name at the LiveKit seam.
_Avoid_: Room name

**Topic**:
The free text the opener gives `/telinha` to say what the room is for.

**Empty room**:
A room with nobody in it and nobody joining (no token minted) for the close window.

**Card**:
The bot's message for a room in the channel where `/telinha` ran, edited as people come and go and once more when the room closes.
_Avoid_: Embed, status message

**Admission**:
Letting a member into a room before their token is minted: the room is open, kept from closing while they connect, and exists in LiveKit.

**Member**:
A person in the group: holds the gate role and is not a bot.
_Avoid_: Using it for Discord's notion, which is a guild member

**Person**:
A Discord user in a room, however many tabs they have open. The card counts persons.

**Participant**:
One tab connected to a room, by its LiveKit identity. Each tile on the page belongs to a participant.

**Streamer**:
A person sharing their screen. If a person streams from several participants, each extra tile is labelled apart (`Ana (2)`).

**Viewer**:
A person present in a room and not streaming.
_Avoid_: Watching (reserved for which tiles a participant has on screen)

**Session**:
The login session: the signed cookie a member gets after logging in with Discord.
_Avoid_: Using it for the phone test, the bot's gateway connection or setup state

**Gateway connection**:
The bot's live connection to Discord, over which it hears `/telinha` and the group's members coming and going.
_Avoid_: Session

### Installs

**Install**:
One Telinha folder plus its `telinha.env`, set up and run as a unit on one machine.
_Avoid_: Deployment

**Helper**:
A third-party program an install runs next to Telinha: livekit-server, caddy or cloudflared.
_Avoid_: Tool, child binary

**Child**:
The supervised process of a running helper.
_Avoid_: Using it for `telinha run` under the service loop (that is the run process)

**Media mode**:
Where the SFU runs: `self` (the bundled livekit-server helper) or `cloud` (a LiveKit Cloud project).

**Ingress mode**:
How web traffic reaches the install: `direct` (the caddy helper terminates TLS), `tunnel` (cloudflared) or `external` (the user's own proxy).

**Footprint**:
What an install puts on its machine for a given media mode, ingress mode and TURN: the helpers it runs, the ports it binds and the exposures it opens.

**Apply**:
Setup's write-and-run phase, after the questions: it writes `telinha.env` and runs the install tasks.
_Avoid_: Install (for this phase; an install is the folder and its file)

**Apply task**:
One step Apply runs and shows as a row, e.g. downloading a helper or registering the service.
_Avoid_: Step (the setup screens' sidebar steps)

### Releases

**Release tag**:
The `vX.Y.Z[-pre]` name that selects a release: what an update pin, target or rollback takes.
_Avoid_: Version (for selecting)

**Version**:
The bare `X.Y.Z[-pre]` a Telinha binary reports about itself.

**Prerelease**:
A release whose tag has a hyphen (`v0.8.0-rc.1`); never installed unless pinned. A GitHub draft is not a release.

**Target**:
The OS and CPU a Telinha binary is built for (`linux-x64`, `windows-arm64`); a release has one archive per target.
_Avoid_: Platform (Node's `win32`), amd64 (Go's name, used only for helpers)

**Aside file**:
A replaced program file renamed out of the way, never deleted (`telinha.old-<version>`, `telinha-tray.failed-<release tag>`), so a running exe never blocks an update; the updater sweeps them.

**Exposure**:
A port a helper opens to the outside, by protocol, that the firewall and the router must let in.

**Phone test**:
The doctor's check run from a phone: a one-time link and cookie that open a test page and report media connectivity from outside the network.
_Avoid_: Doctor session

**Setup state**:
What `telinha setup` holds while it asks its questions: the answers so far, the question on screen and the lookups running.
_Avoid_: Setup session
