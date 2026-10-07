// The Room module: opens a room for /telinha, admits members to it, observes it
// on every poll and closes it for good once empty. It owns the room registry
// (bun:sqlite) and the rooms in LiveKit, so the ordering rules between the two
// live here: closed stays closed, a minted token keeps an open room alive, a
// LiveKit room exists whenever a token is handed out, and a room without its
// card is closed and deleted.
import { Database } from 'bun:sqlite';
import { TrackSource } from 'livekit-server-sdk';
import type { Live } from './card.ts';
import type { Locale } from './i18n.ts';
import { roomTimeouts, type LiveParticipant, type RoomService } from './livekit.ts';

export interface NewRoom {
  room: string;
  guildId: string;
  channelId: string;
  /** Guild locale the card is written in. */
  locale: Locale;
  openerId: string;
  openerName: string;
  what: string | null;
}

export interface RoomRecord extends NewRoom {
  createdAt: number;
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

/** Where the open card landed in Discord. */
export interface CardMessage {
  channelId: string;
  messageId: string;
}

/** Whether a member may have a token for the room, and if not, why. */
export type Admission = 'ok' | 'unknown' | 'closed' | 'media-down';

export interface Observation {
  /** The room as stored after this poll; closedAt is set once it is closed. */
  record: RoomRecord;
  /** Who is in it, in first-seen order; nobody once closed. */
  live: Live;
}

export interface Rooms {
  /**
   * Opens a room for /telinha: registers it, creates it in LiveKit, posts its
   * card and records where the card landed. On any failure the room is closed
   * and deleted from LiveKit (best effort), and the error is rethrown.
   */
  open(room: NewRoom, postCard: (rec: RoomRecord) => Promise<CardMessage>): Promise<void>;
  /**
   * Lets a member in: the room is open, kept from closing while they connect,
   * and exists in LiveKit. Only 'ok' may be followed by a token.
   */
  admit(room: string, member: { id: string; name: string; locale: Locale }): Promise<Admission>;
  /**
   * One poll of a room: records who is in it, closes it (and deletes it from
   * LiveKit) once it is an empty room, else makes sure LiveKit still has it.
   * Null for an unknown room; throws when LiveKit can't be asked (nothing changes then).
   */
  observe(room: string): Promise<Observation | null>;
  /** Deletes from LiveKit the closed rooms whose delete failed on an earlier poll. */
  retryDeletes(): Promise<void>;
  /** Codes of the open rooms, oldest first. */
  openRooms(): string[];
  get(room: string): RoomRecord | null;
  /** Closed rooms whose final card has not reached Discord yet. */
  cardsDue(): RoomRecord[];
  markCardDone(room: string): void;
  closeDb(): void;
}

const DISCORD_ID = /^\d{1,20}$/;
const NOBODY: Live = { streamers: [], viewers: [] };
/** Polls a failed deleteRoom of a closed room is retried for. */
const MAX_DELETE_TRIES = 12;

/** The page writes e.g. "1080p60 · H265"; anything else is not shown. */
function cleanQuality(v: string | undefined): string | undefined {
  return v && v.length <= 24 && /^[\w .·-]+$/.test(v) ? v : undefined;
}

// The identity ("<discord id>:<tab>") comes from our token and can't be
// changed by the client; metadata can (canUpdateOwnMetadata), so it is only a
// fallback for identities in another shape.
function discordId(p: LiveParticipant): string | null {
  const fromIdentity = p.identity.split(':')[0] ?? '';
  if (DISCORD_ID.test(fromIdentity)) return fromIdentity;
  try {
    const id = (JSON.parse(p.metadata) as { id?: unknown } | null)?.id;
    return typeof id === 'string' && DISCORD_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Who is in the room, one entry per Discord user (people open several tabs).
 * `order` (first-seen order) keeps the card stable between polls; LiveKit's
 * listing order is not.
 */
function presence(ps: LiveParticipant[], order: string[]): { ids: string[]; live: Live } {
  const users = new Map<string, { streaming: boolean; quality?: string }>();
  for (const p of ps) {
    const id = discordId(p);
    if (!id) continue;
    const u = users.get(id) ?? { streaming: false };
    if (p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE)) {
      u.streaming = true;
      u.quality ??= cleanQuality(p.attributes?.stream);
    }
    users.set(id, u);
  }
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const ids = [...users.keys()].sort((a, b) => rank(a) - rank(b));
  return {
    ids,
    live: {
      streamers: ids.filter((id) => users.get(id)!.streaming).map((id) => {
        const q = users.get(id)!.quality;
        return q ? { id, quality: q } : { id };
      }),
      viewers: ids.filter((id) => !users.get(id)!.streaming),
    },
  };
}

export function createRooms(o: {
  /** The SQLite file, ':memory:' for tests; the caller makes sure the directory exists. */
  path: string;
  livekit: RoomService;
  /** CLOSE_EMPTY_SECONDS: how long an empty room stays open. */
  closeEmptySeconds: number;
  /** Dev/E2E have no slash command: admit opens a room for any unknown code. */
  devAutoOpen?: boolean;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}): Rooms {
  const { livekit } = o;
  const registry = openRegistry(o.path);
  const now = o.now ?? Date.now;
  const log = o.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a));
  const emptyMs = o.closeEmptySeconds * 1000;
  // LiveKit keeps an empty room longer than we do (livekit.ts).
  const timeouts = roomTimeouts(o.closeEmptySeconds);
  /** Closed rooms whose deleteRoom failed -> tries so far. */
  const undeleted = new Map<string, number>();

