// Test adapters for the room session (web/src/lib/room.svelte.ts): a LiveKit
// room that emits events when told to, fixed token answers, a clock moved by
// hand, prefs in memory, a screen picker (navigator.mediaDevices) that hands
// out fake tracks, and Chrome's breakout box for the crop to multiples of 8.
// restoreGlobals puts back the browser globals these replace.
import { type LocalTrackPublication, type RoomEventCallbacks, Track, type TrackPublication } from 'livekit-client';
import type {
  Clock,
  LiveRoom,
  RoomLocalParticipant,
  RoomParticipant,
  SharePrefs,
  TokenResponse,
  TokenSource,
} from '../src/lib/room.svelte';
import { DEFAULT_SHARE, type ShareSettings } from '../src/lib/share';

/** Lets pending promise chains run (none of them wait on the manual clock). */
export const settle = () => new Promise((r) => setTimeout(r, 0));

export class ManualClock implements Clock {
  #now = 0;
  #seq = 0;
  #timers: { id: number; at: number; every: number | null; fn: () => void }[] = [];
  #frames: (() => void)[] = [];

  now() {
    return this.#now;
  }
  every(ms: number, fn: () => void) {
    this.#timers.push({ id: ++this.#seq, at: this.#now + ms, every: ms, fn });
  }
  after(ms: number, fn: () => void) {
    const id = ++this.#seq;
    this.#timers.push({ id, at: this.#now + ms, every: null, fn });
    return () => {
      this.#timers = this.#timers.filter((t) => t.id !== id);
    };
  }
  frame(fn: () => void) {
    this.#frames.push(fn);
  }

  /** One paint: runs what waited for the next frame. */
  paint() {
    const frames = this.#frames;
    this.#frames = [];
    for (const fn of frames) fn();
  }

  /** Moves time on, running each timer that falls due on the way (a paint and a settle after each). */
  async advance(ms: number) {
    const end = this.#now + ms;
    for (;;) {
      const next = this.#timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.#now = next.at;
      if (next.every === null) this.#timers = this.#timers.filter((t) => t !== next);
      else next.at += next.every;
      next.fn();
      await settle();
      this.paint();
    }
    this.#now = end;
  }
}

export class MemoryPrefs implements SharePrefs {
  share: ShareSettings = DEFAULT_SHARE;
  setShare(v: ShareSettings) {
    this.share = v;
  }
}

export function tokenFor(identity: string, name = 'Ana'): TokenResponse {
  const id = identity.split(':')[0]!;
  return {
    url: 'wss://livekit.test',
    token: `token-${identity}`,
    identity,
    user: { id, name, avatar: null, locale: 'en' },
    group: 'Gurizada',
  };
}

export class FixedTokens implements TokenSource {
  link = 'https://telinha.test/r/lamo-futi';
  logins = 0;
  requests: string[] = [];
  /** Answers in order; the last one repeats. */
  answers: { status: number; token?: TokenResponse }[];

  constructor(
    public room: string | null,
    ...answers: { status: number; token?: TokenResponse }[]
  ) {
    this.answers = answers;
  }
  async request(room: string) {
    this.requests.push(room);
    return (this.answers.length > 1 ? this.answers.shift() : this.answers[0]) ?? { status: 500 };
  }
  login() {
    this.logins++;
  }
}

/** What the session does to tracks and senders, in order. */
export type Log = string[];

