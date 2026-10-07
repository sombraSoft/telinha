// The room session through its interface: a fake LiveKit room, fixed token
// answers, a clock moved by hand, prefs in memory and a fake screen picker.
import { afterEach, describe, expect, test } from 'bun:test';
import { DisconnectReason, RoomEvent, Track, type VideoPreset } from 'livekit-client';
import {
  FakeParticipant,
  FakeRoom,
  FixedTokens,
  ManualClock,
  MemoryPrefs,
  fakeBreakoutBox,
  fakeScreen,
  restoreGlobals,
  settle,
  tokenFor,
  videoStats,
} from '../../test/room-fakes';
import { RoomSession } from './room.svelte';
import type { ShareSettings } from './share';

const ROOM = 'lamo-futi';
const SMOOTH: ShareSettings = { res: 1080, fps: 60, preset: 'smooth', audio: true };
const READABLE: ShareSettings = { res: 1440, fps: 15, preset: 'readable', audio: true };
const CUSTOM_720: ShareSettings = { res: 720, fps: 30, preset: 'custom', audio: true };

/** A session that has joined: its first snapshot painted. */
async function joined(tokens = new FixedTokens(ROOM, { status: 200, token: tokenFor('100:a') })) {
  const room = new FakeRoom('100:a', 'Ana');
  const clock = new ManualClock();
  const prefs = new MemoryPrefs();
  const s = new RoomSession({ room: () => room, tokens, clock, prefs });
  await s.start();
  clock.paint();
  return { s, room, clock, prefs, tokens, lp: room.localParticipant };
}

afterEach(restoreGlobals);

/** Joined and streaming a screen (1080p unless told) with sound. */
async function live(settings = SMOOTH, size = { width: 1920, height: 1080 }) {
  const j = await joined();
  const picks = fakeScreen(size, true, j.room.log);
  await j.s.useShareSettings(settings);
  j.clock.paint();
  return { ...j, picks };
}

/** The published screen's simulcast layers: width, height, kbps, fps. */
function layersOf(lp: FakeRoom['localParticipant']) {
  const layers = lp.screen!.publishOptions.screenShareSimulcastLayers as VideoPreset[];
  return layers.map((p) => [p.width, p.height, p.encoding.maxBitrate, p.encoding.maxFramerate]);
}

/** Each layer's scale factor the way livekit-client derives it from the sent track's size. */
function factorsOf(lp: FakeRoom['localParticipant']) {
  const { width = 0, height = 0 } = lp.screen!.mediaStreamTrack.getSettings();
  const layers = lp.screen!.publishOptions.screenShareSimulcastLayers as VideoPreset[];
  return layers.map((p) => Math.min(width, height) / Math.min(p.width, p.height));
}

/** A remote participant joins. */
function arrive(room: FakeRoom, p: FakeParticipant) {
  room.remoteParticipants.set(p.identity, p);
  room.emit(RoomEvent.ParticipantConnected, p as never);
}

describe('joining', () => {
  test('the token answer decides the notice', async () => {
    const cases: [number, string, boolean][] = [
      [403, 'fatal.members', false],
      [404, 'notice.unknown', false],
      [410, 'notice.closed', false],
      [500, 'fatal.join', true],
    ];
    for (const [status, key, reload] of cases) {
      const { s, room } = await joined(new FixedTokens(ROOM, { status }));
      expect(s.fatal).toMatchObject({ notice: { key }, reload });
      expect(s.connected).toBe(false);
      expect(room.connects).toEqual([]);
    }
  });

  test('logged out: off to the login, no notice', async () => {
    const tokens = new FixedTokens(ROOM, { status: 401 });
    const { s } = await joined(tokens);
    expect(tokens.logins).toBe(1);
    expect(s.fatal).toBeNull();
  });

  test('a page without a room name asks for the slash command and fetches nothing', async () => {
    for (const name of [null, 'not-a-room']) {
      const tokens = new FixedTokens(name, { status: 200, token: tokenFor('100:a') });
      const { s } = await joined(tokens);
      expect(s.fatal).toMatchObject({ notice: { key: 'notice.noRoom' }, reload: false });
      expect(tokens.requests).toEqual([]);
    }
  });

  test('a good token connects with its url', async () => {
    const { s, room } = await joined();
    expect(room.connects).toEqual([{ url: 'wss://livekit.test', token: 'token-100:a' }]);
    expect(s.connected).toBe(true);
    expect(s.roomName).toBe(ROOM);
    expect(s.user?.name).toBe('Ana');
    expect(s.me?.identity).toBe('100:a');
  });
});

