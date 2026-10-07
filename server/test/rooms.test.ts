import { describe, expect, test } from 'bun:test';
import { TrackSource } from 'livekit-server-sdk';
import type { LiveParticipant, RoomService, RoomTimeouts } from '../src/livekit.ts';
import { createRooms, type NewRoom, type RoomRecord } from '../src/rooms.ts';

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const NEW: NewRoom = {
  room: 'lamo-futi', guildId: '100', channelId: '300', locale: 'pt-BR', openerId: '7', openerName: 'Zé', what: 'Elden Ring',
};
const MEMBER = { id: '1', name: 'Dev', locale: 'pt-BR' as const };
const CARD = async () => ({ channelId: '301', messageId: '999' });

const viewer = (id: string, tab = 'aa'): LiveParticipant => ({
  identity: `${id}:${tab}`, metadata: JSON.stringify({ id, avatar: null }), attributes: {}, tracks: [],
});
const streamer = (id: string, stream?: string, tab = 'bb'): LiveParticipant => ({
  ...viewer(id, tab), attributes: stream === undefined ? {} : { stream }, tracks: [{ source: TrackSource.SCREEN_SHARE }],
});

type Op = 'ensure' | 'list' | 'delete';

/** The Room module on a fake clock and a fake LiveKit whose calls can fail or be held. */
function setup(o: { devAutoOpen?: boolean; path?: string } = {}) {
  let clock = T0;
  const calls: string[] = [];
  const timeouts: RoomTimeouts[] = [];
  const logs: unknown[][] = [];
  const present = new Map<string, LiveParticipant[]>();
  const failing = new Map<Op, Error>();
  const holding = new Set<Op>();
  const held = new Map<Op, () => void>();
  const gate = async (op: Op, room: string) => {
    calls.push(`${op} ${room}`);
    if (holding.delete(op)) await new Promise<void>((r) => held.set(op, r));
    const e = failing.get(op);
    if (e) throw e;
  };
  const livekit: RoomService = {
    ensureRoom: async (room, t) => {
      timeouts.push(t);
      await gate('ensure', room);
    },
    listParticipants: async (room) => {
      await gate('list', room);
      return present.get(room) ?? [];
    },
    deleteRoom: (room) => gate('delete', room),
  };
  const rooms = createRooms({
    path: o.path ?? ':memory:', livekit, closeEmptySeconds: 300, devAutoOpen: o.devAutoOpen, now: () => clock,
    log: (...a) => void logs.push(a),
  });
  return {
    rooms, calls, timeouts, logs,
    at: (ms: number) => { clock = T0 + ms; },
    set: (ps: LiveParticipant[], room = NEW.room) => present.set(room, ps),
    fail: (op: Op, e: Error | null) => (e ? failing.set(op, e) : failing.delete(op)),
    /** The next `op` call waits until release(op). */
    hold: (op: Op) => holding.add(op),
    release: (op: Op) => {
      held.get(op)!();
      held.delete(op);
    },
  };
}

describe('open', () => {
  test('registers the room, creates it in LiveKit, posts its card and stores where it landed', async () => {
    const s = setup();
    const posted: RoomRecord[] = [];
    await s.rooms.open(NEW, async (rec) => {
      posted.push(rec);
      return { channelId: '301', messageId: '999' };
    });
    expect(posted).toEqual([{
      ...NEW, createdAt: T0, messageId: null, firstJoinAt: null, lastSeenAt: null, lastTokenAt: null, closedAt: null,
      cardDone: false, seen: [], streamed: [],
    }]);
    expect(s.calls).toEqual(['ensure lamo-futi']);
    // LiveKit keeps an empty room 2 min longer than the close window.
    expect(s.timeouts).toEqual([{ emptyTimeout: 420, departureTimeout: 20 }]);
    expect(s.rooms.get(NEW.room)).toMatchObject({ channelId: '301', messageId: '999', closedAt: null });
    expect(s.rooms.openRooms()).toEqual([NEW.room]);
    expect(s.rooms.get('nope')).toBeNull();
  });

  test('LiveKit down: closed, deleted, the error rethrown, no card posted', async () => {
    const s = setup();
    s.fail('ensure', new Error('livekit down'));
    let posts = 0;
    await expect(s.rooms.open(NEW, async () => {
      posts++;
      return { channelId: '301', messageId: '999' };
    })).rejects.toThrow('livekit down');
    expect(posts).toBe(0);
    expect(s.calls).toEqual(['ensure lamo-futi', 'delete lamo-futi']);
    expect(s.rooms.get(NEW.room)!.closedAt).toBe(T0);
    expect(s.rooms.openRooms()).toEqual([]);
  });

  test('card not posted: closed and deleted from LiveKit (best effort), the error rethrown', async () => {
    const s = setup();
    s.fail('delete', new Error('ECONNREFUSED'));
    await expect(s.rooms.open(NEW, async () => { throw new Error('Unknown interaction'); })).rejects.toThrow('Unknown interaction');
    expect(s.calls).toEqual(['ensure lamo-futi', 'delete lamo-futi']);
    expect(s.rooms.get(NEW.room)).toMatchObject({ closedAt: T0, messageId: null });
  });

  test('a taken code is refused and leaves the room that has it alone', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    await expect(s.rooms.open(NEW, CARD)).rejects.toThrow();
    expect(s.calls).toEqual(['ensure lamo-futi']);
    expect(s.rooms.get(NEW.room)!.closedAt).toBeNull();
  });
});

