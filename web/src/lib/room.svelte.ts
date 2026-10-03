// The room: token fetch, LiveKit connection, a plain snapshot of who is here
// and streaming (rebuilt on every room event), sharing, stats and notices.
// Components read the snapshot; LiveKit objects are never made reactive.
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type Participant,
  type RemoteAudioTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
} from 'livekit-client';
import { avatarUrl, discordIdOf, parseMeta } from './avatar';
import { setUserLocale, t } from './i18n/i18n.svelte';
import type { Locale, MessageKey, Params } from './i18n';
import { prefs } from './prefs.svelte';
import { isValidRoom } from './room-name';
import { applyLive, startShare, stopShare, type Share, type ShareSettings } from './share';
import { streamLabel, summarize, type ByteSample, type VideoStats } from './stats';

export type TokenUser = { id: string; name: string; avatar: string | null; locale: Locale };
type TokenResponse = { url: string; token: string; identity: string; user: TokenUser; group: string };

export type Stream = {
  video: LocalVideoTrack | RemoteVideoTrack;
  /** remote only: where the viewer's quality pick goes */
  pub: RemoteTrackPublication | null;
  /** remote only: the game audio, once subscribed */
  audio: RemoteAudioTrack | null;
};

export type Peer = {
  identity: string;
  /** Discord id (the identity is "<discord id>:<tab>") */
  id: string;
  name: string;
  avatar: string;
  local: boolean;
  /** identities of the streams this peer has on screen */
  watching: string[];
  stream: Stream | null;
};

/** A message key (re-localized when the language changes) or literal text. */
export type Notice = { key: MessageKey; params?: Params } | { text: string };
export type Fatal = { notice: Notice; reload: boolean };

const ROOM_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ParticipantMetadataChanged,
  RoomEvent.ParticipantNameChanged,
] as const;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function noticeText(n: Notice): string {
  return 'text' in n ? n.text : t(n.key, n.params);
}

function peerOf(p: Participant, local: boolean): Peer {
  const meta = parseMeta(p.metadata);
  const id = meta.id || discordIdOf(p.identity);
  const video = p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
  const apub = p.getTrackPublication(Track.Source.ScreenShareAudio);
  return {
    identity: p.identity,
    id,
    name: p.name || p.identity,
    avatar: avatarUrl(id, meta.avatar),
    local,
    watching: (p.attributes?.watching || '').split(',').filter(Boolean),
    stream: video
      ? {
          video,
          pub: local ? null : (p.getTrackPublication(Track.Source.ScreenShare) as RemoteTrackPublication),
          audio: local ? null : ((apub?.audioTrack as RemoteAudioTrack | undefined) ?? null),
        }
      : null,
  };
}

export class RoomController {
  roomName = $state('');
  group = $state('');
  user = $state.raw<TokenUser | null>(null);
  connected = $state(false);
  peers = $state.raw<Peer[]>([]);
  focusId = $state<string | null>(null);
  canPlaybackAudio = $state(true);
  share = $state.raw<Share | null>(null);
  busy = $state(false);
  /** A live quality change is being applied. */
  applying = $state(false);
  stats = $state.raw<Record<string, VideoStats>>({});
  toast = $state.raw<(Notice & { id: number }) | null>(null);
  fatal = $state.raw<Fatal | null>(null);

  streamers = $derived(this.peers.filter((p) => p.stream));
  me = $derived(this.peers.find((p) => p.local) ?? null);

