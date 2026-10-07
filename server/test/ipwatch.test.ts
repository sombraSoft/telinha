import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIpWatch } from '../src/ipwatch.ts';

const TRACE = 'https://1.1.1.1/cdn-cgi/trace';
const IPIFY = 'https://api.ipify.org';
const trace = (ip: string) => `fl=123\nh=1.1.1.1\nip=${ip}\nts=1700000000.1\nvisit_scheme=https\n`;

type Reply = string | Error | { status: number };
/** Each URL answers from its own queue; the last entry repeats. */
function fakeFetch(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    signals.push(init?.signal);
    const q = replies[url] ?? [new Error('no route')];
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    if (typeof r === 'string') return new Response(r);
    return new Response('', { status: r.status });
  };
  return { fetch: fn as unknown as typeof fetch, calls, signals, replies };
}

const SELF = { changed: 'restarting livekit', startedWith: 'livekit started with the new one' };
const CLOUD = { changed: 'nothing to restart', startedWith: 'nothing to restart' };

function watch(
  replies: Record<string, Reply[]>,
  o: {
    statePath?: string;
    onChange?: (ip: string, prev: string) => Promise<void>;
    labels?: { changed: string; startedWith: string };
  } = {},
) {
  const f = fakeFetch(replies);
  const logs: unknown[][] = [];
  const changes: [string, string][] = [];
  const w = createIpWatch({
    fetch: f.fetch,
    intervalMs: 60_000,
    log: (...a) => logs.push(a),
    statePath: o.statePath,
    labels: o.labels ?? SELF,
    onChange: async (ip, prev) => {
      changes.push([ip, prev]);
      await o.onChange?.(ip, prev);
    },
  });
  return { w, f, logs, changes };
}

