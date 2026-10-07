// Role members and their Discord status for the people list, refreshed every
// 15 s while the tab is visible. Errors keep the last good list.
import { type Member, parseMembers, poll } from './members';

const EVERY_MS = 15_000;
const TIMEOUT_MS = 10_000;

export class MembersFeed {
  list = $state.raw<Member[]>([]);

  /** Starts polling; returns the teardown. */
  start(): () => void {
    return poll(
      async (signal) => {
        // A hung request would stall the poller: give up and wait for the next tick.
        // By hand where AbortSignal.any is missing (Safari < 17.4).
        const ac = new AbortController();
        const stop = () => ac.abort();
        signal.addEventListener('abort', stop);
        const timer = setTimeout(stop, TIMEOUT_MS);
        try {
          const r = await fetch('/auth/members', { signal: ac.signal });
          // Logged out or the role is gone: stop showing the directory.
          if (r.status === 401 || r.status === 403) {
            this.list = [];
            return;
          }
          if (!r.ok) return;
          const list = parseMembers(await r.json());
          if (list) this.list = list;
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
        }
      },
      { everyMs: EVERY_MS, doc: document },
    );
  }
}