describe('snapshot', () => {
  test('one person streaming from two tabs: the later tab reads "Ana (2)" on every page', async () => {
    const { s, room, clock } = await joined();
    const tab2 = new FakeParticipant('100:b', 'Ana', 5);
    const tab3 = new FakeParticipant('100:c', 'Ana', 9);
    const bia = new FakeParticipant('200:x', 'Bia', 7);
    // Listed out of join order, as LiveKit may.
    for (const p of [tab3, bia, tab2]) {
      p.stream();
      arrive(room, p);
    }
    clock.paint();
    expect(s.tiles.map((p) => [p.identity, p.label])).toEqual([
      ['100:c', 'Ana (2)'],
      ['200:x', 'Bia'],
      ['100:b', 'Ana'],
    ]);
    // Persons keep their plain name.
    expect(s.tiles.map((p) => p.name)).toEqual(['Ana', 'Bia', 'Ana']);
  });

  test('several events in one frame rebuild the snapshot once', async () => {
    const { s, room, clock } = await joined();
    const bia = new FakeParticipant('200:x', 'Bia', 1);
    arrive(room, bia);
    expect(s.participants.map((p) => p.identity)).toEqual(['100:a']);
    clock.paint();
    expect(s.participants.map((p) => p.identity)).toEqual(['100:a', '200:x']);
  });
});

describe('watching attribute', () => {
  test('sent only when what is on screen changes, never naming this tab', async () => {
    const { s, room, clock, lp } = await joined();
    const bia = new FakeParticipant('200:x', 'Bia', 1);
    const caio = new FakeParticipant('300:y', 'Caio', 2);
    for (const p of [caio, bia]) {
      p.stream();
      arrive(room, p);
    }
    clock.paint();
    // More events, same tiles: nothing new to say.
    room.emit(RoomEvent.ParticipantAttributesChanged, {}, bia as never);
    clock.paint();
    s.setFocus('300:y');
    s.setFocus('300:y');
    s.setFocus(null);
    expect(lp.attributeWrites.filter((w) => 'watching' in w)).toEqual([
      { watching: '' },
      { watching: '200:x,300:y' },
      { watching: '300:y' },
      { watching: '200:x,300:y' },
    ]);
  });
});

