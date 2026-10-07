// Room lifecycle: observes every open room on a timer (rooms.ts records who came
// and closes an empty room for good) and keeps the /telinha message up to date
// as a card, paced and retried, down to the closed card.
import type { Card, Live } from './card.ts';
import type { RoomRecord, Rooms } from './rooms.ts';

export interface LifecycleDeps {
  rooms: Pick<Rooms, 'openRooms' | 'observe' | 'retryDeletes' | 'cardsDue' | 'markCardDone'>;
  render: (rec: RoomRecord, live: Live) => Card;
  /** Throws a DiscordAPIError-like { status, code } on failure. */
  editMessage: (channelId: string, messageId: string, card: Card) => Promise<void>;
  now?: () => number;
  /** Minimum time between two edits of the same message. */
  editGapMs?: number;
  log?: (...a: unknown[]) => void;
}

export interface Lifecycle {
  tick(): Promise<void>;
  /** Ticks every intervalMs, one at a time; returns a stop function. */
  start(intervalMs: number): () => void;
}

const NOBODY: Live = { streamers: [], viewers: [] };
/** Failed edits of one card before giving up on it (backoff doubles up to 64x the gap). */
const MAX_EDIT_FAILS = 10;
// Unknown Channel/Message, Missing Access, Missing Permissions: retrying won't help.
const PERMANENT_CODES = new Set([10003, 10008, 50001, 50013]);

/**
 * An edit that can never work. Retrying those every few seconds would also
 * count towards Discord's invalid-request limit (10k 401/403/429 per 10 min
 * gets the bot's IP banned from the whole API, logins included).
 */
export function isPermanentEditError(e: unknown): boolean {
  const err = e as { status?: unknown; code?: unknown } | null;
  return (
    err?.status === 401 ||
    err?.status === 403 ||
    err?.status === 404 ||
    (typeof err?.code === 'number' && PERMANENT_CODES.has(err.code))
  );
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
  const { rooms, render, editMessage } = deps;
  const now = deps.now ?? Date.now;
  const gap = deps.editGapMs ?? 5000;
  const log = deps.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a));
  const cards = new Map<string, CardState>();
  let running = false;

  function queue(rec: RoomRecord, live: Live) {
    if (!rec.messageId) return;
    let st = cards.get(rec.room);
    if (!st) {
      // /telinha posted the open card with nobody in it.
      st = {
        channelId: rec.channelId,
        messageId: rec.messageId,
        next: 0,
        pending: null,
        fails: 0,
        dead: false,
        closed: false,
        sent: JSON.stringify(render({ ...rec, closedAt: null }, NOBODY)),
      };
      cards.set(rec.room, st);
    }
    st.closed = rec.closedAt !== null;
    const card = render(rec, live);
    const json = JSON.stringify(card);
    st.pending = json === st.sent ? null : { card, json };
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
        rooms.markCardDone(room);
        cards.delete(room);
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await rooms.retryDeletes();
      for (const room of rooms.openRooms()) {
        try {
          const o = await rooms.observe(room);
          if (o) queue(o.record, o.live);
        } catch (e) {
          log('lifecycle error', room, (e as Error).message);
        }
      }
      // Closed cards a restart (or a failed edit) left unsent.
      for (const rec of rooms.cardsDue()) if (!cards.has(rec.room)) queue(rec, NOBODY);
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
