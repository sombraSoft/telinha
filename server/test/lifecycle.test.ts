import { describe, expect, test } from 'bun:test';
import { TrackSource } from 'livekit-server-sdk';
import { renderCard, type Card } from '../src/card.ts';
import { cleanQuality, createLifecycle, isPermanentEditError, presence } from '../src/lifecycle.ts';
import type { LiveParticipant, RoomService } from '../src/livekit.ts';
import { openRegistry, type NewRoom } from '../src/rooms.ts';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const NEW: NewRoom = {
  room: 'abcdefghijkl', guildId: '100', channelId: '300', locale: 'en',
  openerId: '7', openerName: 'Zé', what: null, createdAt: T0,
};

const viewer = (id: string, tab = 'aa'): LiveParticipant => ({
  identity: `${id}:${tab}`, metadata: JSON.stringify({ id, avatar: null }), attributes: {}, tracks: [],
});
const streamer = (id: string, stream?: string, tab = 'bb'): LiveParticipant => ({
  ...viewer(id, tab), attributes: stream === undefined ? {} : { stream }, tracks: [{ source: TrackSource.SCREEN_SHARE }],
});

function setup(o: { message?: boolean; gapMs?: number; closeEmptyMs?: number } = {}) {
  let clock = T0;
  const registry = openRegistry(':memory:');
  registry.create(NEW);
  if (o.message !== false) registry.setMessage(NEW.room, '300', '999');
  const present = new Map<string, LiveParticipant[]>();
  const deleted: string[] = [];
  const ensured: string[] = [];
  const edits: { at: number; channelId: string; messageId: string; card: Card }[] = [];
  const logs: unknown[][] = [];
  let editError: unknown = null;
  let listError: unknown = null;
  let deleteError: unknown = null;
  let editTries = 0;
  /** Runs while LiveKit is being asked (to interleave a token request). */
  let onList: (room: string) => void = () => {};
  const rooms: Pick<RoomService, 'listParticipants' | 'deleteRoom' | 'ensureRoom'> = {
    listParticipants: async (room) => {
      if (listError) throw listError;
      onList(room);
      return present.get(room) ?? [];
    },
    deleteRoom: async (room) => {
      if (deleteError) throw deleteError;
      deleted.push(room);
    },
    ensureRoom: async (room) => void ensured.push(room),
  };
  const newLifecycle = () => createLifecycle({
    registry,
    rooms,
    render: (rec, live) => renderCard(rec, live, { publicUrl: 'https://tela.example.com', group: 'Crew' }),
    editMessage: async (channelId, messageId, card) => {
      editTries++;
      if (editError) throw editError;
      edits.push({ at: clock, channelId, messageId, card });
    },
    now: () => clock,
    closeEmptyMs: o.closeEmptyMs ?? 5 * MIN,
    editGapMs: o.gapMs,
    log: (...a) => void logs.push(a),
  });
  let lc = newLifecycle();
  return {
    registry, present, deleted, ensured, edits, logs,
    get lc() { return lc; },
    /** A fresh process on the same database (in-memory card state lost). */
    restart: () => { lc = newLifecycle(); },
    editTries: () => editTries,
    onList: (f: (room: string) => void) => { onList = f; },
    failDeletes: (e: unknown) => { deleteError = e; },
    set: (ps: LiveParticipant[], room = NEW.room) => present.set(room, ps),
    at: (ms: number) => { clock = T0 + ms; },
    failEdits: (e: unknown) => { editError = e; },
    failList: (e: unknown) => { listError = e; },
    /** Advances the clock to `ms` and runs one tick. */
    tickAt: async (ms: number) => { clock = T0 + ms; await lc.tick(); },
  };
}

