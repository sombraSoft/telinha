// The /livekit signaling proxy end to end: a fake LiveKit on one Bun.serve, the real
// handler (gate + proxy) on another, real WebSocket clients.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { closeCode, createLivekitProxy, type ProxyData } from '../src/proxy.ts';
import { PROD_ENV, setup } from './helpers.ts';

type Frame = string | number[];
const frame = (m: string | ArrayBuffer | Uint8Array): Frame => (typeof m === 'string' ? m : [...new Uint8Array(m)]);

const servers: Server<unknown>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** Echoes WS frames as they came; "close:<code>:<reason>" makes it close; /rtc/validate answers with what it saw. */
function fakeLivekit(o: { upgradeDelayMs?: number } = {}) {
  const http: Array<{ method: string; path: string; search: string; headers: Record<string, string>; body: string }> =
    [];
  const upgrades: Array<{ search: string; cookie: string | null }> = [];
  const got: Frame[] = [];
  const closed: Array<[number, string]> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.headers.get('upgrade')) {
        if (o.upgradeDelayMs) await Bun.sleep(o.upgradeDelayMs);
        upgrades.push({ search: url.search, cookie: req.headers.get('cookie') });
        return srv.upgrade(req, { data: {} }) ? undefined : new Response('no upgrade', { status: 400 });
      }
      const body = await req.text();
      http.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(req.headers),
        body,
      });
      if (url.pathname === '/rtc/validate')
        return Response.json({ path: url.pathname, search: url.search }, { headers: { 'x-from': 'livekit' } });
      if (req.method === 'POST') return new Response(`got ${body}`, { status: 201 });
      return new Response('invalid token', { status: 401 });
    },
    websocket: {
      data: {} as Record<string, never>,
      message(ws, m) {
        got.push(frame(m));
        if (typeof m === 'string' && m.startsWith('close:')) {
          const [, code, reason] = m.split(':');
          ws.close(Number(code), reason);
          return;
        }
        ws.send(m);
      },
      close(_ws, code, reason) {
        closed.push([code, reason]);
      },
    },
  });
  servers.push(server as Server<unknown>);
  return { server, url: `http://127.0.0.1:${server.port}`, http, upgrades, got, closed };
}

/** A port nothing listens on. */
function deadUrl() {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const url = `http://127.0.0.1:${s.port}`;
  s.stop(true);
  return url;
}

/** The real handler with the real proxy in front of `apiUrl` (configUrl: what loadConfig sees, when that must differ). */
function front(apiUrl: string, configUrl = apiUrl) {
  const logs: unknown[][] = [];
  const proxy = createLivekitProxy({ apiUrl, log: (...a) => logs.push(a) });
  let server: Server<ProxyData> | undefined;
  const s = setup({
    env: { ...PROD_ENV, LIVEKIT_API_URL: configUrl },
    proxy,
    upgrade: (req, data) => server!.upgrade(req, { data }),
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => s.handler(req), websocket: proxy.websocket });
  servers.push(server as Server<unknown>);
  const proxyLogs = () => logs.filter((l) => String(l[0]).startsWith('[proxy]'));
  return { s, proxy, port: server.port, cookie: s.sessionCookie(), logs, proxyLogs };
}

function client(url: string, cookie?: string) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
  ws.binaryType = 'arraybuffer';
  const got: Frame[] = [];
  ws.onmessage = (e) => got.push(frame(e.data as string | ArrayBuffer));
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  return { ws, got, opened, closed };
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await Bun.sleep(5);
  }
}

test('closeCode: only codes a close frame may carry', () => {
  for (const ok of [1000, 1001, 1002, 1003, 1007, 1008, 1011, 1014, 3000, 4001, 4999]) expect(closeCode(ok)).toBe(ok);
  for (const bad of [0, 999, 1004, 1006, 1015, 2000, 2999, 5000]) expect([bad, closeCode(bad)]).toEqual([bad, 1011]);
  // closed without a status code: a normal close
  expect(closeCode(1005)).toBe(1000);
});

test('allows: /rtc and below only', () => {
  const { allows } = createLivekitProxy({ apiUrl: 'http://127.0.0.1:1', log: () => {} });
  for (const ok of ['/rtc', '/rtc/', '/rtc/validate', '/rtc/v1', '/rtc/v1/validate'])
    expect([ok, allows(ok)]).toEqual([ok, true]);
  for (const no of ['/', '', '/rtcx', '/RTC', '/twirp/livekit.RoomService/ListRooms', '/rtc/..%2ftwirp', '/rtc%2f..']) {
    expect([no, allows(no)]).toEqual([no, false]);
  }
});

