// Pure parts of the member list (/auth/members): parsing, the Online / Offline
// split against who is in the room, and the visibility-aware poller.
import type { MessageKey } from './i18n';

export type Status = 'online' | 'idle' | 'dnd' | 'offline';
export type Member = { id: string; name: string; avatar: string | null; status: Status };

const STATUSES: readonly Status[] = ['online', 'idle', 'dnd', 'offline'];
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/**
 * The response body, or null when it is not one (the caller keeps what it had).
 * A repeated id keeps its first entry: the list is keyed by id.
 */
export function parseMembers(body: unknown): Member[] | null {
  const list = (body as { members?: unknown } | null)?.members;
  if (!Array.isArray(list)) return null;
  const out: Member[] = [];
  const seen = new Set<string>();
  for (const m of list as Array<Record<string, unknown> | null>) {
    if (!m || typeof m.id !== 'string' || typeof m.name !== 'string' || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      name: m.name,
      avatar: typeof m.avatar === 'string' ? m.avatar : null,
      status: STATUSES.includes(m.status as Status) ? (m.status as Status) : 'offline',
    });
  }
  return out;
}

/** Same order as Telinha: online, idle, do-not-disturb, then by name. */
export function byStatus(a: Member, b: Member): number {
  return STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || collator.compare(a.name, b.name);
}

/** Members not in the room (matched by Discord id), split for the two sections. */
export function splitMembers(
  members: readonly Member[],
  inRoom: ReadonlySet<string>,
): { online: Member[]; offline: Member[] } {
  const rest = members.filter((m) => !inRoom.has(m.id)).sort(byStatus);
  return { online: rest.filter((m) => m.status !== 'offline'), offline: rest.filter((m) => m.status === 'offline') };
}

export const statusKey = (s: Status): MessageKey => `status.${s}`;

export interface Visibility {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', f: () => void): void;
  removeEventListener(type: 'visibilitychange', f: () => void): void;
}
export interface Timers {
  set(f: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (f, ms) => setTimeout(f, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Runs `run` now and then `everyMs` after each run ends, only while the page
 * is visible: hidden pauses it, visible again runs at once. A failed run just
 * waits for the next one. Returns the teardown (aborts a run in flight).
 */
export function poll(
  run: (signal: AbortSignal) => Promise<void>,
  o: { everyMs: number; doc: Visibility; timers?: Timers },
): () => void {
  const timers = o.timers ?? realTimers;
  const ac = new AbortController();
  let timer: unknown = null;
  let running = false;
  const visible = () => o.doc.visibilityState === 'visible';
  const cancel = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };

  async function tick() {
    timer = null;
    if (ac.signal.aborted || running || !visible()) return;
    running = true;
    try {
      await run(ac.signal);
    } catch {
      // offline, Telinha restarting, aborted: the next tick tries again
    }
    running = false;
    if (!ac.signal.aborted && visible() && timer === null) timer = timers.set(() => void tick(), o.everyMs);
  }

  const onVisibility = () => {
    cancel();
    if (visible()) void tick();
  };
  o.doc.addEventListener('visibilitychange', onVisibility);
  void tick();
  return () => {
    ac.abort();
    cancel();
    o.doc.removeEventListener('visibilitychange', onVisibility);
  };
}