describe('presence', () => {
  test('one entry per user, streamers with quality, viewers are everyone else', () => {
    const p = presence([
      viewer('1', 'a1'), streamer('1', '1080p60 · H265', 'a2'), // streams in one tab, watches in another
      viewer('2'), viewer('2', 'zz'), streamer('3'),
      { identity: 'agent-x', metadata: '', attributes: {}, tracks: [] }, // no Discord id: ignored
    ], ['3', '2', '1']);
    expect(p.ids).toEqual(['3', '2', '1']);
    expect(p.live).toEqual({ streamers: [{ id: '3' }, { id: '1', quality: '1080p60 · H265' }], viewers: ['2'] });
  });

  test('identity wins over metadata (metadata is self-editable)', () => {
    const p = presence([{ identity: '5:ab', metadata: JSON.stringify({ id: '6' }), attributes: {}, tracks: [] }], []);
    expect(p.ids).toEqual(['5']);
    const m = presence([{ identity: 'weird', metadata: JSON.stringify({ id: '6' }), attributes: {}, tracks: [] }], []);
    expect(m.ids).toEqual(['6']);
  });

  test('cleanQuality keeps short plain labels only', () => {
    expect(cleanQuality('1080p60 · H265')).toBe('1080p60 · H265');
    expect(cleanQuality('')).toBeUndefined();
    expect(cleanQuality(undefined)).toBeUndefined();
    expect(cleanQuality('<@&123> everyone')).toBeUndefined();
    expect(cleanQuality('x'.repeat(40))).toBeUndefined();
    expect(cleanQuality('[a](https://evil)')).toBeUndefined();
  });
});

describe('closing', () => {
  test('5 min after /telinha when nobody ever joined', async () => {
    const s = setup();
    await s.tickAt(4 * MIN + 59_000);
    expect(s.registry.get(NEW.room)!.closedAt).toBeNull();
    await s.tickAt(5 * MIN);
    expect(s.registry.get(NEW.room)!.closedAt).toBe(T0 + 5 * MIN);
    expect(s.deleted).toEqual([NEW.room]);
    expect(s.edits.at(-1)!.card.content).toBe('📺 Telinha by **Zé** ended\n⏱️ Nobody joined');
    expect(s.edits.at(-1)!.card.components).toEqual([]);
  });

  test('5 min after the last person left', async () => {
    const s = setup();
    s.set([viewer('1')]);
    await s.tickAt(MIN);
    await s.tickAt(9 * MIN);
    s.set([]);
    await s.tickAt(9 * MIN + 5000);
    await s.tickAt(13 * MIN + 59_000);
    expect(s.registry.get(NEW.room)!.closedAt).toBeNull();
    await s.tickAt(14 * MIN);
    const rec = s.registry.get(NEW.room)!;
    expect(rec).toMatchObject({ closedAt: T0 + 14 * MIN, firstJoinAt: T0 + MIN, lastSeenAt: T0 + 9 * MIN, seen: ['1'] });
    expect(s.deleted).toEqual([NEW.room]);
    expect(s.edits.at(-1)!.card.content).toBe('📺 Telinha by **Zé** ended\n⏱️ Lasted 8 min\n👥 Stopped by: <@1>');
  });

  test('never while someone is in it', async () => {
    const s = setup();
    s.set([viewer('1')]);
    for (let m = 0; m <= 120; m += 1) await s.tickAt(m * MIN);
    expect(s.registry.get(NEW.room)!.closedAt).toBeNull();
    expect(s.deleted).toEqual([]);
  });

  test('a closed room is no longer polled', async () => {
    const s = setup();
    await s.tickAt(5 * MIN);
    s.set([viewer('1')]);
    await s.tickAt(6 * MIN);
    expect(s.registry.get(NEW.room)!.seen).toEqual([]);
    expect(s.deleted).toEqual([NEW.room]);
  });

  test('LiveKit errors skip the room (no close on a blind tick) and other rooms go on', async () => {
    const s = setup();
    s.registry.create({ ...NEW, room: 'second-room' });
    s.failList(new Error('connect ECONNREFUSED'));
    await s.tickAt(10 * MIN);
    expect(s.registry.open()).toHaveLength(2);
    expect(s.logs.filter((l) => l[0] === 'lifecycle error')).toHaveLength(2);
    s.failList(null);
    await s.tickAt(10 * MIN + 5000);
    expect(s.registry.open()).toHaveLength(0);
  });

  test('a token minted during the tick keeps the room open', async () => {
    const s = setup();
    // registry.open() was read before this; the token lands mid-tick
    s.onList(() => s.registry.touch(NEW.room, T0 + 5 * MIN - 1000));
    await s.tickAt(5 * MIN);
    expect(s.registry.get(NEW.room)!.closedAt).toBeNull();
    expect(s.deleted).toEqual([]);
    s.onList(() => {});
    await s.tickAt(10 * MIN - 1000);
    expect(s.registry.get(NEW.room)!.closedAt).toBe(T0 + 10 * MIN - 1000);
  });

  test('an open room that is empty is ensured in LiveKit (a LiveKit restart forgets rooms)', async () => {
    const s = setup();
    await s.tickAt(1000);
    expect(s.ensured).toEqual([NEW.room]);
    s.set([viewer('1')]);
    await s.tickAt(6000);
    expect(s.ensured).toEqual([NEW.room]); // someone is there: it exists
    s.set([]);
    await s.tickAt(11 * MIN); // closes instead
    expect(s.ensured).toEqual([NEW.room]);
    expect(s.deleted).toEqual([NEW.room]);
  });

  test('a failed deleteRoom is retried on later ticks', async () => {
    const s = setup();
    s.failDeletes(new Error('ECONNREFUSED'));
    await s.tickAt(5 * MIN);
    expect(s.registry.get(NEW.room)!.closedAt).toBe(T0 + 5 * MIN);
    expect(s.deleted).toEqual([]);
    s.failDeletes(null);
    await s.tickAt(5 * MIN + 5000);
    await s.tickAt(5 * MIN + 10_000);
    expect(s.deleted).toEqual([NEW.room]);
  });

  test('works without a Discord message (dev rooms)', async () => {
    const s = setup({ message: false });
    s.set([viewer('1')]);
    await s.tickAt(MIN);
    s.set([]);
    await s.tickAt(7 * MIN);
    expect(s.registry.get(NEW.room)!.closedAt).toBe(T0 + 7 * MIN);
    expect(s.edits).toEqual([]);
  });
});