const tmp = mkdtempSync(join(tmpdir(), 'telinha-ipwatch-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('createIpWatch', () => {
  test('reads ip= from the trace, with a timeout signal', async () => {
    const { w, f } = watch({ [TRACE]: [trace('203.0.113.7')] });
    await w.check();
    expect(w.current()).toBe('203.0.113.7');
    expect(f.calls).toEqual([TRACE]);
    expect(f.signals[0]).toBeInstanceOf(AbortSignal);
  });

  test('first source fails -> second used', async () => {
    const { w, f } = watch({ [TRACE]: [new Error('down')], [IPIFY]: ['198.51.100.4\n'] });
    await w.check();
    expect(w.current()).toBe('198.51.100.4');
    expect(f.calls).toEqual([TRACE, IPIFY]);
  });

  test('HTTP error on the first source -> second used', async () => {
    const { w } = watch({ [TRACE]: [{ status: 503 }], [IPIFY]: ['198.51.100.4'] });
    await w.check();
    expect(w.current()).toBe('198.51.100.4');
  });

  test('non-IPv4 answers are rejected', async () => {
    const { w, logs } = watch({ [TRACE]: [trace('2001:db8::1')], [IPIFY]: ['<html>oops</html>'] });
    await w.check();
    expect(w.current()).toBeNull();
    expect(logs).toHaveLength(1);
    const { w: w2 } = watch({ [TRACE]: [trace('999.1.1.1')], [IPIFY]: ['198.51.100.4'] });
    await w2.check();
    expect(w2.current()).toBe('198.51.100.4');
  });

  test('no onChange on the first observation; a change triggers it once', async () => {
    const { w, changes, logs } = watch({ [TRACE]: [trace('203.0.113.7'), trace('203.0.113.7'), trace('203.0.113.9')] });
    await w.check();
    await w.check();
    expect(changes).toEqual([]);
    await w.check();
    await w.check();
    expect(changes).toEqual([['203.0.113.9', '203.0.113.7']]);
    expect(w.current()).toBe('203.0.113.9');
    expect(logs).toContainEqual(['public IP 203.0.113.7 -> 203.0.113.9, restarting livekit']);
  });

  test('onChange rejection keeps the old IP and retries next tick', async () => {
    let fail = true;
    const { w, changes } = watch(
      { [TRACE]: [trace('203.0.113.7'), trace('203.0.113.9')] },
      {
        onChange: async () => {
          if (fail) throw new Error('restart failed');
        },
      },
    );
    await w.check();
    await w.check();
    expect(changes).toHaveLength(1);
    expect(w.current()).toBe('203.0.113.7');
    fail = false;
    await w.check();
    expect(changes).toEqual([
      ['203.0.113.9', '203.0.113.7'],
      ['203.0.113.9', '203.0.113.7'],
    ]);
    expect(w.current()).toBe('203.0.113.9');
    await w.check();
    expect(changes).toHaveLength(2);
  });

  test('network failure is logged once per streak', async () => {
    const down = new Error('offline');
    const { w, logs } = watch({
      [TRACE]: [down, down, down, trace('203.0.113.7'), down],
      [IPIFY]: [down, down, down, down],
    });
    await w.check();
    await w.check();
    await w.check();
    expect(logs).toHaveLength(1);
    expect(String(logs[0]![0])).toContain('lookup failed');
    await w.check();
    expect(w.current()).toBe('203.0.113.7');
    await w.check();
    expect(logs).toHaveLength(2);
    expect(w.current()).toBe('203.0.113.7');
  });

  test('concurrent checks share one lookup', async () => {
    const { w, f } = watch({ [TRACE]: [trace('203.0.113.7')] });
    await Promise.all([w.check(), w.check()]);
    expect(f.calls).toHaveLength(1);
  });

  test('state file round trip', async () => {
    const statePath = join(tmp, 'run', 'public-ip');
    const a = watch({ [TRACE]: [trace('203.0.113.7')] }, { statePath });
    expect(a.w.current()).toBeNull();
    await a.w.check();
    expect(readFileSync(statePath, 'utf8')).toBe('203.0.113.7\n');

    // A restarted telinha remembers the IP for current(), but a change while it was
    // down restarts nothing: livekit ran STUN at start and already has the new one.
    const b = watch({ [TRACE]: [trace('203.0.113.9'), trace('203.0.113.9'), trace('203.0.113.11')] }, { statePath });
    expect(b.w.current()).toBe('203.0.113.7');
    await b.w.check();
    expect(b.changes).toEqual([]);
    expect(b.w.current()).toBe('203.0.113.9');
    expect(readFileSync(statePath, 'utf8')).toBe('203.0.113.9\n');
    expect(b.logs).toContainEqual([
      'public IP 203.0.113.7 -> 203.0.113.9 while telinha was down, livekit started with the new one',
    ]);
    await b.w.check();
    expect(b.changes).toEqual([]);
    // From then on a change in this process restarts livekit as usual.
    await b.w.check();
    expect(b.changes).toEqual([['203.0.113.11', '203.0.113.9']]);
    expect(readFileSync(statePath, 'utf8')).toBe('203.0.113.11\n');

    // Same IP as persisted: nothing logged, nothing restarted.
    const c = watch({ [TRACE]: [trace('203.0.113.11')] }, { statePath });
    await c.w.check();
    expect(c.changes).toEqual([]);
    expect(c.logs).toEqual([]);
  });

  test('the labels name what a change does, live and while telinha was down', async () => {
    for (const [labels, changed, startedWith] of [
      [SELF, 'restarting livekit', 'livekit started with the new one'],
      [CLOUD, 'nothing to restart', 'nothing to restart'],
    ] as const) {
      const statePath = join(tmp, `labels-${labels === SELF ? 'self' : 'cloud'}`, 'public-ip');
      const a = watch({ [TRACE]: [trace('203.0.113.7')] }, { statePath, labels });
      await a.w.check();
      const b = watch({ [TRACE]: [trace('203.0.113.9'), trace('203.0.113.11')] }, { statePath, labels });
      await b.w.check();
      await b.w.check();
      expect(b.logs).toEqual([
        [`public IP 203.0.113.7 -> 203.0.113.9 while telinha was down, ${startedWith}`],
        [`public IP 203.0.113.9 -> 203.0.113.11, ${changed}`],
      ]);
      expect(b.changes).toEqual([['203.0.113.11', '203.0.113.9']]);
    }
  });

  test('a missing or garbage state file means no IP yet', () => {
    expect(watch({}, { statePath: join(tmp, 'nope', 'public-ip') }).w.current()).toBeNull();
    expect(existsSync(join(tmp, 'nope'))).toBe(false);
    const garbage = join(tmp, 'garbage-ip');
    writeFileSync(garbage, 'not an ip\n');
    expect(watch({}, { statePath: garbage }).w.current()).toBeNull();
  });

  test('start() checks at once and returns a stop function', async () => {
    const { w, f } = watch({ [TRACE]: [trace('203.0.113.7')] });
    const stop = w.start();
    await Bun.sleep(10);
    stop();
    expect(f.calls).toEqual([TRACE]);
    expect(w.current()).toBe('203.0.113.7');
  });
});
