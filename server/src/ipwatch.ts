// LiveKit resolves the public IP once at start (STUN) and advertises it in ICE
// candidates. When a residential IP changes, onChange restarts livekit so
// streams keep working (and renews router mappings and DuckDNS, which a cloud
// install needs too).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { IPV4_RE } from './config.ts';
import { lookupPublicIp } from './netinfo.ts';

export interface IpWatch {
  /** Checks now, then every intervalMs; returns a stop function. */
  start(): () => void;
  check(): Promise<void>;
  current(): string | null;
}

const TIMEOUT_MS = 10_000;

export function createIpWatch(o: {
  fetch: typeof fetch; intervalMs: number; log: (...a: unknown[]) => void;
  onChange: (ip: string, previous: string) => Promise<void>;
  /** What a change means here, for the log: a cloud install has no livekit to restart. */
  labels: { changed: string; startedWith: string };
  /** <run>/public-ip; remembers the last IP across restarts (for current(): /internal/status). */
  statePath?: string;
}): IpWatch {
  let ip = readState(o.statePath);
  // False until a lookup succeeded in this process. The persisted IP is never a
  // reason to restart livekit: it ran STUN itself when telinha started, so it
  // already has whatever IP we see first.
  let observed = false;
  let failing = false;
  let running: Promise<void> | null = null;

  const lookup = () => lookupPublicIp(o.fetch, TIMEOUT_MS);

  const persist = (value: string) => {
    if (!o.statePath) return;
    try {
      mkdirSync(dirname(o.statePath), { recursive: true });
      writeFileSync(o.statePath, `${value}\n`);
    } catch (e) {
      o.log('ipwatch: could not save the public IP', (e as Error).message);
    }
  };

  const run = async () => {
    let found: string;
    try {
      found = await lookup();
    } catch (e) {
      // Once per failure streak: a long outage must not flood the log.
      if (!failing) o.log('ipwatch: public IP lookup failed, retrying next tick', (e as Error).message);
      failing = true;
      return;
    }
    failing = false;
    if (!observed) {
      // First observation: LiveKit just started with this IP, nothing to restart.
      observed = true;
      if (found === ip) return;
      if (ip !== null) o.log(`public IP ${ip} -> ${found} while telinha was down, ${o.labels.startedWith}`);
      ip = found;
      persist(found);
      return;
    }
    if (found === ip) return;
    const previous = ip!;
    o.log(`public IP ${previous} -> ${found}, ${o.labels.changed}`);
    try {
      await o.onChange(found, previous);
    } catch (e) {
      // Keep the old IP so the next tick sees the change again and retries.
      o.log('ipwatch: handling the IP change failed, will retry', (e as Error).message);
      return;
    }
    ip = found;
    persist(found);
  };

  // One check at a time: start()'s tick and a manual check() share the run.
  const check = () => {
    running ??= run().finally(() => { running = null; });
    return running;
  };

  return {
    check,
    current: () => ip,
    start() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      // A chain of timeouts, not setInterval: a slow check delays the next one.
      const loop = async () => {
        await check();
        if (!stopped) timer = setTimeout(loop, o.intervalMs);
      };
      void loop();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}

function readState(path: string | undefined): string | null {
  if (!path) return null;
  try {
    const v = readFileSync(path, 'utf8').trim();
    return IPV4_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}
