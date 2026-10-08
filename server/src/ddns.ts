// DuckDNS keeps <domain>.duckdns.org pointing at a residential IP. It runs on
// its own loop: ipwatch only runs for MEDIA=self without LIVEKIT_NODE_IP, and the
// record must stay fresh regardless.
export interface DdnsLast {
  ip: string;
  at: number;
  ok: boolean;
  /** Why the last call failed; never contains the token. */
  error?: string;
}

export interface Ddns {
  /** Never throws: the outcome is in last(). */
  update(ip: string): Promise<void>;
  last(): DdnsLast | null;
}

type Log = (...a: unknown[]) => void;

const TIMEOUT_MS = 10_000;
/** last().error when DuckDNS answered KO: the name is not on the token's account, or the token is wrong. */
export const DUCKDNS_REJECTED = 'DuckDNS rejected the domain/token';
const DAY_MS = 24 * 3600_000;

export function createDuckDns(o: {
  /** Bare subdomain, without .duckdns.org. */
  domain: string;
  token: string;
  fetch: typeof fetch;
  log: Log;
  now?: () => number;
}): Ddns {
  const now = o.now ?? Date.now;
  const name = `${o.domain}.duckdns.org`;
  let last: DdnsLast | null = null;
  let failing = false;

  // The URL carries the token: it is never logged, and neither is an error
  // message that might quote it.
  const scrub = (s: string) => (o.token ? s.split(o.token).join('***') : s);

  const call = async (ip: string): Promise<void> => {
    const url = `https://www.duckdns.org/update?domains=${encodeURIComponent(o.domain)}&token=${encodeURIComponent(o.token)}&ip=${encodeURIComponent(ip)}&verbose=true`;
    const res = await o.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.text()).trim();
    if (body.startsWith('OK')) return;
    if (body.startsWith('KO')) throw new Error(DUCKDNS_REJECTED);
    throw new Error(`unexpected DuckDNS answer: ${body.slice(0, 20)}`);
  };

  return {
    last: () => last,
    async update(ip) {
      const previous = last;
      try {
        await call(ip);
      } catch (e) {
        const error = scrub((e as Error).message);
        last = { ip, at: now(), ok: false, error };
        // Once per failure streak: a long outage must not flood the log.
        if (!failing) o.log(`ddns: updating ${name} failed, will retry: ${error}`);
        failing = true;
        return;
      }
      last = { ip, at: now(), ok: true };
      if (failing || !previous?.ok || previous.ip !== ip) o.log(`ddns: ${name} -> ${ip}`);
      failing = false;
    },
  };
}

/**
 * Looks the public IP up every intervalMs and updates DuckDNS when it changed or
 * the last update failed, and at least once a day so the record stays alive.
 * With fixedIp (LIVEKIT_NODE_IP) there is nothing to look up. Returns stop().
 */
export function startDdnsLoop(o: {
  ddns: Ddns;
  lookupIp: () => Promise<string>;
  intervalMs?: number;
  fixedIp?: string;
  log: Log;
  /** Tests: a fake clock. Without it a chain of setTimeouts is used. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): () => void {
  const intervalMs = o.intervalMs ?? 300_000;
  const now = o.now ?? Date.now;
  let stopped = false;
  let lookupFailing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const wait = (ms: number): Promise<void> => {
    if (o.sleep) return o.sleep(ms);
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    });
  };

  const tick = async () => {
    let ip: string;
    if (o.fixedIp) {
      ip = o.fixedIp;
    } else {
      try {
        ip = await o.lookupIp();
      } catch (e) {
        if (!lookupFailing) o.log('ddns: public IP lookup failed, retrying next tick', (e as Error).message);
        lookupFailing = true;
        return;
      }
      lookupFailing = false;
    }
    const last = o.ddns.last();
    if (!last?.ok || last.ip !== ip || now() - last.at >= DAY_MS) await o.ddns.update(ip);
  };

  // A chain, not setInterval: a slow lookup or update delays the next tick.
  void (async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        o.log('ddns: tick failed', (e as Error).message);
      }
      if (stopped) break;
      await wait(intervalMs);
    }
  })();

  return () => {
    stopped = true;
    clearTimeout(timer);
    wake?.();
  };
}