export class FakeMediaTrack {
  contentHint = '';
  stopped = false;
  #ended: (() => void)[] = [];
  constructor(
    public kind: 'video' | 'audio',
    private size: { width: number; height: number } = { width: 0, height: 0 },
    private log: Log = [],
  ) {}
  getSettings(): { width?: number; height?: number } {
    return this.kind === 'video' ? { ...this.size } : {};
  }
  async applyConstraints(c: MediaTrackConstraints) {
    this.log.push(`constraints ${(c.height as { max: number }).max}p${(c.frameRate as { max: number }).max}`);
  }
  addEventListener(type: string, fn: () => void) {
    if (type === 'ended') this.#ended.push(fn);
  }
  stop() {
    this.stopped = true;
  }
  /** The browser's own Stop sharing bar. */
  end() {
    this.stopped = true;
    for (const fn of this.#ended) fn();
  }
}

/** A live sender: setParameters can be held open to see what waits for it. */
export class FakeSender {
  encodings: RTCRtpEncodingParameters[] = [
    { rid: 'q', scaleResolutionDownBy: 4, maxFramerate: 15, maxBitrate: 700_000 },
    { rid: 'h', scaleResolutionDownBy: 2, maxFramerate: 30, maxBitrate: 3_000_000 },
    { rid: 'f', scaleResolutionDownBy: 1, maxFramerate: 60, maxBitrate: 12_000_000 },
  ];
  hold: Promise<void> | null = null;
  constructor(private log: Log) {}
  getParameters() {
    return { encodings: this.encodings.map((e) => ({ ...e })) };
  }
  async setParameters(p: { encodings: RTCRtpEncodingParameters[] }) {
    this.log.push('setParameters start');
    await this.hold;
    this.encodings = p.encodings;
    this.log.push('setParameters done');
  }
}

/** Stats a published or subscribed video reports: one video RTP stream. */
export function videoStats(out: boolean, height: number, fps: number, codec = 'H264'): Map<string, unknown> {
  const rtp = out
    ? {
        id: 'rtp',
        type: 'outbound-rtp',
        kind: 'video',
        frameHeight: height,
        frameWidth: (height * 16) / 9,
        framesPerSecond: fps,
        codecId: 'c',
        bytesSent: 0,
      }
    : {
        id: 'rtp',
        type: 'inbound-rtp',
        kind: 'video',
        frameHeight: height,
        frameWidth: (height * 16) / 9,
        framesPerSecond: fps,
        codecId: 'c',
        bytesReceived: 0,
      };
  return new Map<string, unknown>([
    ['rtp', rtp],
    ['c', { id: 'c', type: 'codec', mimeType: `video/${codec}` }],
  ]);
}

/** The LocalVideoTrack / RemoteVideoTrack parts the session and its share touch. */
export class FakeVideoTrack {
  publishOptions: { degradationPreference?: RTCDegradationPreference } & Record<string, unknown>;
  stats: Map<string, unknown> | undefined = undefined;
  sender: FakeSender;
  constructor(
    public mediaStreamTrack: FakeMediaTrack,
    options: Record<string, unknown>,
    private log: Log,
  ) {
    this.publishOptions = { ...options };
    this.sender = new FakeSender(log);
  }
  async setDegradationPreference(p: RTCDegradationPreference) {
    this.log.push(`degradation ${p}`);
  }
  async getRTCStatsReport() {
    return this.stats;
  }
}

type Pub = { source: Track.Source; videoTrack?: FakeVideoTrack; audioTrack?: { mediaStreamTrack: FakeMediaTrack } };

export class FakeParticipant implements RoomParticipant {
  attributes: Record<string, string> = {};
  metadata: string | undefined;
  joinedAt: Date;
  pubs = new Map<Track.Source, Pub>();
  constructor(
    public identity: string,
    public name: string,
    joinedAt = 0,
  ) {
    this.metadata = JSON.stringify({ id: identity.split(':')[0] });
    this.joinedAt = new Date(joinedAt);
  }
  getTrackPublication(source: Track.Source) {
    return this.pubs.get(source) as unknown as TrackPublication | undefined;
  }
  /** A remote participant starts streaming (as subscribed by this page). */
  stream(height = 1080, fps = 60): FakeVideoTrack {
    const video = new FakeVideoTrack(new FakeMediaTrack('video'), {}, []);
    video.stats = videoStats(false, height, fps);
    this.pubs.set(Track.Source.ScreenShare, { source: Track.Source.ScreenShare, videoTrack: video });
    return video;
  }
}

export class FakeLocalParticipant extends FakeParticipant implements RoomLocalParticipant {
  /** Every setAttributes call, in order. */
  attributeWrites: Record<string, string>[] = [];
  /** Sources whose publishTrack throws. */
  failing = new Set<Track.Source>();
  constructor(
    identity: string,
    name: string,
    private log: Log,
  ) {
    super(identity, name);
  }
  async setAttributes(attrs: Record<string, string>) {
    this.attributeWrites.push(attrs);
    Object.assign(this.attributes, attrs);
  }
  async publishTrack(track: unknown, options?: { source?: Track.Source } & Record<string, unknown>) {
    const source = options?.source ?? Track.Source.Unknown;
    if (this.failing.has(source)) throw new Error(`${source} refused`);
    const t = track as FakeMediaTrack;
    const pub: Pub =
      t.kind === 'video'
        ? { source, videoTrack: new FakeVideoTrack(t, options ?? {}, this.log) }
        : { source, audioTrack: { mediaStreamTrack: t } };
    this.pubs.set(source, pub);
    return pub as unknown as LocalTrackPublication;
  }
  async unpublishTrack(track: unknown) {
    for (const [source, pub] of this.pubs) {
      const tracks = [
        pub.videoTrack,
        pub.audioTrack,
        pub.videoTrack?.mediaStreamTrack,
        pub.audioTrack?.mediaStreamTrack,
      ];
      if (tracks.includes(track as never)) {
        this.pubs.delete(source);
        return pub as unknown as LocalTrackPublication;
      }
    }
    return undefined;
  }
  /** What the room has from this page, by source. */
  published(): Track.Source[] {
    return [...this.pubs.keys()];
  }
  /** The published screen. */
  get screen(): FakeVideoTrack | undefined {
    return this.pubs.get(Track.Source.ScreenShare)?.videoTrack;
  }
}

type Listener = (...args: never[]) => void;

export class FakeRoom implements LiveRoom {
  remoteParticipants = new Map<string, FakeParticipant>();
  canPlaybackAudio = true;
  connects: { url: string; token: string }[] = [];
  log: Log = [];
  localParticipant: FakeLocalParticipant;
  #listeners = new Map<string, Listener[]>();

