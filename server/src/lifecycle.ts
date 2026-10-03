// Room lifecycle: polls LiveKit for every open room, records who came, closes a
// room for good after it sat empty for CLOSE_EMPTY_SECONDS (counted from /telinha
// when nobody ever joined) and keeps the /telinha message up to date as a card.
import { TrackSource } from 'livekit-server-sdk';
import type { Card, Live } from './card.ts';
import type { LiveParticipant, RoomService } from './livekit.ts';
import type { Registry, RoomRecord } from './rooms.ts';

export interface LifecycleDeps {
  registry: Registry;
  rooms: Pick<RoomService, 'listParticipants' | 'deleteRoom' | 'ensureRoom'>;
  render: (rec: RoomRecord, live: Live) => Card;
  /** Throws a DiscordAPIError-like { status, code } on failure. */
  editMessage: (channelId: string, messageId: string, card: Card) => Promise<void>;
  now?: () => number;
  closeEmptyMs: number;
  /** Minimum time between two edits of the same message. */
  editGapMs?: number;
  log?: (...a: unknown[]) => void;
}

export interface Lifecycle {
  tick(): Promise<void>;
  /** Ticks every intervalMs, one at a time; returns a stop function. */
  start(intervalMs: number): () => void;
}

const DISCORD_ID = /^\d{1,20}$/;
const NOBODY: Live = { streamers: [], viewers: [] };
/** Failed edits of one card before giving up on it (backoff doubles up to 64x the gap). */
const MAX_EDIT_FAILS = 10;
/** Ticks a failed deleteRoom of a closed room is retried for. */
const MAX_DELETE_TRIES = 12;
// Unknown Channel/Message, Missing Access, Missing Permissions: retrying won't help.
const PERMANENT_CODES = new Set([10003, 10008, 50001, 50013]);

/**
 * An edit that can never work. Retrying those every few seconds would also
 * count towards Discord's invalid-request limit (10k 401/403/429 per 10 min
 * gets the bot's IP banned from the whole API, logins included).
 */
export function isPermanentEditError(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown } | null;
  return err?.status === 401 || err?.status === 403 || err?.status === 404
    || (typeof err?.code === 'number' && PERMANENT_CODES.has(err.code));
}

/** The page writes e.g. "1080p60 · H265"; anything else is not shown. */
export function cleanQuality(v: string | undefined): string | undefined {
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
export function presence(ps: LiveParticipant[], order: string[]): { ids: string[]; live: Live } {
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

interface CardState {
  channelId: string;
  messageId: string;
  /** JSON of the payload Discord shows now. */
  sent: string;
  /** Earliest time of the next edit. */
  next: number;
  pending: { card: Card; json: string } | null;
  /** Failed edits in a row. */
  fails: number;
  /** The message is gone (or can't be edited): leave it alone. */
  dead: boolean;
  closed: boolean;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { registry, rooms, render, editMessage, closeEmptyMs } = deps;
  const now = deps.now ?? Date.now;
  const gap = deps.editGapMs ?? 5000;
  const log = deps.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a));
  const cards = new Map<string, CardState>();
  /** Closed rooms whose deleteRoom failed -> tries so far. */
  const undeleted = new Map<string, number>();
  let running = false;

  async function deleteRoom(room: string) {
    try {
      await rooms.deleteRoom(room);
      undeleted.delete(room);
    } catch (e) {
      // Retried on the next ticks: a closed room must not stay joinable.
      const tries = (undeleted.get(room) ?? 0) + 1;
      if (tries >= MAX_DELETE_TRIES) undeleted.delete(room);
      else undeleted.set(room, tries);
      log('lifecycle deleteRoom', room, (e as Error).message);
    }
  }

  function queue(rec: RoomRecord, live: Live) {
    if (!rec.messageId) return;
    let st = cards.get(rec.room);
    if (!st) {
      // /telinha posted the open card with nobody in it.
      st = {
        channelId: rec.channelId, messageId: rec.messageId, next: 0, pending: null, fails: 0, dead: false, closed: false,
        sent: JSON.stringify(render({ ...rec, closedAt: null }, NOBODY)),
      };
      cards.set(rec.room, st);
    }
    st.closed = rec.closedAt !== null;
    const card = render(rec, live);
    const json = JSON.stringify(card);
    st.pending = json === st.sent ? null : { card, json };
  }

  async function step(rec: RoomRecord) {
    const ps = await rooms.listParticipants(rec.room);
    const t = now();
    const { ids, live } = presence(ps, rec.seen);
    if (ids.length) {
      registry.markSeen(rec.room, ids, live.streamers.map((s) => s.id), t);
    } else if (registry.closeIfEmpty(rec.room, t, closeEmptyMs)) {
      // Judged on the stored row: a token minted since registry.open() keeps it open.
      log('room closed', rec.room);
      await deleteRoom(rec.room);
    } else {
      // Still open but empty in LiveKit, maybe gone from it (a LiveKit restart
      // forgets every room). auto_create is off, so the clients' reconnect
      // only works if we bring it back. Idempotent.
      await rooms.ensureRoom(rec.room).catch((e: unknown) => log('lifecycle ensureRoom', rec.room, (e as Error).message));
    }
    const cur = registry.get(rec.room);
    // Ordered by the updated first-seen list, so newcomers keep their place next poll.
    if (cur) queue(cur, cur.closedAt === null ? presence(ps, cur.seen).live : NOBODY);
  }

  async function flush() {
    for (const [room, st] of cards) {
      if (st.pending && !st.dead && now() >= st.next) {
        const { card, json } = st.pending;
        try {
          await editMessage(st.channelId, st.messageId, card);
          st.sent = json;
          st.pending = null;
          st.fails = 0;
          st.next = now() + gap;
        } catch (e) {
          st.fails++;
          if (isPermanentEditError(e) || st.fails >= MAX_EDIT_FAILS) {
            st.dead = true;
            log('card not editable, giving up on it', room, (e as Error).message);
          } else {
            log('card edit failed', room, (e as Error).message);
            st.next = now() + gap * 2 ** Math.min(st.fails - 1, 6);
          }
        }
      }
      if (st.closed && (st.dead || !st.pending)) {
        // Persisted, so a restart before this point still sends the closed card.
        registry.markCardDone(room);
        cards.delete(room);
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      for (const room of [...undeleted.keys()]) await deleteRoom(room);
      for (const rec of registry.open()) {
        try {
          await step(rec);
        } catch (e) {
          log('lifecycle error', rec.room, (e as Error).message);
        }
      }
      // Closed cards a restart (or a failed edit) left unsent.
      for (const rec of registry.cardsDue()) if (!cards.has(rec.room)) queue(rec, NOBODY);
      await flush();
    } catch (e) {
      log('lifecycle error', (e as Error).message);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start(intervalMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      // A chain of timeouts, not setInterval: a slow tick delays the next one.
      const loop = async () => {
        await tick();
        if (!stopped) timer = setTimeout(loop, intervalMs);
      };
      timer = setTimeout(loop, intervalMs);
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}