  async function deleteClosed(room: string) {
    try {
      await livekit.deleteRoom(room);
      undeleted.delete(room);
    } catch (e) {
      // Retried on the next polls: a closed room must not stay joinable.
      const tries = (undeleted.get(room) ?? 0) + 1;
      if (tries >= MAX_DELETE_TRIES) undeleted.delete(room);
      else undeleted.set(room, tries);
      log('lifecycle deleteRoom', room, (e as Error).message);
    }
  }

  return {
    async open(r, postCard) {
      const rec = registry.create(r, now());
      try {
        await livekit.ensureRoom(r.room, timeouts);
        const posted = await postCard(rec);
        registry.setMessage(r.room, posted.channelId, posted.messageId);
      } catch (e) {
        // A room without its card would be a link nobody can see the state of.
        registry.close(r.room, now());
        await livekit.deleteRoom(r.room).catch(() => {});
        throw e;
      }
    },

    async admit(room, member) {
      let rec = registry.get(room);
      // Dev/E2E have no slash command: any valid room code opens one (closed stays closed).
      if (!rec && o.devAutoOpen) {
        rec = registry.create({
          room, guildId: '', channelId: '', locale: member.locale, openerId: member.id, openerName: member.name, what: null,
        }, now());
        log('dev room', room);
      }
      if (!rec) return 'unknown';
      // Someone is on the way in: observe must not close it under them.
      // Before the await below, so a poll during it sees the fresh time.
      if (rec.closedAt !== null || !registry.touch(room, now())) return 'closed';
      // LiveKit drops an idle room on its own; auto_create is off, so bring it back.
      try {
        await livekit.ensureRoom(room, timeouts);
      } catch (e) {
        log('ensureRoom failed', room, (e as Error).message);
        return 'media-down';
      }
      // Closed while we waited (e.g. by hand): don't leave a room nobody polls.
      if (registry.get(room)?.closedAt !== null) {
        await livekit.deleteRoom(room).catch((e: unknown) => log('deleteRoom failed', room, (e as Error).message));
        return 'closed';
      }
      return 'ok';
    },

    async observe(room) {
      const rec = registry.get(room);
      if (!rec) return null;
      // Closed since the caller listed it: LiveKit must not get it back.
      if (rec.closedAt !== null) return { record: rec, live: NOBODY };
      const ps = await livekit.listParticipants(room);
      const t = now();
      const { ids, live } = presence(ps, rec.seen);
      if (ids.length) {
        registry.markSeen(room, ids, live.streamers.map((s) => s.id), t);
      } else if (registry.closeIfEmpty(room, t, emptyMs)) {
        // Judged on the stored row: a token minted while LiveKit was asked keeps it open.
        log('room closed', room);
        await deleteClosed(room);
      } else {
        // Still open but empty in LiveKit, maybe gone from it (a LiveKit restart
        // forgets every room). auto_create is off, so the clients' reconnect
        // only works if we bring it back. Idempotent.
        await livekit.ensureRoom(room, timeouts).catch((e: unknown) => log('lifecycle ensureRoom', room, (e as Error).message));
      }
      const cur = registry.get(room)!;
      // Ordered by the updated first-seen list, so newcomers keep their place next poll.
      return { record: cur, live: cur.closedAt === null ? presence(ps, cur.seen).live : NOBODY };
    },

    async retryDeletes() {
      for (const room of [...undeleted.keys()]) await deleteClosed(room);
    },

    openRooms: () => registry.open().map((r) => r.room),
    get: registry.get,
    cardsDue: registry.cardsDue,
    markCardDone: registry.markCardDone,
    closeDb: registry.closeDb,
  };
}

// ---------------------------------------------------------------- registry
// Every valid room comes from open (or a dev admit), and a closed row stays closed.

interface Registry {
  create(r: NewRoom, createdAt: number): RoomRecord;
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

function openRegistry(path: string): Registry {
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
    create(r, createdAt) {
      insertQ.run({ ...r, createdAt });
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
