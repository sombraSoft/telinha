import { describe, expect, test } from 'bun:test';
import { TrackSource } from 'livekit-server-sdk';
import { renderCard, type Card } from '../src/card.ts';
import { createLifecycle, isPermanentEditError } from '../src/lifecycle.ts';
import type { LiveParticipant, RoomService } from '../src/livekit.ts';
import { createRooms, type NewRoom } from '../src/rooms.ts';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const NEW: NewRoom = {
  room: 'lamo-futi', guildId: '100', channelId: '300', locale: 'en',
  openerId: '7', openerName: 'Zé', what: null,
};

const viewer = (id: string, tab = 'aa'): LiveParticipant => ({
  identity: `${id}:${tab}`, metadata: JSON.stringify({ id, avatar: null }), attributes: {}, tracks: [],
});
const streamer = (id: string, stream?: string, tab = 'bb'): LiveParticipant => ({
  ...viewer(id, tab), attributes: stream === undefined ? {} : { stream }, tracks: [{ source: TrackSource.SCREEN_SHARE }],
});

// The real Room module on :memory: with a fake LiveKit; the lifecycle only paces the cards.
async function setup(o: { message?: boolean; gapMs?: number; closeEmptyMs?: number } = {}) {
  let clock = T0;
  const present = new Map<string, LiveParticipant[]>();
  const deleted: string[] = [];
  const edits: { at: number; channelId: string; messageId: string; card: Card }[] = [];
  const logs: unknown[][] = [];
  let editError: unknown = null;
  let listError: unknown = null;
  let deleteError: unknown = null;
  let editTries = 0;
  const livekit: RoomService = {
    listParticipants: async (room) => {
      if (listError) throw listError;
      return present.get(room) ?? [];
    },
    deleteRoom: async (room) => {
      if (deleteError) throw deleteError;
      deleted.push(room);
    },
    ensureRoom: async () => {},
  };
  const rooms = createRooms({
    path: ':memory:', livekit, closeEmptySeconds: (o.closeEmptyMs ?? 5 * MIN) / 1000, devAutoOpen: true, now: () => clock,
    log: (...a) => void logs.push(a),
  });
  /** A room /telinha opened (its card is message 999), or with message: false a dev room (no card). */
  const open = (room: string) => (o.message === false
    ? rooms.admit(room, { id: '7', name: 'Zé', locale: 'en' })
    : rooms.open({ ...NEW, room }, async () => ({ channelId: '300', messageId: '999' })));
  await open(NEW.room);
  const newLifecycle = () => createLifecycle({
    rooms,
    render: (rec, live) => renderCard(rec, live, { publicUrl: 'https://tela.example.com', group: 'Crew' }),
    editMessage: async (channelId, messageId, card) => {
      editTries++;
      if (editError) throw editError;
      edits.push({ at: clock, channelId, messageId, card });
    },
    now: () => clock,
    editGapMs: o.gapMs,
    log: (...a) => void logs.push(a),
  });
  let lc = newLifecycle();
  return {
    rooms, open, present, deleted, edits, logs,
    get lc() { return lc; },
    /** A fresh process on the same database (in-memory card state lost). */
    restart: () => { lc = newLifecycle(); },
    editTries: () => editTries,
    failDeletes: (e: unknown) => { deleteError = e; },
    set: (ps: LiveParticipant[], room = NEW.room) => present.set(room, ps),
    at: (ms: number) => { clock = T0 + ms; },
    failEdits: (e: unknown) => { editError = e; },
    failList: (e: unknown) => { listError = e; },
    /** Advances the clock to `ms` and runs one tick. */
    tickAt: async (ms: number) => { clock = T0 + ms; await lc.tick(); },
  };
}

describe('closing', () => {
  test('5 min after /telinha when nobody ever joined', async () => {
    const s = await setup();
    await s.tickAt(4 * MIN + 59_000);
    expect(s.rooms.get(NEW.room)!.closedAt).toBeNull();
    await s.tickAt(5 * MIN);
    expect(s.rooms.get(NEW.room)!.closedAt).toBe(T0 + 5 * MIN);
    expect(s.deleted).toEqual([NEW.room]);
    expect(s.edits.at(-1)!.card.content).toBe('📺 Telinha by **Zé** ended\n⏱️ Nobody joined');
    expect(s.edits.at(-1)!.card.components).toEqual([]);
  });

  test('5 min after the last person left', async () => {
    const s = await setup();
    s.set([viewer('1')]);
    await s.tickAt(MIN);
    await s.tickAt(9 * MIN);
    s.set([]);
    await s.tickAt(9 * MIN + 5000);
    await s.tickAt(13 * MIN + 59_000);
    expect(s.rooms.get(NEW.room)!.closedAt).toBeNull();
    await s.tickAt(14 * MIN);
    const rec = s.rooms.get(NEW.room)!;
    expect(rec).toMatchObject({ closedAt: T0 + 14 * MIN, firstJoinAt: T0 + MIN, lastSeenAt: T0 + 9 * MIN, seen: ['1'] });
    expect(s.deleted).toEqual([NEW.room]);
    expect(s.edits.at(-1)!.card.content).toBe('📺 Telinha by **Zé** ended\n⏱️ Lasted 8 min\n👥 Stopped by: <@1>');
  });

  test('a closed room is no longer polled', async () => {
    const s = await setup();
    await s.tickAt(5 * MIN);
    s.set([viewer('1')]);
    await s.tickAt(6 * MIN);
    expect(s.rooms.get(NEW.room)!.seen).toEqual([]);
    expect(s.deleted).toEqual([NEW.room]);
  });

  test('LiveKit errors skip the room (no close on a blind tick) and other rooms go on', async () => {
    const s = await setup();
    await s.open('seku-dosa');
    s.failList(new Error('connect ECONNREFUSED'));
    await s.tickAt(10 * MIN);
    expect(s.rooms.openRooms()).toHaveLength(2);
    expect(s.logs.filter((l) => l[0] === 'lifecycle error')).toHaveLength(2);
    s.failList(null);
    await s.tickAt(10 * MIN + 5000);
    expect(s.rooms.openRooms()).toHaveLength(0);
  });

  test('a failed deleteRoom is retried on later ticks', async () => {
    const s = await setup();
    s.failDeletes(new Error('ECONNREFUSED'));
    await s.tickAt(5 * MIN);
    expect(s.rooms.get(NEW.room)!.closedAt).toBe(T0 + 5 * MIN);
    expect(s.deleted).toEqual([]);
    s.failDeletes(null);
    await s.tickAt(5 * MIN + 5000);
    await s.tickAt(5 * MIN + 10_000);
    expect(s.deleted).toEqual([NEW.room]);
  });

  test('works without a Discord message (dev rooms)', async () => {
    const s = await setup({ message: false });
    s.set([viewer('1')]);
    await s.tickAt(MIN);
    s.set([]);
    await s.tickAt(7 * MIN);
    expect(s.rooms.get(NEW.room)!.closedAt).toBe(T0 + 7 * MIN);
    expect(s.edits).toEqual([]);
  });
});