  constructor(identity = '100:a', name = 'Ana') {
    this.localParticipant = new FakeLocalParticipant(identity, name, this.log);
  }
  on<E extends keyof RoomEventCallbacks>(event: E, listener: RoomEventCallbacks[E]) {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener as Listener]);
    return this;
  }
  emit<E extends keyof RoomEventCallbacks>(event: E, ...args: Parameters<RoomEventCallbacks[E]>) {
    for (const fn of this.#listeners.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  async connect(url: string, token: string) {
    this.connects.push({ url, token });
  }
  async startAudio() {}
}

/** Puts back the browser globals the fakes below replaced. */
const restores: (() => void)[] = [];

function replaceGlobal(target: object, key: string, value: unknown) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  restores.push(() => {
    if (before) Object.defineProperty(target, key, before);
    else delete (target as Record<string, unknown>)[key];
  });
}

/** Undoes every fakeScreen and fakeBreakoutBox, latest first (for afterEach). */
export function restoreGlobals() {
  while (restores.length) restores.pop()!();
}

type DisplayOptions = DisplayMediaStreamOptions & Record<string, unknown>;

/**
 * The browser's screen picker: each pick gives a fresh capture of this size,
 * with sound when `audio` is on and the page asked for it. Returns the
 * captures handed out, each with the options the picker was opened with.
 */
export function fakeScreen(size = { width: 1920, height: 1080 }, audio = true, log: Log = []) {
  const picks: { options: DisplayOptions; video: FakeMediaTrack; audio: FakeMediaTrack | null }[] = [];
  const getDisplayMedia = async (options: DisplayOptions) => {
    const pick = {
      options,
      video: new FakeMediaTrack('video', size, log),
      audio: audio && options.audio ? new FakeMediaTrack('audio') : null,
    };
    picks.push(pick);
    const tracks = pick.audio ? [pick.video, pick.audio] : [pick.video];
    return {
      getVideoTracks: () => [pick.video],
      getAudioTracks: () => (pick.audio ? [pick.audio] : []),
      getTracks: () => tracks,
    };
  };
  replaceGlobal(globalThis.navigator, 'mediaDevices', { getDisplayMedia });
  return picks;
}

type Rect = { x: number; y: number; width: number; height: number };

/** The VideoFrame parts the crop touches: its visible rect and display size. */
export class FakeVideoFrame {
  visibleRect: Rect;
  displayWidth: number;
  displayHeight: number;
  closed = false;
  constructor(_src: FakeVideoFrame | null, init: { visibleRect: Rect; displayWidth: number; displayHeight: number }) {
    this.visibleRect = init.visibleRect;
    this.displayWidth = init.displayWidth;
    this.displayHeight = init.displayHeight;
  }
  close() {
    this.closed = true;
  }
}

/**
 * Chrome's breakout box (MediaStreamTrackProcessor, MediaStreamTrackGenerator
 * and VideoFrame): the processor reads one frame of its capture's size, and
 * the generator reports the size of the last frame written to it, none until
 * one went through. Returns the frames the generators got.
 */
export function fakeBreakoutBox() {
  const written: FakeVideoFrame[] = [];
  class Processor {
    readable: ReadableStream<FakeVideoFrame>;
    constructor({ track }: { track: FakeMediaTrack }) {
      const { width = 0, height = 0 } = track.getSettings();
      const frame = new FakeVideoFrame(null, {
        visibleRect: { x: 0, y: 0, width, height },
        displayWidth: width,
        displayHeight: height,
      });
      this.readable = new ReadableStream({ start: (ctl) => ctl.enqueue(frame) });
    }
  }
  class Generator extends FakeMediaTrack {
    writable: WritableStream<FakeVideoFrame>;
    constructor(_init: { kind: 'video' }) {
      const size = { width: 0, height: 0 };
      super('video', size);
      this.writable = new WritableStream({
        write(frame) {
          written.push(frame);
          Object.assign(size, { width: frame.displayWidth, height: frame.displayHeight });
        },
      });
    }
  }
  replaceGlobal(globalThis, 'MediaStreamTrackProcessor', Processor);
  replaceGlobal(globalThis, 'MediaStreamTrackGenerator', Generator);
  replaceGlobal(globalThis, 'VideoFrame', FakeVideoFrame);
  return written;
}