describe('HTTP', () => {
  test('ungated -> 401, nothing reaches LiveKit', async () => {
    const lk = fakeLivekit();
    const f = front(lk.url);
    const r = await fetch(`http://127.0.0.1:${f.port}/livekit/rtc/validate?access_token=AT`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'login' });
    expect(lk.http).toEqual([]);
  });

  test('path, query, status and body pass through; cookie, host and hop-by-hop headers do not', async () => {
    const lk = fakeLivekit();
    const f = front(lk.url);
    const r = await f.s.call(
      new Request('https://telinha.example.com/livekit/rtc/validate?access_token=AT&sdk=js&protocol=15', {
        headers: {
          cookie: f.cookie,
          'x-keep': 'kept',
          'user-agent': 'test-ua',
          connection: 'x-hop',
          'x-hop': 'dropped',
          'proxy-authorization': 'Basic eA==',
          te: 'trailers',
          'keep-alive': 'timeout=5',
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get('x-from')).toBe('livekit');
    expect(await r.json()).toEqual({ path: '/rtc/validate', search: '?access_token=AT&sdk=js&protocol=15' });
    const h = lk.http[0]!.headers;
    expect(h['x-keep']).toBe('kept');
    expect(h['user-agent']).toBe('test-ua');
    expect(h.cookie).toBeUndefined();
    expect(h['x-hop']).toBeUndefined();
    expect(h['proxy-authorization']).toBeUndefined();
    expect(h.te).toBeUndefined();
    expect(h['keep-alive']).toBeUndefined();
    expect(h.host).toBe(`127.0.0.1:${lk.server.port}`);

    const denied = await f.s.call(
      new Request('https://telinha.example.com/livekit/rtc/v1', { headers: { cookie: f.cookie } }),
    );
    expect(denied.status).toBe(401);
    expect(await denied.text()).toBe('invalid token');

    const post = await f.s.call(
      new Request('https://telinha.example.com/livekit/rtc/x', {
        method: 'POST',
        body: 'payload',
        headers: { cookie: f.cookie },
      }),
    );
    expect(post.status).toBe(201);
    expect(await post.text()).toBe('got payload');
    expect(lk.http.at(-1)).toMatchObject({ method: 'POST', path: '/rtc/x', body: 'payload' });
  });

  test('outside /rtc -> 404, nothing reaches LiveKit', async () => {
    const lk = fakeLivekit();
    const f = front(lk.url);
    for (const p of ['/livekit/twirp/livekit.RoomService/ListRooms', '/livekit', '/livekit/rtcx']) {
      const r = await f.s.call(
        new Request(`https://telinha.example.com${p}`, { method: 'POST', headers: { cookie: f.cookie } }),
      );
      expect([p, r.status, await r.json()]).toEqual([p, 404, { error: 'not found' }]);
    }
    // the proxy refuses on its own too
    expect((await f.proxy.fetch(new Request('http://x/'), '/twirp/x', '')).status).toBe(404);
    expect(lk.http).toEqual([]);
  });

  test('LiveKit down -> 502, the token not logged', async () => {
    const f = front(deadUrl());
    const r = await f.s.call(
      new Request('https://telinha.example.com/livekit/rtc/validate?access_token=SECRET', {
        headers: { cookie: f.cookie },
      }),
    );
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'livekit' });
    expect(f.proxyLogs()).toHaveLength(1);
    expect(JSON.stringify(f.logs)).not.toContain('SECRET');
  });
});

