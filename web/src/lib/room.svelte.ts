// The room session: token, LiveKit connection, a plain snapshot of who is here
// and streaming (rebuilt once per frame, however many room events fired), the
// local share, stats and notices. It takes what it talks to (the LiveKit room,
// the token source, the clock, the saved share settings); App passes the
// browser's, tests pass fakes. Components read the snapshot; LiveKit objects
// are never made reactive.
import {
  DisconnectReason,
  type Participant as LiveKitParticipant,
  type LocalParticipant,
  type LocalVideoTrack,
  type RemoteAudioTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  Room,
  RoomEvent,
  type RoomEventCallbacks,
  Track,
} from 'livekit-client';
import { avatarUrl, discordIdOf, parseMeta } from './avatar';
import { commandName, type Locale, type MessageKey, type Params } from './i18n';
import { setUserLocale, t } from './i18n/i18n.svelte';
import { LocalShare, type Publisher } from './local-share.svelte';
import { isValidRoom } from './room-name';
import type { ShareSettings } from './share';
import { type ByteSample, streamLabel, summarize, type VideoStats } from './stats';

export type TokenUser = { id: string; name: string; avatar: string | null; locale: Locale };
export type TokenResponse = { url: string; token: string; identity: string; user: TokenUser; group: string };

export type Stream = {
  video: LocalVideoTrack | RemoteVideoTrack;
  /** remote only: where the viewer's quality pick goes */
  pub: RemoteTrackPublication | null;
  /** remote only: the game audio, once subscribed */
  audio: RemoteAudioTrack | null;
};

/** One tab in the room (a LiveKit identity); a person can be several. */
export type Participant = {
  identity: string;
  /** The person's Discord id (the identity is "<discord id>:<tab>") */
  id: string;
  name: string;
  /** The name on the tile: "Ana", and "Ana (2)", "Ana (3)"... for the same person's other streams. */
  label: string;
  avatar: string;
  local: boolean;
  /** identities of the tiles this participant has on screen */
  watching: string[];
  stream: Stream | null;
};

/** A message key (re-localized when the language changes) or literal text. */
export type Notice = { key: MessageKey; params?: Params } | { text: string };
export type Fatal = { notice: Notice; reload: boolean };

/** What the session reads of a LiveKit participant. */
export type RoomParticipant = Pick<
  LiveKitParticipant,
  'identity' | 'name' | 'metadata' | 'attributes' | 'joinedAt' | 'getTrackPublication'
>;
/** ...and what it does with the page's own. */
export type RoomLocalParticipant = RoomParticipant & Publisher & Pick<LocalParticipant, 'setAttributes'>;

/** The part of a LiveKit Room the session uses: livekit-client's, or a fake in tests. */
export interface LiveRoom {
  readonly localParticipant: RoomLocalParticipant;
  readonly remoteParticipants: ReadonlyMap<string, RoomParticipant>;
  readonly canPlaybackAudio: boolean;
  on<E extends keyof RoomEventCallbacks>(event: E, listener: RoomEventCallbacks[E]): unknown;
  connect(url: string, token: string): Promise<void>;
  startAudio(): Promise<void>;
}

/** Where the room name and the LiveKit tokens come from: the page URL and the server, or fixed answers in tests. */
export interface TokenSource {
  /** The room this page is for; null when it names none. */
  readonly room: string | null;
  /** This page's link, for Copy link. */
  readonly link: string;
  /** The server's HTTP status, with the token when it gave one. */
  request(room: string): Promise<{ status: number; token?: TokenResponse }>;
  /** Off to the Discord login, which comes back to this page. */
  login(): void;
}

/** Time and timers: the browser's, or one a test moves by hand. */
export interface Clock {
  now(): number;
  every(ms: number, fn: () => void): void;
  /** Returns the cancel. */
  after(ms: number, fn: () => void): () => void;
  /** Before the next paint. */
  frame(fn: () => void): void;
}

