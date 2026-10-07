import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ControlStatus,
  ControlUnavailableError,
  controlBaseUrl,
  createControlClient,
} from '../src/cli/control.ts';

const TOK = 'a1'.repeat(32);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(o: { token?: string; envFile?: string } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'telinha-control-'));
  dirs.push(h);
  const run = join(h, 'data', 'run');
  mkdirSync(run, { recursive: true });
  mkdirSync(join(h, 'config'), { recursive: true });
  if (o.token) writeFileSync(join(run, 'control.token'), `${o.token}\n`);
  const envFile = join(h, 'config', 'telinha.env');
  if (o.envFile !== undefined) writeFileSync(envFile, o.envFile);
  return { paths: { run }, envFile };
}

type Call = { url: string; method: string; auth: string | null; body: unknown };
function fakeFetch(respond: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const c = {
      url,
      method: init?.method ?? 'GET',
      auth: h.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    return respond(c);
  };
  return { fetch, calls };
}

const STATUS: ControlStatus = {
  version: '0.7.0',
  startedAt: 1,
  pid: 42,
  ingress: 'direct',
  media: 'self',
  rooms: 0,
  children: { livekit: 'up' },
  childStatus: { livekit: { state: 'up', pid: 7, restarts: 0, recentRestarts: 0, since: 1 } },
  publicIp: null,
  upnp: null,
  ddns: null,
  update: null,
  supervised: true,
};

describe('controlBaseUrl', () => {
  test('LISTEN from telinha.env; wildcard hosts become loopback; IPv6 bracketed', () => {
    expect(controlBaseUrl(home({ envFile: 'LISTEN=0.0.0.0:9000\n' }).envFile, {})).toBe('http://127.0.0.1:9000');
    expect(controlBaseUrl(home({ envFile: 'LISTEN=[::1]:9001\n' }).envFile, {})).toBe('http://[::1]:9001');
    expect(controlBaseUrl(home().envFile, {})).toBe('http://127.0.0.1:8081');
  });

  test('the process environment wins over the file, and works with no file (Docker)', () => {
    expect(controlBaseUrl(home({ envFile: 'LISTEN=127.0.0.1:9000\n' }).envFile, { LISTEN: '127.0.0.1:9100' })).toBe(
      'http://127.0.0.1:9100',
    );
    expect(controlBaseUrl(home().envFile, { LISTEN: '0.0.0.0:8082' })).toBe('http://127.0.0.1:8082');
    // An empty variable does not override (mergeEnv's rule).
    expect(controlBaseUrl(home({ envFile: 'LISTEN=127.0.0.1:9000\n' }).envFile, { LISTEN: '' })).toBe(
      'http://127.0.0.1:9000',
    );
  });

  test('a bad LISTEN falls back to the default', () => {
    expect(controlBaseUrl(home().envFile, { LISTEN: 'nonsense' })).toBe('http://127.0.0.1:8081');
  });
});

describe('createControlClient', () => {
  test('status with the bearer token at LISTEN from the process env only', async () => {
    const h = home({ token: TOK });
    const f = fakeFetch(() => Response.json(STATUS));
    const c = createControlClient({ ...h, fetch: f.fetch, env: { LISTEN: '127.0.0.1:18081' } });
    expect(await c.status()).toEqual(STATUS);
    expect(f.calls).toEqual([
      { url: 'http://127.0.0.1:18081/internal/status', method: 'GET', auth: `Bearer ${TOK}`, body: undefined },
    ]);
  });

  test('a token file that is not a token (a planted link to another file) is never sent', async () => {
    const f = fakeFetch(() => Response.json(STATUS));
    const c = createControlClient({ ...home({ token: 'root:x:0:0:root:/root:/bin/bash' }), fetch: f.fetch, env: {} });
    expect(await c.available()).toBe(false);
    expect(f.calls).toEqual([]);
  });

  test('no token: unavailable without any request', async () => {
    const f = fakeFetch(() => Response.json(STATUS));
    const c = createControlClient({ ...home(), fetch: f.fetch, env: {} });
    expect(await c.available()).toBe(false);
    await expect(c.status()).rejects.toBeInstanceOf(ControlUnavailableError);
    expect(f.calls).toEqual([]);
  });

  test('available: token present and status answers', async () => {
    const h = home({ token: TOK });
    expect(
      await createControlClient({ ...h, fetch: fakeFetch(() => Response.json(STATUS)).fetch, env: {} }).available(),
    ).toBe(true);
    expect(
      await createControlClient({
        ...h,
        fetch: fakeFetch(() => new Response('Not found', { status: 404 })).fetch,
        env: {},
      }).available(),
    ).toBe(false);
    const refused = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await createControlClient({ ...h, fetch: refused, env: {} }).available()).toBe(false);
  });

  test('doctor session, wait (capped at 30 s), update, shutdown', async () => {
    const h = home({ token: TOK });
    const f = fakeFetch((c) => {
      if (c.url.endsWith('/internal/doctor/sessions'))
        return Response.json({ id: 'ab', url: 'https://x.test/doctor?t=1', expiresAt: 5 });
      if (c.url.includes('/internal/doctor/sessions/')) return Response.json({ state: 'opened', openedAt: 3 });
      if (c.url.endsWith('/internal/update')) return Response.json({ action: 'deferred', message: '1 room open' });
      if (c.url.endsWith('/internal/shutdown')) return new Response(null, { status: 202 });
      return new Response('', { status: 404 });
    });
    const c = createControlClient({ ...h, fetch: f.fetch, env: {} });
    expect(await c.doctorSession()).toEqual({ id: 'ab', url: 'https://x.test/doctor?t=1', expiresAt: 5 });
    expect(await c.doctorWait('ab', 60_000)).toEqual({ state: 'opened', openedAt: 3 });
    expect(f.calls[1]!.url).toBe('http://127.0.0.1:8081/internal/doctor/sessions/ab?wait=30000');
    expect((await c.update('scheduled')).action).toBe('deferred');
    expect(f.calls[2]!.body).toEqual({ mode: 'scheduled' });
    await c.shutdown('restart');
    expect(f.calls[3]).toMatchObject({ method: 'POST', body: { reason: 'restart' } });
  });

  test('a non-2xx answer is an error naming the route', async () => {
    const c = createControlClient({
      ...home({ token: TOK }),
      fetch: fakeFetch(() => new Response('', { status: 404, statusText: 'Not Found' })).fetch,
      env: {},
    });
    await expect(c.status()).rejects.toThrow('control: GET /internal/status: 404 Not Found');
    await expect(c.shutdown('stop')).rejects.toThrow('/internal/shutdown: 404');
  });
});
