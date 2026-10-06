import { describe, expect, test } from 'bun:test';
import { createDuckDns, startDdnsLoop, type Ddns, type DdnsLast } from '../src/ddns.ts';

const TOKEN = 'fake-duckdns-token-0000'; // gitleaks:allow

function duck(replies: (string | Error | number)[]) {
  const urls: string[] = [];
  const logs: string[] = [];
  let t = 1000;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const r = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('', { status: r });
    return new Response(r);
  }) as unknown as typeof globalThis.fetch;
  const d = createDuckDns({ domain: 'mygroup', token: TOKEN, fetch, log: (...a) => logs.push(a.join(' ')), now: () => t });
  return { d, urls, logs, tick: (ms: number) => (t += ms) };
}

describe('createDuckDns', () => {
  test('OK: calls the update URL and logs the new address once', async () => {
    const { d, urls, logs } = duck(['OK\n203.0.113.7\n\nUPDATED']);
    await d.update('203.0.113.7');
    expect(urls[0]).toBe(`https://www.duckdns.org/update?domains=mygroup&token=${TOKEN}&ip=203.0.113.7&verbose=true`);
    expect(d.last()).toEqual({ ip: '203.0.113.7', at: 1000, ok: true });
    expect(logs).toEqual(['ddns: mygroup.duckdns.org -> 203.0.113.7']);
    await d.update('203.0.113.7');
    expect(logs).toHaveLength(1);
  });

  test('KO: failure recorded and logged once per streak, never with the token', async () => {
    const { d, logs } = duck(['KO', 'KO', 'KO', 'OK']);
    await d.update('203.0.113.7');
    await d.update('203.0.113.7');
    await d.update('203.0.113.7');
    expect(d.last()).toMatchObject({ ok: false, error: 'DuckDNS rejected the domain/token' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('rejected');
    await d.update('203.0.113.7');
    expect(d.last()?.ok).toBe(true);
    // Recovery is logged even though the IP did not change.
    expect(logs).toHaveLength(2);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  test('network errors never leak the token', async () => {
    const { d, logs } = duck([new Error(`connect failed: https://www.duckdns.org/update?token=${TOKEN}`)]);
    await d.update('203.0.113.7');
    expect(d.last()?.error).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs[0]).toContain('***');
  });

  test('HTTP errors and odd bodies are failures', async () => {
    const a = duck([500]);
    await a.d.update('1.2.3.4');
    expect(a.d.last()).toMatchObject({ ok: false, error: 'HTTP 500' });
    const b = duck(['<html>']);
    await b.d.update('1.2.3.4');
    expect(b.d.last()?.ok).toBe(false);
  });

  test('an IP change is logged', async () => {
    const { d, logs } = duck(['OK']);
    await d.update('203.0.113.7');
    await d.update('203.0.113.8');
    expect(logs).toEqual(['ddns: mygroup.duckdns.org -> 203.0.113.7', 'ddns: mygroup.duckdns.org -> 203.0.113.8']);
  });
});

/** Fake clock: sleep() parks until step() moves time forward. */
function clock() {
  let t = 0;
  const waits: { ms: number; resolve: () => void }[] = [];
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((resolve) => waits.push({ ms, resolve })),
    waits,
    flush,
    async step() {
      await flush();
      const w = waits.shift();
      if (!w) throw new Error('loop is not sleeping');
      t += w.ms;
      w.resolve();
      await flush();
    },
  };
}

function fakeDdns(c: { now: () => number }, okFor: (ip: string) => boolean = () => true) {
  let last: DdnsLast | null = null;
  const updates: string[] = [];
  const ddns: Ddns = {
    last: () => last,
    async update(ip) {
      updates.push(ip);
      last = { ip, at: c.now(), ok: okFor(ip) };
    },
  };
  return { ddns, updates };
}

describe('startDdnsLoop', () => {
  test('updates at start and when the looked-up IP changes', async () => {
    const c = clock();
    const { ddns, updates } = fakeDdns(c);
    const ips = ['1.1.1.1', '1.1.1.1', '2.2.2.2', '2.2.2.2'];
    let lookups = 0;
    const stop = startDdnsLoop({ ddns, lookupIp: async () => ips[Math.min(lookups++, ips.length - 1)]!, log: () => {}, sleep: c.sleep, now: c.now });
    await c.flush();
    expect(updates).toEqual(['1.1.1.1']);
    await c.step();
    expect(updates).toEqual(['1.1.1.1']);
    expect(c.waits[0]?.ms).toBe(300_000);
    await c.step();
    expect(updates).toEqual(['1.1.1.1', '2.2.2.2']);
    await c.step();
    expect(updates).toHaveLength(2);
    expect(lookups).toBe(4);
    stop();
  });

  test('retries after a failed update even if the IP is the same', async () => {
    const c = clock();
    let fail = true;
    const { ddns, updates } = fakeDdns(c, () => !fail);
    const stop = startDdnsLoop({ ddns, lookupIp: async () => '1.1.1.1', log: () => {}, sleep: c.sleep, now: c.now });
    await c.flush();
    fail = false;
    await c.step();
    await c.step();
    expect(updates).toEqual(['1.1.1.1', '1.1.1.1']);
    stop();
  });

  test('keeps the record alive every 24 h', async () => {
    const c = clock();
    const { ddns, updates } = fakeDdns(c);
    const stop = startDdnsLoop({ ddns, lookupIp: async () => '1.1.1.1', intervalMs: 3600_000, log: () => {}, sleep: c.sleep, now: c.now });
    await c.flush();
    for (let h = 1; h < 24; h++) await c.step();
    expect(updates).toHaveLength(1);
    await c.step();
    expect(updates).toHaveLength(2);
    stop();
  });

  test('fixedIp: no lookups, update at start and once a day', async () => {
    const c = clock();
    const { ddns, updates } = fakeDdns(c);
    let lookups = 0;
    const stop = startDdnsLoop({
      ddns, fixedIp: '9.9.9.9', lookupIp: async () => { lookups++; return 'x'; }, log: () => {}, sleep: c.sleep, now: c.now,
    });
    await c.flush();
    expect(updates).toEqual(['9.9.9.9']);
    for (let i = 0; i < 288; i++) await c.step(); // 24 h of 5-min ticks
    expect(updates).toEqual(['9.9.9.9', '9.9.9.9']);
    expect(lookups).toBe(0);
    stop();
  });

  test('a failed lookup is logged once per streak and skips the update', async () => {
    const c = clock();
    const { ddns, updates } = fakeDdns(c);
    const logs: unknown[][] = [];
    let n = 0;
    const stop = startDdnsLoop({
      ddns, lookupIp: async () => { if (n++ < 3) throw new Error('offline'); return '1.1.1.1'; },
      log: (...a) => logs.push(a), sleep: c.sleep, now: c.now,
    });
    await c.flush();
    await c.step();
    await c.step();
    expect(updates).toEqual([]);
    expect(logs).toHaveLength(1);
    await c.step();
    expect(updates).toEqual(['1.1.1.1']);
    stop();
  });

  test('stop() ends the loop', async () => {
    const c = clock();
    const { ddns } = fakeDdns(c);
    let lookups = 0;
    const stop = startDdnsLoop({ ddns, lookupIp: async () => { lookups++; return '1.1.1.1'; }, log: () => {}, sleep: c.sleep, now: c.now });
    await c.flush();
    stop();
    await c.step();
    expect(lookups).toBe(1);
    expect(c.waits).toHaveLength(0);
  });

  test('real timers: stop() clears the pending timeout', async () => {
    const { ddns, updates } = fakeDdns({ now: Date.now });
    const stop = startDdnsLoop({ ddns, lookupIp: async () => '1.1.1.1', intervalMs: 10, log: () => {} });
    await Bun.sleep(5);
    stop();
    const n = updates.length;
    await Bun.sleep(40);
    expect(updates.length).toBe(n);
    expect(n).toBe(1);
  });
});