/** The saved share settings: the page's prefs, or a plain object in tests. */
export interface SharePrefs {
  readonly share: ShareSettings;
  setShare(v: ShareSettings): void;
}

export type RoomDeps = { room: () => LiveRoom; tokens: TokenSource; clock: Clock; prefs: SharePrefs };

/** The page's LiveKit room. */
export const livekitRoom = (): LiveRoom => new Room({ adaptiveStream: true, dynacast: true });

export const browserClock: Clock = {
  now: () => Date.now(),
  every: (ms, fn) => void setInterval(fn, ms),
  after: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
  frame: (fn) => void requestAnimationFrame(fn),
};

/** Rooms only come from the slash command: the URL is /r/<room>. Tokens come from the server. */
export function serverTokens(): TokenSource {
  return {
    get room() {
      return /^\/r\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;
    },
    get link() {
      return location.href;
    },
    async request(room) {
      const r = await fetch(`/auth/token?room=${encodeURIComponent(room)}`);
      return r.ok ? { status: r.status, token: (await r.json()) as TokenResponse } : { status: r.status };
    },
    login() {
      location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    },
  };
}

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

// The notices that tell people to open a room name the configured command.
const CMD = { cmd: commandName };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function noticeText(n: Notice): string {
  return 'text' in n ? n.text : t(n.key, n.params);
}

