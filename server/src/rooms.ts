// Room registry on bun:sqlite. Every valid room comes from /telinha (or the dev
// login), and a closed room stays closed: the token endpoint refuses it.
import { Database } from 'bun:sqlite';
import type { Locale } from './i18n.ts';

export interface NewRoom {
  room: string;
  guildId: string;
  channelId: string;
  /** Guild locale the card is written in. */
  locale: Locale;
  openerId: string;
  openerName: string;
  what: string | null;
  createdAt: number;
}

export interface RoomRecord extends NewRoom {
  messageId: string | null;
  firstJoinAt: number | null;
  /** Last time someone was in it (the card's duration ends here). */
  lastSeenAt: number | null;
  /** Last token minted for it: keeps it open while that person connects. */
  lastTokenAt: number | null;
  closedAt: number | null;
  /** The closed card reached Discord (or never will): nothing left to edit. */
  cardDone: boolean;
  /** Discord ids of everyone who was ever in it, in first-seen order. */
  seen: string[];
  streamed: string[];
}

export interface Registry {
  create(r: NewRoom): RoomRecord;
  get(room: string): RoomRecord | null;
  open(): RoomRecord[];
  markSeen(room: string, ids: string[], streamerIds: string[], now: number): void;
  /**
   * Keeps an open room alive without counting anyone as having joined.
   * False when the room is closed (or unknown).
   */
  touch(room: string, now: number): boolean;
  /** True if this call closed it. */
  close(room: string, now: number): boolean;
  /**
   * Closes it only if it is still open and nobody was in it (nor fetched a
   * token) for emptyMs, judged on the stored row, not on a caller's snapshot.
   * True if this call closed it.
   */
  closeIfEmpty(room: string, now: number, emptyMs: number): boolean;
  /** Closed rooms whose final card has not reached Discord yet. */
  cardsDue(): RoomRecord[];
  markCardDone(room: string): void;
  setMessage(room: string, channelId: string, messageId: string): void;
  closeDb(): void;
}

interface Row {
  room: string; guild_id: string; channel_id: string; message_id: string | null; locale: string;
  opener_id: string; opener_name: string; what: string | null; created_at: number;
  first_join_at: number | null; last_seen_at: number | null; last_token_at: number | null; closed_at: number | null;
  card_done: number; seen: string; streamed: string;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS rooms (
  room TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  locale TEXT NOT NULL,
  opener_id TEXT NOT NULL,
  opener_name TEXT NOT NULL,
  what TEXT,
  created_at INTEGER NOT NULL,
  first_join_at INTEGER,
  last_seen_at INTEGER,
  last_token_at INTEGER,
  closed_at INTEGER,
  card_done INTEGER NOT NULL DEFAULT 0,
  seen TEXT NOT NULL DEFAULT '[]',
  streamed TEXT NOT NULL DEFAULT '[]'
)`;

// Columns added after the table first shipped to a dev database.
const ADDED: [string, string][] = [
  ['last_token_at', 'INTEGER'],
  ['card_done', 'INTEGER NOT NULL DEFAULT 0'],
];

const ids = (json: string): string[] => {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const fromRow = (r: Row): RoomRecord => ({
  room: r.room,
  guildId: r.guild_id,
  channelId: r.channel_id,
  messageId: r.message_id,
  locale: r.locale === 'pt-BR' ? 'pt-BR' : 'en',
  openerId: r.opener_id,
  openerName: r.opener_name,
  what: r.what,
  createdAt: r.created_at,
  firstJoinAt: r.first_join_at,
  lastSeenAt: r.last_seen_at,
  lastTokenAt: r.last_token_at,
  closedAt: r.closed_at,
  cardDone: r.card_done !== 0,
  seen: ids(r.seen),
  streamed: ids(r.streamed),
});

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

/** path ':memory:' for tests; the caller makes sure the directory exists. */
export function openRegistry(path: string): Registry {
  const db = new Database(path, { create: true, strict: true });
  // WAL: a crash mid-write never loses the closed flag of earlier rooms.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  const have = new Set(db.query<{ name: string }, []>('PRAGMA table_info(rooms)').all().map((c) => c.name));
  for (const [col, type] of ADDED) if (!have.has(col)) db.exec(`ALTER TABLE rooms ADD COLUMN ${col} ${type}`);

  const getQ = db.query<Row, { room: string }>('SELECT * FROM rooms WHERE room = $room');
  const openQ = db.query<Row, []>('SELECT * FROM rooms WHERE closed_at IS NULL ORDER BY created_at, room');
  const insertQ = db.query(`INSERT INTO rooms (room, guild_id, channel_id, locale, opener_id, opener_name, what, created_at)
    VALUES ($room, $guildId, $channelId, $locale, $openerId, $openerName, $what, $createdAt)`);
  const seenQ = db.query(`UPDATE rooms SET first_join_at = COALESCE(first_join_at, $now), last_seen_at = $now,
    seen = $seen, streamed = $streamed WHERE room = $room AND closed_at IS NULL`);
  const touchQ = db.query('UPDATE rooms SET last_token_at = $now WHERE room = $room AND closed_at IS NULL');
  const closeQ = db.query('UPDATE rooms SET closed_at = $now WHERE room = $room AND closed_at IS NULL');
  // One statement, so a token minted after the caller's snapshot still counts.
  const closeEmptyQ = db.query(`UPDATE rooms SET closed_at = $now WHERE room = $room AND closed_at IS NULL
    AND MAX(COALESCE(last_seen_at, created_at), COALESCE(last_token_at, 0)) <= $now - $emptyMs`);
  const dueQ = db.query<Row, []>(`SELECT * FROM rooms WHERE closed_at IS NOT NULL AND card_done = 0
    AND message_id IS NOT NULL ORDER BY closed_at, room`);
  const doneQ = db.query('UPDATE rooms SET card_done = 1 WHERE room = $room');
  const messageQ = db.query('UPDATE rooms SET channel_id = $channelId, message_id = $messageId WHERE room = $room');

  const get = (room: string) => {
    const row = getQ.get({ room });
    return row ? fromRow(row) : null;
  };

  // Read-modify-write of the JSON lists in one transaction.
  const markSeen = db.transaction((room: string, present: string[], streamers: string[], now: number) => {
    const cur = get(room);
    if (!cur || cur.closedAt !== null) return;
    seenQ.run({
      room, now, seen: JSON.stringify(union(cur.seen, present)), streamed: JSON.stringify(union(cur.streamed, streamers)),
    });
  });

  return {
    create(r) {
      insertQ.run({ ...r });
      return get(r.room)!;
    },
    get,
    open: () => openQ.all().map(fromRow),
    markSeen: (room, present, streamers, now) => markSeen(room, present, streamers, now),
    touch: (room, now) => touchQ.run({ room, now }).changes > 0,
    close: (room, now) => closeQ.run({ room, now }).changes > 0,
    closeIfEmpty: (room, now, emptyMs) => closeEmptyQ.run({ room, now, emptyMs }).changes > 0,
    cardsDue: () => dueQ.all().map(fromRow),
    markCardDone: (room) => void doneQ.run({ room }),
    setMessage: (room, channelId, messageId) => void messageQ.run({ room, channelId, messageId }),
    closeDb: () => db.close(),
  };
}