describe('admit', () => {
  test('open room: ok once LiveKit has it; a token is not a join', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.at(1000);
    expect(await s.rooms.admit(NEW.room, MEMBER)).toBe('ok');
    expect(s.calls).toEqual(['ensure lamo-futi', 'ensure lamo-futi']);
    // keeps it open, but the card's duration ignores it
    expect(s.rooms.get(NEW.room)).toMatchObject({ lastTokenAt: T0 + 1000, lastSeenAt: null, firstJoinAt: null, seen: [] });
  });

  test('unknown code: unknown, nothing created, LiveKit not asked', async () => {
    const s = setup();
    expect(await s.rooms.admit('tuge-dosa', MEMBER)).toBe('unknown');
    expect(s.rooms.get('tuge-dosa')).toBeNull();
    expect(s.calls).toEqual([]);
  });

  test('closed room: closed, LiveKit not asked, nothing moves', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.at(5 * MIN);
    await s.rooms.observe(NEW.room);
    s.calls.length = 0;
    s.at(6 * MIN);
    expect(await s.rooms.admit(NEW.room, MEMBER)).toBe('closed');
    expect(s.calls).toEqual([]);
    expect(s.rooms.get(NEW.room)!.lastTokenAt).toBeNull();
  });

  test('LiveKit down: media-down, logged', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.fail('ensure', new Error('ECONNREFUSED'));
    expect(await s.rooms.admit(NEW.room, MEMBER)).toBe('media-down');
    expect(s.logs).toContainEqual(['ensureRoom failed', NEW.room, 'ECONNREFUSED']);
  });

  test('devAutoOpen: an unknown code opens under the member; a closed one stays closed', async () => {
    const s = setup({ devAutoOpen: true });
    expect(await s.rooms.admit('debu-gamo', MEMBER)).toBe('ok');
    expect(s.rooms.get('debu-gamo')).toMatchObject({
      guildId: '', channelId: '', openerId: '1', openerName: 'Dev', locale: 'pt-BR', what: null, messageId: null,
      createdAt: T0, closedAt: null,
    });
    expect(s.logs).toContainEqual(['dev room', 'debu-gamo']);
    s.at(5 * MIN);
    expect((await s.rooms.observe('debu-gamo'))!.record.closedAt).toBe(T0 + 5 * MIN);
    expect(await s.rooms.admit('debu-gamo', MEMBER)).toBe('closed');
  });
});