function participantOf(p: RoomParticipant, local: boolean): Participant {
  const meta = parseMeta(p.metadata);
  const id = meta.id || discordIdOf(p.identity);
  const name = p.name || p.identity;
  const video = p.getTrackPublication(Track.Source.ScreenShare)?.videoTrack;
  const apub = p.getTrackPublication(Track.Source.ScreenShareAudio);
  return {
    identity: p.identity,
    id,
    name,
    label: name,
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

/**
 * A person streaming from several tabs gets "Ana", "Ana (2)", "Ana (3)"... in
 * the order the tabs joined, so every page numbers them the same way.
 */
function labelTiles(list: { p: Participant; joined: number }[]): Participant[] {
  const streaming = list
    .filter((x) => x.p.stream)
    .sort((a, b) => a.joined - b.joined || (a.p.identity < b.p.identity ? -1 : 1));
  const count = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const { p } of streaming) {
    const n = (count.get(p.id) ?? 0) + 1;
    count.set(p.id, n);
    if (n > 1) labels.set(p.identity, `${p.name} (${n})`);
  }
  return list.map(({ p }) => {
    const label = labels.get(p.identity);
    return label ? { ...p, label } : p;
  });
}

export class RoomSession {
  roomName = $state('');
  group = $state('');
  user = $state.raw<TokenUser | null>(null);
  connected = $state(false);
  /** Everyone in the room, one entry per tab; this page's own first. */
  participants = $state.raw<Participant[]>([]);
  focusId = $state<string | null>(null);
  canPlaybackAudio = $state(true);
  stats = $state.raw<Record<string, VideoStats>>({});
  toast = $state.raw<(Notice & { id: number }) | null>(null);
  fatal = $state.raw<Fatal | null>(null);

  /** The participants sharing a screen, one tile each. */
  tiles = $derived(this.participants.filter((p) => p.stream));
  me = $derived(this.participants.find((p) => p.local) ?? null);

  #deps: RoomDeps;
  #local: LocalShare;
  #room: LiveRoom | null = null;
  #pending = false;
  #lastWatching: string | null = null;
  /** Last "stream" attribute sent (quality for the room's card) and when; null = that send failed. */
  #lastStream: string | null = '';
  #lastStreamAt = -Infinity;
  /** When the page last rejoined after an unexpected disconnect. */
  #rejoinedAt = -Infinity;
  #prevBytes = new Map<string, ByteSample>();
  #cancelToast: (() => void) | undefined;
  #toastId = 0;

  constructor(deps: RoomDeps) {
    this.#deps = deps;
    this.#local = new LocalShare(deps.clock, (notice, ms) => this.notify(notice, ms));
  }

  /** The live share; null while not sharing. */
  get share() {
    return this.#local.share;
  }
  /** Going live: the picker is open or the tracks are being published. */
  get busy() {
    return this.#local.busy;
  }
  /** A live quality change is being applied. */
  get applying() {
    return this.#local.applying;
  }
  /** Sound is picked in the browser's picker, so it can't change once live. */
  get canChangeAudio() {
    return !this.#local.share;
  }
  /** The settings the next share starts with (or the live one runs with). */
  get shareSettings() {
    return this.#deps.prefs.share;
  }

  async start(): Promise<void> {
    try {
      await this.#start();
    } catch (e) {
      console.error(e);
      this.#fail({ key: 'fatal.error', params: { error: messageOf(e) } }, true);
    }
  }

  async #start() {
    // Rooms only come from the slash command; there is nothing to join without one.
    const name = this.#deps.tokens.room;
    if (!isValidRoom(name)) return this.#fail({ key: 'notice.noRoom', params: CMD }, false);
    this.roomName = name;

    const tok = await this.#token();
    if (!tok) return;
    const { url, token, user, group } = tok;
    this.user = user;
    this.group = group;
    setUserLocale(user.locale);

    const room = this.#deps.room();
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
    this.#deps.clock.every(1000, () => void this.#updateStats());
  }

  /** A token for this room, or null when the page already shows why not (or went to log in). */
  async #token(): Promise<TokenResponse | null> {
    const { status, token } = await this.#deps.tokens.request(this.roomName);
    if (status === 401) {
      this.#deps.tokens.login();
      return null;
    }
    if (token) return token;
    if (status === 403) this.#fail({ key: 'fatal.members' }, false);
    else if (status === 404) this.#fail({ key: 'notice.unknown', params: CMD }, false);
    else if (status === 410) this.#fail({ key: 'notice.closed', params: CMD }, false);
    else this.#fail({ key: 'fatal.join' }, true);
    return null;
  }

  async #disconnected(room: LiveRoom, reason?: DisconnectReason) {
    // The server deletes a room when it closes it.
    if (reason === DisconnectReason.ROOM_DELETED) return this.#fail({ key: 'notice.closed', params: CMD }, false);
    // A LiveKit restart forgets every room, and with auto_create off the SDK's
    // own reconnect is refused. A fresh token makes the server bring the room
    // back (or says it has closed). Once a minute at most, so it can't loop.
    const now = this.#deps.clock.now();
    if (reason === DisconnectReason.CLIENT_INITIATED || now - this.#rejoinedAt < 60_000) {
      return this.#fail({ key: 'fatal.disconnected' }, true);
    }
    this.#rejoinedAt = now;
    this.connected = false;
    // The new participant starts without tracks: the share ends here.
    const dropped = await this.#local.stop(room.localParticipant);
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
    this.notify({ key: dropped ? 'conn.rejoinedShare' : 'conn.reconnected' }, dropped ? 6000 : 3000);
    this.refresh();
  }

  #fail(notice: Notice, reload: boolean) {
    this.fatal = { notice, reload };
  }

  notify(notice: Notice, ms = 3000) {
    this.toast = { ...notice, id: ++this.#toastId };
    this.#cancelToast?.();
    this.#cancelToast = this.#deps.clock.after(ms, () => (this.toast = null));
  }

  /** Rebuild the snapshot once per frame, however many events fired. */
  refresh() {
    if (this.#pending) return;
    this.#pending = true;
    this.#deps.clock.frame(() => {
      this.#pending = false;
      this.#render();
    });
  }

  #render() {
    const room = this.#room;
    if (!room) return;
    const joined = (p: RoomParticipant) => p.joinedAt?.getTime() ?? 0;
    const lp = room.localParticipant;
    const participants = labelTiles([
      { p: participantOf(lp, true), joined: joined(lp) },
      ...[...room.remoteParticipants.values()].map((p) => ({ p: participantOf(p, false), joined: joined(p) })),
    ]);
    if (this.focusId && !participants.some((p) => p.stream && p.identity === this.focusId)) this.focusId = null;
    this.participants = participants;
    this.#publishWatching();
  }

  setFocus(identity: string | null) {
    this.focusId = identity;
    this.#publishWatching();
  }

  toggleFocus(identity: string) {
    this.setFocus(this.focusId === identity ? null : identity);
  }

  /** The tile keyboard shortcuts act on: the focused one, else the only one. */
  target(remoteOnly: boolean): Participant | null {
    const list = remoteOnly ? this.tiles.filter((p) => !p.local) : this.tiles;
    const focused = list.find((p) => p.identity === this.focusId);
    if (focused) return focused;
    return !this.focusId && list.length === 1 ? (list[0] ?? null) : null;
  }

  // Tell the room which tiles this participant has on screen (for the 👁 lists).
  #publishWatching() {
    const room = this.#room;
    if (!room || !this.connected) return;
    const me = room.localParticipant.identity;
    const visible = this.focusId ? [this.focusId] : this.tiles.map((p) => p.identity);
    const value = visible
      .filter((id) => id !== me)
      .sort()
      .join(',');
    if (value === this.#lastWatching) return;
    this.#lastWatching = value;
    room.localParticipant.setAttributes({ watching: value }).catch(() => (this.#lastWatching = null));
  }

  /**
   * Saves the settings and puts them to use: goes live (the browser's picker
   * opens, so call it inside the click), or changes the live share, one change
   * at a time. A live share keeps the sound it went live with.
   */
  async useShareSettings(settings: ShareSettings) {
    const room = this.#room;
    if (!room) return;
    const prefs = this.#deps.prefs;
    if (this.#local.share) {
      const kept = { ...settings, audio: prefs.share.audio };
      prefs.setShare(kept);
      await this.#local.apply(kept);
      return;
    }
    if (this.#local.busy) return;
    prefs.setShare(settings);
    await this.#local.start(room.localParticipant, settings, () => void this.stopShare());
    this.refresh();
  }

  async stopShare() {
    const room = this.#room;
    if (!room || !(await this.#local.stop(room.localParticipant))) return;
    this.#publishStream('', true);
    this.refresh();
  }

  startAudio() {
    void this.#room?.startAudio();
  }

  async copyLink() {
    const link = this.#deps.tokens.link;
    try {
      await navigator.clipboard.writeText(link);
      this.notify({ key: 'top.linkCopied' });
    } catch {
      this.notify({ text: link }, 6000);
    }
  }

  // Always running: the quality badge and the people list need it even with 📊 off.
  async #updateStats() {
    const next: Record<string, VideoStats> = {};
    for (const p of this.tiles) {
      const report = await p.stream?.video.getRTCStatsReport().catch(() => undefined);
      if (!report) continue;
      const r = summarize(report, this.#prevBytes.get(p.identity));
      if (!r) continue;
      this.#prevBytes.set(p.identity, r.sample);
      next[p.identity] = r.stats;
    }
    const live = new Set(this.tiles.map((p) => p.identity));
    for (const id of this.#prevBytes.keys()) if (!live.has(id)) this.#prevBytes.delete(id);
    this.stats = next;
    const me = this.me;
    if (this.share && me) this.#publishStream(streamLabel(next[me.identity]));
  }

  // Tell the server what this stream looks like (for the room's card): only
  // on change, at most every 5 s. setAttributes only touches the given key,
  // so "watching" is left alone.
  #publishStream(value: string, now = false) {
    const room = this.#room;
    if (!room || !this.connected || value === this.#lastStream) return;
    const at = this.#deps.clock.now();
    if (!now && at - this.#lastStreamAt < 5000) return;
    this.#lastStream = value;
    this.#lastStreamAt = at;
    room.localParticipant.setAttributes({ stream: value }).catch(() => (this.#lastStream = null));
  }
}