  #room: Room | null = null;
  #pending = false;
  #lastWatching: string | null = null;
  /** Last "stream" attribute sent (quality for the /telinha card) and when; null = that send failed. */
  #lastStream: string | null = '';
  #lastStreamAt = 0;
  /** When the page last rejoined after an unexpected disconnect. */
  #rejoinedAt = 0;
  #prevBytes = new Map<string, ByteSample>();
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #toastId = 0;
  /** The last live quality change; the next one waits for it. */
  #applying: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    try {
      await this.#start();
    } catch (e) {
      console.error(e);
      this.#fail({ key: 'fatal.error', params: { error: messageOf(e) } }, true);
    }
  }

  async #start() {
    // Rooms only come from /telinha now; there is nothing to join without one.
    const name = new URLSearchParams(location.search).get('room');
    if (!isValidRoom(name)) return this.#fail({ key: 'notice.noRoom' }, false);
    this.roomName = name;

    const tok = await this.#token();
    if (!tok) return;
    const { url, token, user, group } = tok;
    this.user = user;
    this.group = group;
    setUserLocale(user.locale);

    const room = new Room({ adaptiveStream: true, dynacast: true });
    this.#room = room;
    for (const ev of ROOM_EVENTS) room.on(ev, () => this.refresh());
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => (this.canPlaybackAudio = room.canPlaybackAudio));
    room.on(RoomEvent.Reconnecting, () => this.notify({ key: 'conn.reconnecting' }, 10000));
    room.on(RoomEvent.Reconnected, () => this.notify({ key: 'conn.reconnected' }));
    room.on(RoomEvent.Disconnected, (reason) => void this.#disconnected(room, reason));

    await room.connect(url, token);
    this.connected = true;
    this.canPlaybackAudio = room.canPlaybackAudio;
    this.refresh();
    setInterval(() => void this.#updateStats(), 1000);
  }

  /** A token for this room, or null when the page already shows why not (or went to log in). */
  async #token(): Promise<TokenResponse | null> {
    const r = await fetch(`/auth/token?room=${encodeURIComponent(this.roomName)}`);
    if (r.status === 401) {
      location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return null;
    }
    if (r.ok) return (await r.json()) as TokenResponse;
    if (r.status === 403) this.#fail({ key: 'fatal.members' }, false);
    else if (r.status === 404) this.#fail({ key: 'notice.unknown' }, false);
    else if (r.status === 410) this.#fail({ key: 'notice.closed' }, false);
    else this.#fail({ key: 'fatal.join' }, true);
    return null;
  }

  async #disconnected(room: Room, reason?: DisconnectReason) {
    // The server deletes a room when it closes it.
    if (reason === DisconnectReason.ROOM_DELETED) return this.#fail({ key: 'notice.closed' }, false);
    // A LiveKit restart forgets every room, and with auto_create off the SDK's
    // own reconnect is refused. A fresh token makes the server bring the room
    // back (or says it has closed). Once a minute at most, so it can't loop.
    if (reason === DisconnectReason.CLIENT_INITIATED || Date.now() - this.#rejoinedAt < 60_000) {
      return this.#fail({ key: 'fatal.disconnected' }, true);
    }
    this.#rejoinedAt = Date.now();
    this.connected = false;
    const s = this.share;
    if (s) {
      this.share = null;
      await stopShare(room.localParticipant, s);
    }
    this.notify({ key: 'conn.reconnecting' }, 10000);
    try {
      const tok = await this.#token();
      if (!tok) return;
      await room.connect(tok.url, tok.token);
    } catch (e) {
      console.error(e);
      return this.#fail({ key: 'fatal.disconnected' }, true);
    }
    // A new participant: its attributes start empty.
    this.#lastWatching = null;
    this.#lastStream = '';
    this.connected = true;
    this.notify({ key: s ? 'conn.rejoinedShare' : 'conn.reconnected' }, s ? 6000 : 3000);
    this.refresh();
  }

  #fail(notice: Notice, reload: boolean) {
    this.fatal = { notice, reload };
  }

  notify(notice: Notice, ms = 3000) {
    this.toast = { ...notice, id: ++this.#toastId };
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => (this.toast = null), ms);
  }

  /** Rebuild the snapshot once per frame, however many events fired. */
  refresh() {
    if (this.#pending) return;
    this.#pending = true;
    requestAnimationFrame(() => {
      this.#pending = false;
      this.#render();
    });
  }

  #render() {
    const room = this.#room;
    if (!room) return;
    const lp = room.localParticipant;
    const peers = [peerOf(lp, true), ...[...room.remoteParticipants.values()].map((p) => peerOf(p, false))];
    if (this.focusId && !peers.some((p) => p.stream && p.identity === this.focusId)) this.focusId = null;
    this.peers = peers;
    this.#publishWatching();
  }

  setFocus(identity: string | null) {
    this.focusId = identity;
    this.#publishWatching();
  }

  toggleFocus(identity: string) {
    this.setFocus(this.focusId === identity ? null : identity);
  }

  /** The stream keyboard shortcuts act on: the focused one, else the only one. */
  target(remoteOnly: boolean): Peer | null {
    const list = remoteOnly ? this.streamers.filter((p) => !p.local) : this.streamers;
    const focused = list.find((p) => p.identity === this.focusId);
    if (focused) return focused;
    return !this.focusId && list.length === 1 ? (list[0] ?? null) : null;
  }

  // Tell the room which streams this viewer has on screen (for the 👁 lists).
  #publishWatching() {
    const room = this.#room;
    if (!room || !this.connected) return;
    const me = room.localParticipant.identity;
    const visible = this.focusId ? [this.focusId] : this.streamers.map((p) => p.identity);
    const value = visible.filter((id) => id !== me).sort().join(',');
    if (value === this.#lastWatching) return;
    this.#lastWatching = value;
    room.localParticipant.setAttributes({ watching: value }).catch(() => (this.#lastWatching = null));
  }

  /** Starts with the given settings (saved for next time), else the saved ones. */
  async startShare(settings?: ShareSettings) {
    const room = this.#room;
    if (!room || this.busy || this.share) return;
    if (settings) prefs.setShare(settings);
    this.busy = true;
    try {
      const out = await startShare(room.localParticipant, prefs.share, () => void this.stopShare());
      if (out.kind === 'cancelled') return;
      if (out.kind === 'error') {
        const key = out.stage === 'capture' ? 'share.captureFailed' : 'share.publishFailed';
        this.notify({ key, params: { error: out.message } }, 6000);
        return;
      }
      this.share = out.share;
      // Only when sound was asked for: then it was missed in the picker.
      if (!out.share.audio && prefs.share.audio) this.notify({ key: 'share.noSoundTip' }, 7000);
    } finally {
      this.busy = false;
      this.refresh();
    }
  }

  async stopShare() {
    const room = this.#room;
    const s = this.share;
    if (!room || !s) return;
    this.share = null;
    await stopShare(room.localParticipant, s);
    this.#publishStream('', true);
    this.refresh();
  }

  /** Saves the settings and applies them to the live share, one apply at a time. */
  async setShareSettings(settings: ShareSettings) {
    prefs.setShare(settings);
    // Two applies at once would fight over the same sender's parameters.
    const run = this.#applying.then(() => this.#applyLive(settings));
    this.#applying = run;
    this.applying = true;
    await run;
    if (this.#applying === run) this.applying = false;
  }

  async #applyLive(settings: ShareSettings) {
    const s = this.share;
    if (!s) return;
    try {
      await applyLive(s, settings);
      if (this.share !== s) return;
      this.notify({ key: 'share.applied', params: { res: `${settings.res}p`, fps: settings.fps } });
    } catch (e) {
      // Stopped mid-apply: the stopped track failing is no news.
      if (this.share !== s) return;
      this.notify({ key: 'share.applyFailed', params: { error: messageOf(e) } }, 5000);
    }
  }

  startAudio() {
    void this.#room?.startAudio();
  }

  async copyLink() {
    try {
      await navigator.clipboard.writeText(location.href);
      this.notify({ key: 'top.linkCopied' });
    } catch {
      this.notify({ text: location.href }, 6000);
    }
  }

  // Always running: the quality badge and the people list need it even with 📊 off.
  async #updateStats() {
    const next: Record<string, VideoStats> = {};
    for (const p of this.streamers) {
      const report = await p.stream?.video.getRTCStatsReport().catch(() => undefined);
      if (!report) continue;
      const r = summarize(report, this.#prevBytes.get(p.identity));
      if (!r) continue;
      this.#prevBytes.set(p.identity, r.sample);
      next[p.identity] = r.stats;
    }
    const live = new Set(this.streamers.map((p) => p.identity));
    for (const id of this.#prevBytes.keys()) if (!live.has(id)) this.#prevBytes.delete(id);
    this.stats = next;
    const me = this.me;
    if (this.share && me) this.#publishStream(streamLabel(next[me.identity]));
  }

  // Tell the server what this stream looks like (for the /telinha card): only
  // on change, at most every 5 s. setAttributes only touches the given key,
  // so "watching" is left alone.
  #publishStream(value: string, now = false) {
    const room = this.#room;
    if (!room || !this.connected || value === this.#lastStream) return;
    if (!now && Date.now() - this.#lastStreamAt < 5000) return;
    this.#lastStream = value;
    this.#lastStreamAt = Date.now();
    room.localParticipant.setAttributes({ stream: value }).catch(() => (this.#lastStream = null));
  }
}