describe('card edits', () => {
  test('only on change, at most one per 5 s, newest render wins', async () => {
    const s = await setup();
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
    const s = await setup();
    s.set([viewer('2'), viewer('1')]);
    await s.tickAt(1000);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(10_000);
    expect(s.edits).toHaveLength(1);
    expect(s.edits[0]!.card.content).toContain('👀 Watching: <@2>, <@1>');
  });

  test('a change that reverts before the flush is dropped', async () => {
    const s = await setup();
    s.set([viewer('1')]);
    await s.tickAt(1000);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(2000);
    s.set([viewer('1')]);
    await s.tickAt(7000);
    expect(s.edits).toHaveLength(1);
  });

  test('a final card due within the gap is flushed on a later tick, then the room is forgotten', async () => {
    const s = await setup({ closeEmptyMs: 2000 });
    s.set([viewer('1')]);
    await s.tickAt(1000); // edit
    s.set([]);
    await s.tickAt(3000); // empty for 2 s: closed, but the last edit was 2 s ago
    expect(s.rooms.get(NEW.room)!.closedAt).toBe(T0 + 3000);
    expect(s.edits).toHaveLength(1);
    await s.tickAt(6000);
    expect(s.edits).toHaveLength(2);
    expect(s.edits[1]!.card.content).toContain('ended');
    await s.tickAt(60_000);
    expect(s.edits).toHaveLength(2);
  });

  test('message deleted (404): stop editing, lifecycle goes on', async () => {
    const s = await setup();
    s.failEdits(Object.assign(new Error('Unknown Message'), { status: 404 }));
    s.set([viewer('1')]);
    await s.tickAt(1000);
    s.failEdits(null);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(10_000);
    expect(s.edits).toEqual([]);
    s.set([]);
    await s.tickAt(10 * MIN);
    expect(s.rooms.get(NEW.room)!.closedAt).toBe(T0 + 10 * MIN);
    expect(s.edits).toEqual([]);
  });

  test('403 (no access to the channel) is permanent too: no retries, the closed card is not owed', async () => {
    const s = await setup();
    s.failEdits(Object.assign(new Error('Missing Access'), { status: 403, code: 50001 }));
    s.set([viewer('1')]);
    await s.tickAt(1000);
    s.set([viewer('1'), viewer('2')]);
    await s.tickAt(60_000);
    s.set([]);
    await s.tickAt(10 * MIN);
    await s.tickAt(11 * MIN);
    expect(s.editTries()).toBe(1);
    expect(s.rooms.get(NEW.room)!.cardDone).toBe(true);
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
    const s = await setup();
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
    const s = await setup({ closeEmptyMs: 2000 });
    s.set([viewer('1')]);
    await s.tickAt(1000); // edit
    s.set([]);
    await s.tickAt(3000); // closed, final card waits for the gap
    expect(s.rooms.get(NEW.room)!.closedAt).toBe(T0 + 3000);
    expect(s.rooms.cardsDue().map((r) => r.room)).toEqual([NEW.room]);
    s.restart();
    await s.tickAt(4000);
    expect(s.edits.at(-1)!.card.content).toContain('ended');
    expect(s.rooms.cardsDue()).toEqual([]);
    await s.tickAt(60_000);
    expect(s.edits).toHaveLength(2);
  });

  test('other edit errors are retried after the gap', async () => {
    const s = await setup();
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
  const lc = createLifecycle({
    rooms: {
      openRooms: () => [NEW.room],
      observe: () => { calls++; return new Promise((r) => { release = () => r(null); }); },
      retryDeletes: async () => {},
      cardsDue: () => [],
      markCardDone: () => {},
    },
    render: (rec, live) => renderCard(rec, live, { publicUrl: 'x', group: 'g' }),
    editMessage: async () => {},
    now: () => T0,
    log: () => {},
  });
  const a = lc.tick();
  const b = lc.tick();
  await b;
  expect(calls).toBe(1);
  release();
  await a;
});