describe('observe', () => {
  test('records who came: one entry per member in first-seen order, streamers with their quality', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.set([streamer('3')]);
    s.at(1000);
    await s.rooms.observe(NEW.room);
    s.set([
      viewer('1', 'a1'), streamer('1', '1080p60 · H265', 'a2'), // streams in one tab, watches in another
      viewer('2'), viewer('2', 'zz'), streamer('3'),
      { identity: 'agent-x', metadata: '', attributes: {}, tracks: [] }, // no Discord id: ignored
    ]);
    s.at(2000);
    const o = (await s.rooms.observe(NEW.room))!;
    expect(o.live).toEqual({ streamers: [{ id: '3' }, { id: '1', quality: '1080p60 · H265' }], viewers: ['2'] });
    expect(o.record).toMatchObject({ firstJoinAt: T0 + 1000, lastSeenAt: T0 + 2000, seen: ['3', '1', '2'], streamed: ['3', '1'] });
    // LiveKit's listing order changes nothing
    s.set([viewer('2'), streamer('1', '1080p60 · H265', 'a2'), streamer('3')]);
    expect((await s.rooms.observe(NEW.room))!.live).toEqual(o.live);
  });

  test('identity wins over metadata (metadata is self-editable)', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.set([
      { identity: '5:ab', metadata: JSON.stringify({ id: '6' }), attributes: {}, tracks: [] },
      { identity: 'weird', metadata: JSON.stringify({ id: '7' }), attributes: {}, tracks: [] },
    ]);
    expect((await s.rooms.observe(NEW.room))!.record.seen).toEqual(['5', '7']);
  });

  test('stream quality: short plain labels only', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    for (const [label, shown] of [
      ['1080p60 · H265', '1080p60 · H265'], ['', undefined], [undefined, undefined], ['<@&123> everyone', undefined],
      ['x'.repeat(40), undefined], ['[a](https://evil)', undefined],
    ] as const) {
      s.set([streamer('1', label)]);
      expect((await s.rooms.observe(NEW.room))!.live.streamers).toEqual([shown ? { id: '1', quality: shown } : { id: '1' }]);
    }
  });

  test('an empty room closes after the close window (from opening when nobody joined) and leaves LiveKit', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.at(5 * MIN - 1000);
    expect((await s.rooms.observe(NEW.room))!.record.closedAt).toBeNull();
    s.at(5 * MIN);
    const o = (await s.rooms.observe(NEW.room))!;
    expect(o.record.closedAt).toBe(T0 + 5 * MIN);
    expect(o.live).toEqual({ streamers: [], viewers: [] });
    expect(s.calls.at(-1)).toBe('delete lamo-futi');
    expect(s.logs).toContainEqual(['room closed', NEW.room]);
    expect(s.rooms.openRooms()).toEqual([]);
  });

  test('from the last time someone was in it', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.set([viewer('1')]);
    for (let m = 0; m <= 120; m += 1) {
      s.at(m * MIN);
      await s.rooms.observe(NEW.room);
    }
    expect(s.rooms.get(NEW.room)!.closedAt).toBeNull();
    s.set([]);
    s.at(124 * MIN);
    expect((await s.rooms.observe(NEW.room))!.record.closedAt).toBeNull();
    s.at(125 * MIN);
    expect((await s.rooms.observe(NEW.room))!.record).toMatchObject({ closedAt: T0 + 125 * MIN, firstJoinAt: T0, lastSeenAt: T0 + 120 * MIN });
  });

  test('empty but open: ensured in LiveKit again (a LiveKit restart forgets rooms), not while someone is in it', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.calls.length = 0;
    s.at(1000);
    await s.rooms.observe(NEW.room);
    expect(s.calls).toEqual(['list lamo-futi', 'ensure lamo-futi']);
    s.set([viewer('1')]);
    await s.rooms.observe(NEW.room);
    expect(s.calls).toEqual(['list lamo-futi', 'ensure lamo-futi', 'list lamo-futi']);
    s.fail('ensure', new Error('ECONNREFUSED'));
    s.set([]);
    await s.rooms.observe(NEW.room);
    expect(s.logs).toContainEqual(['lifecycle ensureRoom', NEW.room, 'ECONNREFUSED']);
  });

  test("LiveKit can't be asked: throws and nothing changes (no close on a blind poll)", async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.fail('list', new Error('connect ECONNREFUSED'));
    s.at(10 * MIN);
    await expect(s.rooms.observe(NEW.room)).rejects.toThrow('ECONNREFUSED');
    expect(s.rooms.get(NEW.room)!.closedAt).toBeNull();
  });

  test('a closed room is final: LiveKit not asked, nobody recorded; unknown rooms are null', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.at(5 * MIN);
    await s.rooms.observe(NEW.room);
    s.calls.length = 0;
    s.set([viewer('1')]);
    s.at(6 * MIN);
    const o = (await s.rooms.observe(NEW.room))!;
    expect(o.record).toMatchObject({ closedAt: T0 + 5 * MIN, seen: [], lastSeenAt: null });
    expect(o.live).toEqual({ streamers: [], viewers: [] });
    expect(s.calls).toEqual([]);
    expect(await s.rooms.observe('tuge-dosa')).toBeNull();
  });

  test('a failed delete of a closed room waits for retryDeletes, at most 12 tries', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.fail('delete', new Error('ECONNREFUSED'));
    s.at(5 * MIN);
    await s.rooms.observe(NEW.room);
    expect(s.logs).toContainEqual(['lifecycle deleteRoom', NEW.room, 'ECONNREFUSED']);
    for (let i = 0; i < 15; i++) await s.rooms.retryDeletes();
    expect(s.calls.filter((c) => c.startsWith('delete'))).toHaveLength(12);
    s.fail('delete', null);
    await s.rooms.retryDeletes();
    expect(s.calls.filter((c) => c.startsWith('delete'))).toHaveLength(12);
  });
});