describe('card edits', () => {
  test('only on change, at most one per 5 s, newest render wins', async () => {
    const s = setup();
    await s.tickAt(1000); // nobody: same as the posted card
    expect(s.edits).toEqual([]);
    s.set([viewer('1')]);
    await s.tickAt(2000);
    expect(s.edits.map((e) => e.at)).toEqual([T0 + 2000]);
    expect(s.edits[0]!.card.content).toContain('👀 Watching: <@1>');
    expect(s.edits[0]).toMatchObject({ channelId: '300', messageId: '999' });
    expect(s.edits[0]!.card.allowedMentions).toEqual({ parse: [] });

    s.set([streamer('1', '720p30 · H264')]);
    await s.tickAt(3000); // too soon: kept pending
    s.set([streamer('1', '1080p60 · H265')]);
    await s.tickAt(4000);
    expect(s.edits).toHaveLength(1);
    await s.tickAt(7000);
    expect(s.edits).toHaveLength(2);
    expect(s.edits[1]!.card.content).toContain('🔴 Streaming: <@1> (1080p60 · H265)');

    await s.tickAt(20_000); // unchanged
    expect(s.edits).toHaveLength(2);
  });

  test("LiveKit's listing order does not cause edits", async () => {
    const s = setup();
    s.set([viewer('2'), viewer('1')]);
    await s.tickAt(1000);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(10_000);
    expect(s.edits).toHaveLength(1);
    expect(s.edits[0]!.card.content).toContain('👀 Watching: <@2>, <@1>');
  });

  test('a change that reverts before the flush is dropped', async () => {
    const s = setup();
    s.set([viewer('1')]);
    await s.tickAt(1000);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(2000);
    s.set([viewer('1')]);
    await s.tickAt(7000);
    expect(s.edits).toHaveLength(1);
  });

  test('a final card due within the gap is flushed on a later tick, then the room is forgotten', async () => {
    const s = setup({ closeEmptyMs: 2000 });
    s.set([viewer('1')]);
    await s.tickAt(1000); // edit
    s.set([]);
    await s.tickAt(3000); // empty for 2 s: closed, but the last edit was 2 s ago
    expect(s.registry.get(NEW.room)!.closedAt).toBe(T0 + 3000);
    expect(s.edits).toHaveLength(1);
    await s.tickAt(6000);
    expect(s.edits).toHaveLength(2);
    expect(s.edits[1]!.card.content).toContain('ended');
    await s.tickAt(60_000);
    expect(s.edits).toHaveLength(2);
  });

  test('message deleted (404): stop editing, lifecycle goes on', async () => {
    const s = setup();
    s.failEdits(Object.assign(new Error('Unknown Message'), { status: 404 }));
    s.set([viewer('1')]);
    await s.tickAt(1000);
    s.failEdits(null);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(10_000);
    expect(s.edits).toEqual([]);
    s.set([]);
    await s.tickAt(10 * MIN);
    expect(s.registry.get(NEW.room)!.closedAt).toBe(T0 + 10 * MIN);
    expect(s.edits).toEqual([]);
  });

  test('403 (no access to the channel) is permanent too: no retries, the closed card is not owed', async () => {
    const s = setup();
    s.failEdits(Object.assign(new Error('Missing Access'), { status: 403, code: 50001 }));
    s.set([viewer('1')]);
    await s.tickAt(1000);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(60_000);
    s.set([]);
    await s.tickAt(10 * MIN);
    await s.tickAt(11 * MIN);
    expect(s.editTries()).toBe(1);
    expect(s.registry.get(NEW.room)!.cardDone).toBe(true);
  });

  test('isPermanentEditError', () => {
    expect(isPermanentEditError({ status: 404 })).toBe(true);
    expect(isPermanentEditError({ status: 403 })).toBe(true);
    expect(isPermanentEditError({ status: 400, code: 50013 })).toBe(true);
    expect(isPermanentEditError({ status: 503 })).toBe(false);
    expect(isPermanentEditError({ status: 429 })).toBe(false);
    expect(isPermanentEditError(new Error('ECONNRESET'))).toBe(false);
  });

  test('transient errors back off and give up after a while', async () => {
    const s = setup();
    s.failEdits(Object.assign(new Error('Service Unavailable'), { status: 503 }));
    s.set([viewer('1')]);
    for (let sec = 1; sec <= 3600; sec += 5) await s.tickAt(sec * 1000);
    expect(s.editTries()).toBe(10);
    s.failEdits(null);
    s.set([viewer('2')]);
    await s.tickAt(3700_000);
    expect(s.edits).toEqual([]);
  });

  test('a closed card a restart left unsent is sent by the next process', async () => {
    const s = setup({ closeEmptyMs: 2000 });
    s.set([viewer('1')]);
    await s.tickAt(1000); // edit
    s.set([]);
    await s.tickAt(3000); // closed, final card waits for the gap
    expect(s.registry.get(NEW.room)!.closedAt).toBe(T0 + 3000);
    expect(s.registry.cardsDue().map((r) => r.room)).toEqual([NEW.room]);
    s.restart();
    await s.tickAt(4000);
    expect(s.edits.at(-1)!.card.content).toContain('ended');
    expect(s.registry.cardsDue()).toEqual([]);
    await s.tickAt(60_000);
    expect(s.edits).toHaveLength(2);
  });

  test('other edit errors are retried after the gap', async () => {
    const s = setup();
    s.failEdits(Object.assign(new Error('Service Unavailable'), { status: 503 }));
    s.set([viewer('1')]);
    await s.tickAt(1000);
    s.failEdits(null);
    await s.tickAt(2000);
    expect(s.edits).toEqual([]);
    await s.tickAt(6000);
    expect(s.edits).toHaveLength(1);
  });
});

test('ticks never overlap', async () => {
  let calls = 0;
  let release!: () => void;
  const registry = openRegistry(':memory:');
  registry.create(NEW);
  const lc = createLifecycle({
    registry,
    rooms: {
      listParticipants: () => { calls++; return new Promise((r) => { release = () => r([]); }); },
      deleteRoom: async () => {},
      ensureRoom: async () => {},
    },
    render: (rec, live) => renderCard(rec, live, { publicUrl: 'x', group: 'g' }),
    editMessage: async () => {},
    now: () => T0,
    closeEmptyMs: 5 * MIN,
    log: () => {},
  });
  const a = lc.tick();
  const b = lc.tick();
  await b;
  expect(calls).toBe(1);
  release();
  await a;
});
