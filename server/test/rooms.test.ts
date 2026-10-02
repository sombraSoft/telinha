import { expect, test } from 'bun:test';
import { openRegistry, type NewRoom } from '../src/rooms.ts';

const NEW: NewRoom = {
  room: 'abcdefghijkl', guildId: '100', channelId: '300', locale: 'pt-BR',
  openerId: '7', openerName: 'Zé', what: 'Elden Ring', createdAt: 1000,
};

test('create + get: a fresh room is open with nobody seen', () => {
  const r = openRegistry(':memory:');
  const rec = r.create(NEW);
  expect(rec).toEqual({
    ...NEW, messageId: null, firstJoinAt: null, lastSeenAt: null, lastTokenAt: null, closedAt: null, cardDone: false,
    seen: [], streamed: [],
  });
  expect(r.get('abcdefghijkl')).toEqual(rec);
  expect(r.get('nope')).toBeNull();
  expect(r.open().map((x) => x.room)).toEqual(['abcdefghijkl']);
});

test('create refuses a duplicate room name', () => {
  const r = openRegistry(':memory:');
  r.create(NEW);
  expect(() => r.create(NEW)).toThrow();
});

test('setMessage stores where the card lives', () => {
  const r = openRegistry(':memory:');
  r.create({ ...NEW, channelId: '' });
  r.setMessage(NEW.room, '301', '999');
  expect(r.get(NEW.room)).toMatchObject({ channelId: '301', messageId: '999' });
});

test('markSeen: first join once, last seen moves, ids union in first-seen order', () => {
  const r = openRegistry(':memory:');
  r.create(NEW);
  r.markSeen(NEW.room, ['2', '1'], ['2'], 5000);
  r.markSeen(NEW.room, ['1', '3', '2'], ['3'], 9000);
  expect(r.get(NEW.room)).toMatchObject({ firstJoinAt: 5000, lastSeenAt: 9000, seen: ['2', '1', '3'], streamed: ['2', '3'] });
});

test('touch records the token only (not a join, not the card duration)', () => {
  const r = openRegistry(':memory:');
  r.create(NEW);
  expect(r.touch(NEW.room, 4000)).toBe(true);
  expect(r.get(NEW.room)).toMatchObject({ firstJoinAt: null, lastSeenAt: null, lastTokenAt: 4000, seen: [] });
  expect(r.touch('nope', 4000)).toBe(false);
});

test('closeIfEmpty judges the stored row: last seen, last token, else creation', () => {
  const r = openRegistry(':memory:');
  r.create(NEW); // created at 1000
  expect(r.closeIfEmpty(NEW.room, 5999, 5000)).toBe(false);
  r.touch(NEW.room, 3000);
  expect(r.closeIfEmpty(NEW.room, 6000, 5000)).toBe(false); // the token keeps it open
  r.markSeen(NEW.room, ['1'], [], 4000);
  expect(r.closeIfEmpty(NEW.room, 8999, 5000)).toBe(false);
  expect(r.closeIfEmpty(NEW.room, 9000, 5000)).toBe(true);
  expect(r.closeIfEmpty(NEW.room, 9999, 5000)).toBe(false);
  expect(r.get(NEW.room)!.closedAt).toBe(9000);
});

test('cardsDue: closed rooms with a message until their final card is done', () => {
  const r = openRegistry(':memory:');
  r.create(NEW);
  r.create({ ...NEW, room: 'dev-room' }); // no message (dev): never due
  r.create({ ...NEW, room: 'still-open' });
  r.setMessage(NEW.room, '300', '999');
  r.setMessage('still-open', '300', '998');
  r.close(NEW.room, 7000);
  r.close('dev-room', 7000);
  expect(r.cardsDue().map((x) => x.room)).toEqual([NEW.room]);
  r.markCardDone(NEW.room);
  expect(r.cardsDue()).toEqual([]);
  expect(r.get(NEW.room)!.cardDone).toBe(true);
});

test('close is final: once closed, not listed, later calls change nothing', () => {
  const r = openRegistry(':memory:');
  r.create(NEW);
  r.create({ ...NEW, room: 'other-room' });
  expect(r.close(NEW.room, 7000)).toBe(true);
  expect(r.close(NEW.room, 8000)).toBe(false);
  expect(r.get(NEW.room)!.closedAt).toBe(7000);
  expect(r.open().map((x) => x.room)).toEqual(['other-room']);
  // a stale poll or token fetch must not move a closed room
  r.markSeen(NEW.room, ['1'], [], 9000);
  expect(r.touch(NEW.room, 9000)).toBe(false);
  expect(r.get(NEW.room)).toMatchObject({ lastSeenAt: null, lastTokenAt: null, seen: [] });
});

test('survives a reopen of the same file', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'telinha-rooms-'));
  try {
    const file = join(dir, 'telinha.sqlite');
    const a = openRegistry(file);
    a.create(NEW);
    a.markSeen(NEW.room, ['1'], [], 2000);
    a.closeDb();
    const b = openRegistry(file);
    expect(b.get(NEW.room)).toMatchObject({ seen: ['1'], firstJoinAt: 2000 });
    b.closeDb();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adds the columns a database from before them lacks', async () => {
  const { Database } = await import('bun:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'telinha-rooms-'));
  try {
    const file = join(dir, 'telinha.sqlite');
    const old = new Database(file);
    old.exec(`CREATE TABLE rooms (room TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT,
      locale TEXT NOT NULL, opener_id TEXT NOT NULL, opener_name TEXT NOT NULL, what TEXT, created_at INTEGER NOT NULL,
      first_join_at INTEGER, last_seen_at INTEGER, closed_at INTEGER, seen TEXT NOT NULL DEFAULT '[]',
      streamed TEXT NOT NULL DEFAULT '[]')`);
    old.exec(`INSERT INTO rooms (room, guild_id, channel_id, locale, opener_id, opener_name, created_at)
      VALUES ('abcdefghijkl', '100', '300', 'en', '7', 'Zé', 1000)`);
    old.close();
    const r = openRegistry(file);
    expect(r.get(NEW.room)).toMatchObject({ lastTokenAt: null, cardDone: false });
    expect(r.touch(NEW.room, 2000)).toBe(true);
    r.closeDb();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