describe('admit and observe interleaved', () => {
  test('a token minted while observe asks LiveKit keeps the room open', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.at(5 * MIN);
    s.hold('list');
    const polling = s.rooms.observe(NEW.room);
    expect(await s.rooms.admit(NEW.room, MEMBER)).toBe('ok');
    s.release('list');
    expect((await polling)!.record.closedAt).toBeNull();
    expect(s.calls).not.toContain('delete lamo-futi');
    s.at(10 * MIN);
    expect((await s.rooms.observe(NEW.room))!.record.closedAt).toBe(T0 + 10 * MIN);
  });

  test('a poll while admit asks LiveKit already sees the token: the room stays open', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.at(5 * MIN - 1000);
    s.hold('ensure');
    const admitting = s.rooms.admit(NEW.room, MEMBER);
    s.at(5 * MIN);
    expect((await s.rooms.observe(NEW.room))!.record.closedAt).toBeNull();
    s.release('ensure');
    expect(await admitting).toBe('ok');
  });

  test('closed while admit asks LiveKit: closed, and the LiveKit room it made is deleted', async () => {
    const s = setup();
    await s.rooms.open(NEW, CARD);
    s.at(1000);
    s.hold('ensure');
    const admitting = s.rooms.admit(NEW.room, MEMBER);
    s.at(5 * MIN + 1000);
    expect((await s.rooms.observe(NEW.room))!.record.closedAt).toBe(T0 + 5 * MIN + 1000);
    s.release('ensure');
    expect(await admitting).toBe('closed');
    expect(s.calls).toEqual(['ensure lamo-futi', 'ensure lamo-futi', 'list lamo-futi', 'delete lamo-futi', 'delete lamo-futi']);
  });
});

describe('cards', () => {
  test('cardsDue: closed rooms with a card, until it is marked done', async () => {
    const s = setup({ devAutoOpen: true });
    await s.rooms.open(NEW, CARD);
    await s.rooms.open({ ...NEW, room: 'siti-lopa' }, CARD);
    await s.rooms.admit('deve-romo', MEMBER); // no card (dev): never due
    expect(s.rooms.cardsDue()).toEqual([]);
    s.at(5 * MIN);
    for (const room of s.rooms.openRooms()) await s.rooms.observe(room);
    expect(s.rooms.cardsDue().map((x) => x.room)).toEqual([NEW.room, 'siti-lopa']);
    s.rooms.markCardDone(NEW.room);
    expect(s.rooms.cardsDue().map((x) => x.room)).toEqual(['siti-lopa']);
    expect(s.rooms.get(NEW.room)!.cardDone).toBe(true);
  });
});

describe('the SQLite file', () => {
  const inTempDir = async (f: (file: string) => Promise<void>) => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'telinha-rooms-'));
    try {
      await f(join(dir, 'telinha.sqlite'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('rooms survive a restart on the same file', () => inTempDir(async (file) => {
    const a = setup({ path: file });
    await a.rooms.open(NEW, CARD);
    a.set([viewer('1')]);
    a.at(2000);
    await a.rooms.observe(NEW.room);
    a.rooms.closeDb();
    const b = setup({ path: file });
    expect(b.rooms.get(NEW.room)).toMatchObject({ seen: ['1'], firstJoinAt: T0 + 2000, messageId: '999' });
    expect(b.rooms.openRooms()).toEqual([NEW.room]);
    b.rooms.closeDb();
  }));

  test('adds the columns a database from before them lacks', () => inTempDir(async (file) => {
    const { Database } = await import('bun:sqlite');
    const old = new Database(file);
    old.exec(`CREATE TABLE rooms (room TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
      locale TEXT NOT NULL, opener_id TEXT NOT NULL, opener_name TEXT NOT NULL, what TEXT, created_at INTEGER NOT NULL,
      first_join_at INTEGER, last_seen_at INTEGER, closed_at INTEGER, seen TEXT NOT NULL DEFAULT '[]',
      streamed TEXT NOT NULL DEFAULT '[]')`);
    old.exec(`INSERT INTO rooms (room, guild_id, channel_id, locale, opener_id, opener_name, created_at)
      VALUES ('lamo-futi', '100', '300', 'en', '7', 'Zé', ${T0})`);
    old.close();
    const s = setup({ path: file });
    expect(s.rooms.get(NEW.room)).toMatchObject({ lastTokenAt: null, cardDone: false });
    expect(await s.rooms.admit(NEW.room, MEMBER)).toBe('ok');
    expect(s.rooms.get(NEW.room)!.lastTokenAt).toBe(T0);
    s.rooms.closeDb();
  }));
});