describe('going live', () => {
  test('publishes the screen with exact /2 and /4 layers and the bitrate of its settings, then the sound', async () => {
    const { s, lp, picks } = await live(SMOOTH);
    expect(lp.published()).toEqual([Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);
    expect(s.share?.codec).toBe('h264');
    expect(s.share?.audio).not.toBeNull();
    const o = lp.screen!.publishOptions;
    expect(o.screenShareEncoding).toEqual({ maxBitrate: 12_000_000, maxFramerate: 60 });
    expect(layersOf(lp)).toEqual([
      [960, 540, 3_000_000, 30],
      [480, 270, 700_000, 15],
    ]);
    expect([o.degradationPreference, picks[0]!.video.contentHint]).toEqual(['balanced', 'motion']);
    expect(s.busy).toBe(false);
  });

  test('any window size gets exact integer layer factors', async () => {
    // 992x1080 broke H.265 in 0.1.1: a 1280x720 preset gave factor 1.378, and the HW encoder sent nothing
    for (const [width, height] of [[992, 1080], [1856, 1010], [993, 1079], [2560, 1440], [800, 600]] as const) {
      const { lp } = await live(SMOOTH, { width, height });
      expect(factorsOf(lp)).toEqual(height > 720 ? [2, 4] : [2]);
    }
  });

  test('720p and below: one half-size layer', async () => {
    const { lp } = await live(CUSTOM_720, { width: 1280, height: 720 });
    expect(layersOf(lp)).toEqual([[640, 360, 700_000, 15]]);
  });

  test('above 1080p: a richer half-size layer', async () => {
    const { lp } = await live({ res: 1440, fps: 60, preset: 'custom', audio: true }, { width: 2560, height: 1440 });
    expect(layersOf(lp)).toEqual([
      [1280, 720, 3_500_000, 30],
      [640, 360, 700_000, 15],
    ]);
  });

  test('layer fps never exceeds the capture fps', async () => {
    const { lp } = await live({ res: 1080, fps: 15, preset: 'custom', audio: true });
    expect(layersOf(lp)).toEqual([
      [960, 540, 3_000_000, 15],
      [480, 270, 700_000, 15],
    ]);
  });

  test('with the breakout box, frames are cropped to multiples of 8 and the layers come out even', async () => {
    const j = await joined();
    const written = fakeBreakoutBox();
    const picks = fakeScreen({ width: 1311, height: 1079 }, true, j.room.log);
    let done = false;
    const going = j.s.useShareSettings(SMOOTH).then(() => (done = true));
    // The size is only known once a frame went through the crop.
    for (let i = 0; i < 10 && !done; i++) await j.clock.advance(50);
    await going;
    const sent = j.lp.screen!.mediaStreamTrack;
    expect(sent).not.toBe(picks[0]!.video);
    expect(written.map((f) => [f.visibleRect, f.displayWidth, f.displayHeight])).toEqual([
      [{ x: 0, y: 0, width: 1304, height: 1072 }, 1304, 1072],
    ]);
    expect(sent.getSettings()).toEqual({ width: 1304, height: 1072 });
    expect(layersOf(j.lp).map(([w, h]) => [w, h])).toEqual([
      [652, 536],
      [326, 268],
    ]);
    expect(factorsOf(j.lp)).toEqual([2, 4]);
    // The hint goes on the sent copy; live changes still constrain the raw capture.
    expect(sent.contentHint).toBe('motion');
    j.room.log.length = 0;
    await j.s.useShareSettings(CUSTOM_720);
    expect(j.room.log[0]).toBe('constraints 720p30');
    expect(picks[0]!.video.stopped).toBe(false);
  });

  test('an already aligned capture goes through uncropped', async () => {
    const j = await joined();
    const written = fakeBreakoutBox();
    fakeScreen({ width: 1920, height: 1080 }, true, j.room.log);
    let done = false;
    const going = j.s.useShareSettings(SMOOTH).then(() => (done = true));
    for (let i = 0; i < 10 && !done; i++) await j.clock.advance(50);
    await going;
    expect(written.map((f) => [f.displayWidth, f.displayHeight])).toEqual([[1920, 1080]]);
    expect(factorsOf(j.lp)).toEqual([2, 4]);
  });

  test('sound off: only the screen is published, and the picker is not asked for sound', async () => {
    const { s, lp, picks } = await live({ ...SMOOTH, audio: false });
    expect(lp.published()).toEqual([Track.Source.ScreenShare]);
    expect(s.share?.audio).toBeNull();
    expect(picks[0]!.audio).toBeNull();
    expect(picks[0]!.options.audio).toBe(false);
    expect(picks[0]!.options).not.toHaveProperty('systemAudio');
    expect(picks[0]!.options).not.toHaveProperty('windowAudio');
    expect(s.toast).toBeNull();
  });

  test('a failed sound publish leaves nothing published and the capture stopped', async () => {
    const j = await joined();
    const picks = fakeScreen({ width: 1920, height: 1080 }, true, j.room.log);
    j.lp.failing.add(Track.Source.ScreenShareAudio);
    await j.s.useShareSettings(SMOOTH);
    expect(j.lp.published()).toEqual([]);
    expect([picks[0]!.video.stopped, picks[0]!.audio?.stopped]).toEqual([true, true]);
    expect(j.s.share).toBeNull();
    expect(j.s.busy).toBe(false);
    expect(j.s.toast).toMatchObject({ key: 'share.publishFailed' });
  });

  test('sound asked for but not picked: a tip', async () => {
    const j = await joined();
    fakeScreen({ width: 1920, height: 1080 }, false, j.room.log);
    await j.s.useShareSettings(SMOOTH);
    expect(j.lp.published()).toEqual([Track.Source.ScreenShare]);
    expect(j.s.toast).toMatchObject({ key: 'share.noSoundTip' });
  });

  test("the browser's Stop sharing ends it and clears the card's stream line at once", async () => {
    const { s, lp, picks, clock } = await live();
    lp.screen!.stats = videoStats(true, 1080, 60);
    await clock.advance(1000);
    await clock.advance(1000);
    picks[0]!.video.end();
    await settle();
    clock.paint();
    expect(s.share).toBeNull();
    expect(lp.published()).toEqual([]);
    expect(lp.attributeWrites.filter((w) => 'stream' in w)).toEqual([{ stream: '1080p60 · H264' }, { stream: '' }]);
  });
});

describe('live changes', () => {
  test('a second change waits for the first', async () => {
    const { s, room, lp } = await live();
    const sender = lp.screen!.sender;
    let release!: () => void;
    sender.hold = new Promise<void>((r) => (release = r));
    room.log.length = 0;
    const first = s.useShareSettings(CUSTOM_720);
    const second = s.useShareSettings(READABLE);
    await settle();
    expect(room.log).toEqual(['constraints 720p30', 'setParameters start']);
    expect(s.applying).toBe(true);
    sender.hold = null;
    release();
    await Promise.all([first, second]);
    expect(room.log).toEqual([
      'constraints 720p30',
      'setParameters start',
      'setParameters done',
      'degradation balanced',
      'constraints 1440p15',
      'setParameters start',
      'setParameters done',
      'degradation maintain-resolution',
    ]);
    expect(s.applying).toBe(false);
    expect(s.toast).toMatchObject({ key: 'share.applied', params: { res: '1440p', fps: 15 } });
  });

  test('the top layer gets the new budget, lower layers are capped', async () => {
    const { s, lp } = await live();
    await s.useShareSettings(CUSTOM_720);
    expect(lp.screen!.sender.encodings.map((e) => [e.rid, e.maxFramerate, e.maxBitrate])).toEqual([
      ['q', 15, 700_000],
      ['h', 30, 3_000_000],
      ['f', 30, 4_000_000],
    ]);
  });

  test('a reconnect republishes with the new degradation preference, not the one it started with', async () => {
    const { s, lp, picks } = await live(SMOOTH);
    await s.useShareSettings(READABLE);
    expect(lp.screen!.publishOptions.degradationPreference).toBe('maintain-resolution');
    expect(lp.screen!.mediaStreamTrack).toBe(picks[0]!.video);
    expect(picks[0]!.video.contentHint).toBe('detail');
  });

  test('sound stays as it went live; it can change again once stopped', async () => {
    const { s, prefs } = await live({ ...SMOOTH, audio: true });
    expect(s.canChangeAudio).toBe(false);
    await s.useShareSettings({ ...READABLE, audio: false });
    expect(prefs.share).toEqual({ ...READABLE, audio: true });
    expect(s.shareSettings.audio).toBe(true);
    await s.stopShare();
    expect(s.canChangeAudio).toBe(true);
  });
});

describe('stream attribute', () => {
  test('sent on change, at most every 5 s', async () => {
    const { lp, clock } = await live();
    const streamWrites = () => lp.attributeWrites.filter((w) => 'stream' in w).map((w) => w.stream);
    lp.screen!.stats = videoStats(true, 1080, 59);
    await clock.advance(1000);
    expect(streamWrites()).toEqual(['1080p60 · H264']);
    lp.screen!.stats = videoStats(true, 720, 30);
    await clock.advance(4000);
    expect(streamWrites()).toEqual(['1080p60 · H264']);
    await clock.advance(1000);
    expect(streamWrites()).toEqual(['1080p60 · H264', '720p30 · H264']);
  });
});

describe('connection lost', () => {
  test('rejoins with a fresh token at most once a minute, dropping the share', async () => {
    const { s, room, clock, tokens, lp } = await live();
    room.emit(RoomEvent.Disconnected, DisconnectReason.SERVER_SHUTDOWN);
    await settle();
    expect(tokens.requests).toEqual([ROOM, ROOM]);
    expect(room.connects).toHaveLength(2);
    expect(s.share).toBeNull();
    expect(lp.published()).toEqual([]);
    expect(s.connected).toBe(true);
    expect(s.toast).toMatchObject({ key: 'conn.rejoinedShare' });

    await clock.advance(61_000);
    room.emit(RoomEvent.Disconnected, DisconnectReason.SERVER_SHUTDOWN);
    await settle();
    expect(room.connects).toHaveLength(3);
    expect(s.toast).toMatchObject({ key: 'conn.reconnected' });
    expect(s.fatal).toBeNull();

    await clock.advance(59_000);
    room.emit(RoomEvent.Disconnected, DisconnectReason.SERVER_SHUTDOWN);
    await settle();
    expect(room.connects).toHaveLength(3);
    expect(s.fatal).toMatchObject({ notice: { key: 'fatal.disconnected' }, reload: true });
  });

  test('a rejoined participant sends its watching attribute again', async () => {
    const { room, lp, clock } = await joined();
    room.emit(RoomEvent.Disconnected, DisconnectReason.SERVER_SHUTDOWN);
    await settle();
    clock.paint();
    expect(lp.attributeWrites.filter((w) => 'watching' in w)).toEqual([{ watching: '' }, { watching: '' }]);
  });

  test('closed by the server, or left on purpose: no rejoin', async () => {
    for (const [reason, key] of [
      [DisconnectReason.ROOM_DELETED, 'notice.closed'],
      [DisconnectReason.CLIENT_INITIATED, 'fatal.disconnected'],
    ] as const) {
      const { s, room } = await joined();
      room.emit(RoomEvent.Disconnected, reason);
      await settle();
      expect(room.connects).toHaveLength(1);
      expect(s.fatal).toMatchObject({ notice: { key } });
    }
  });
});

describe('toasts', () => {
  test('a notice goes away after its time; a newer one restarts the wait', async () => {
    const { s, clock } = await joined();
    s.notify({ text: 'one' }, 3000);
    await clock.advance(2000);
    s.notify({ text: 'two' }, 3000);
    await clock.advance(2000);
    expect(s.toast).toMatchObject({ text: 'two' });
    await clock.advance(1000);
    expect(s.toast).toBeNull();
  });
});