describe('WebSocket', () => {
  test('ungated upgrade never reaches LiveKit', async () => {
    const lk = fakeLivekit();
    const f = front(lk.url);
    const c = client(`ws://127.0.0.1:${f.port}/livekit/rtc?access_token=AT`);
    expect(await c.opened).toBe(false);
    await c.closed;
    // a member, but outside the allowlist
    const twirp = client(`ws://127.0.0.1:${f.port}/livekit/twirp/livekit.RoomService/ListRooms`, f.cookie);
    expect(await twirp.opened).toBe(false);
    expect(lk.upgrades).toEqual([]);
  });

  test('text and binary both ways, the query untouched, no cookie upstream, one log line', async () => {
    const lk = fakeLivekit();
    const f = front(lk.url);
    const c = client(`ws://127.0.0.1:${f.port}/livekit/rtc?access_token=SECRET&protocol=15&sdk=js`, f.cookie);
    expect(await c.opened).toBe(true);
    c.ws.send('hello');
    c.ws.send(new Uint8Array([1, 2, 3, 255]));
    await until(() => c.got.length === 2);
    expect(c.got).toEqual(['hello', [1, 2, 3, 255]]);
    expect(lk.got).toEqual(['hello', [1, 2, 3, 255]]);
    expect(lk.upgrades).toEqual([{ search: '?access_token=SECRET&protocol=15&sdk=js', cookie: null }]);
    c.ws.close(1000, 'bye');
    await until(() => lk.closed.length === 1);
    expect(lk.closed).toEqual([[1000, 'bye']]);
    expect(f.proxyLogs()).toEqual([['[proxy] ws close', 'code=1000', 'by=client']]);
    expect(JSON.stringify(f.logs)).not.toContain('SECRET');
  });

  test('messages sent before LiveKit answers arrive, in order', async () => {
    const lk = fakeLivekit({ upgradeDelayMs: 150 });
    const f = front(lk.url);
    const c = client(`ws://127.0.0.1:${f.port}/livekit/rtc`, f.cookie);
    expect(await c.opened).toBe(true);
    expect(lk.upgrades).toEqual([]); // LiveKit has not answered yet: these get queued
    c.ws.send('a');
    c.ws.send(new Uint8Array([2]));
    c.ws.send('c');
    c.ws.send(new Uint8Array([4, 4]));
    await until(() => c.got.length === 4);
    expect(lk.got).toEqual(['a', [2], 'c', [4, 4]]);
    expect(c.got).toEqual(['a', [2], 'c', [4, 4]]);
  });

  test('close code and reason propagate both ways', async () => {
    const lk = fakeLivekit();
    const f = front(lk.url);
    const a = client(`ws://127.0.0.1:${f.port}/livekit/rtc`, f.cookie);
    expect(await a.opened).toBe(true);
    a.ws.send('close:4001:room deleted');
    expect(await a.closed).toEqual({ code: 4001, reason: 'room deleted' });

    const b = client(`ws://127.0.0.1:${f.port}/livekit/rtc`, f.cookie);
    expect(await b.opened).toBe(true);
    b.ws.send('ping');
    await until(() => b.got.length === 1);
    b.ws.close(4002, 'leaving');
    await until(() => lk.closed.length === 2);
    expect(lk.closed).toEqual([
      [4001, 'room deleted'],
      [4002, 'leaving'],
    ]);
    expect(f.proxyLogs()).toEqual([
      ['[proxy] ws close', 'code=4001', 'by=livekit'],
      ['[proxy] ws close', 'code=4002', 'by=client'],
    ]);
  });

  test('LiveKit gone mid-call -> 1011', async () => {
    const lk = fakeLivekit();
    const f = front(lk.url);
    const c = client(`ws://127.0.0.1:${f.port}/livekit/rtc`, f.cookie);
    expect(await c.opened).toBe(true);
    c.ws.send('x');
    await until(() => c.got.length === 1);
    lk.server.stop(true);
    expect((await c.closed).code).toBe(1011);
  });

  test('LiveKit unreachable -> 1011 "livekit unreachable"', async () => {
    const f = front(deadUrl());
    const c = client(`ws://127.0.0.1:${f.port}/livekit/rtc`, f.cookie);
    expect(await c.opened).toBe(true);
    expect(await c.closed).toEqual({ code: 1011, reason: 'livekit unreachable' });
    expect(f.proxyLogs()).toHaveLength(1);
  });

  test('a URL the WebSocket constructor rejects -> 1011, the token never logged', async () => {
    // Bun's error message quotes the whole upstream URL, query (access token) included.
    for (const bad of ['ftp://x', 'http://bad host']) {
      const f = front(bad, 'http://127.0.0.1:7880');
      const c = client(`ws://127.0.0.1:${f.port}/livekit/rtc?access_token=S3CR3T`, f.cookie);
      expect(await c.opened).toBe(true);
      expect(await c.closed).toEqual({ code: 1011, reason: 'livekit unreachable' });
      expect(f.proxyLogs()).toHaveLength(1);
      expect(JSON.stringify(f.logs)).not.toContain('S3CR3T');
    }
  });

  test('more than 1 MiB before LiveKit answers -> 1009, nothing forwarded', async () => {
    const lk = fakeLivekit({ upgradeDelayMs: 300 });
    const f = front(lk.url);
    const c = client(`ws://127.0.0.1:${f.port}/livekit/rtc`, f.cookie);
    expect(await c.opened).toBe(true);
    c.ws.send(new Uint8Array(600 * 1024));
    c.ws.send(new Uint8Array(600 * 1024));
    expect((await c.closed).code).toBe(1009);
    await Bun.sleep(400);
    expect(lk.got).toEqual([]);
  });
});
