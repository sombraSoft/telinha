import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlStatus, UpdateMode, UpdateResult } from '../src/cli/control.ts';
import { createControlClient } from '../src/cli/control.ts';
import { type ControlDeps, createControl } from '../src/control.ts';
import { setup } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'telinha-control-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const TOKEN = 'f'.repeat(64);
const STATUS: ControlStatus = {
  version: '9.9.9',
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
  supervised: false,
};
const RESULT = { action: 'none', message: 'up to date' } as UpdateResult;

function make(o: Partial<ControlDeps> = {}) {
  const tokenFile = join(dir, `run${++n}`, 'control.token');
  const calls: unknown[][] = [];
  const control = createControl({
    tokenFile,
    token: TOKEN,
    status: () => STATUS,
    doctor: {
      create: () => (calls.push(['create']), { id: 'a'.repeat(32), url: 'https://t.example/doctor?t=x', expiresAt: 5 }),
      wait: async (id, ms) => (calls.push(['wait', id, ms]), { state: 'pending' }),
    },
    update: async (mode: UpdateMode) => (calls.push(['update', mode]), { ...RESULT, message: mode }),
    shutdown: (reason) => calls.push(['shutdown', reason]),
    ...o,
  });
  const req = (path: string, init: RequestInit & { auth?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.auth !== null) headers.set('authorization', init.auth ?? `Bearer ${TOKEN}`);
    const r = new Request(`http://127.0.0.1:8081${path}`, { ...init, headers });
    return control.handle(r, new URL(r.url));
  };
  return { control, tokenFile, calls, req };
}

describe('control endpoint', () => {
  test('status with the right bearer token', async () => {
    const { req } = make();
    const r = await req('/internal/status');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual(STATUS);
  });

  test('no token, a wrong one or a forwarded request: the same 404 as an unknown path', async () => {
    const { req, calls } = make();
    const cases: [string, RequestInit & { auth?: string | null }][] = [
      ['/internal/status', { auth: null }],
      ['/internal/status', { auth: `Bearer ${'0'.repeat(64)}` }],
      ['/internal/status', { auth: TOKEN }],
      ['/internal/status', { auth: `Bearer ${TOKEN}x` }],
      ['/internal/shutdown', { method: 'POST', auth: null, body: '{"reason":"stop"}' }],
      ['/internal/status', { headers: { 'x-forwarded-for': '203.0.113.9' } }],
      ['/internal/status', { headers: { 'cf-connecting-ip': '203.0.113.9' } }],
      ['/internal/status', { headers: { forwarded: 'for=203.0.113.9' } }],
      ['/internal/nope', {}],
      ['/internal/status', { method: 'POST' }],
    ];
    for (const [p, init] of cases) {
      const r = await req(p, init);
      expect([p, r.status, await r.text()]).toEqual([p, 404, 'Not found']);
    }
    expect(calls).toEqual([]);
  });

  test('phone tests: create, and wait capped at 30 s; bad ids 404', async () => {
    const { req, calls } = make();
    const created = await req('/internal/doctor/sessions', { method: 'POST', body: '{}' });
    expect(await created.json()).toEqual({ id: 'a'.repeat(32), url: 'https://t.example/doctor?t=x', expiresAt: 5 });
    expect(await (await req(`/internal/doctor/sessions/${'b'.repeat(32)}?wait=90000`)).json()).toEqual({
      state: 'pending',
    });
    await req(`/internal/doctor/sessions/${'b'.repeat(32)}`);
    expect((await req('/internal/doctor/sessions/xyz?wait=1')).status).toBe(404);
    expect(calls).toEqual([['create'], ['wait', 'b'.repeat(32), 30_000], ['wait', 'b'.repeat(32), 0]]);
    const none = make({ doctor: null });
    expect((await none.req('/internal/doctor/sessions', { method: 'POST' })).status).toBe(404);
  });

  test('update: the mode is checked and handed over', async () => {
    const { req, calls } = make();
    for (const mode of ['check', 'scheduled', 'now']) {
      const r = await req('/internal/update', { method: 'POST', body: JSON.stringify({ mode }) });
      expect(((await r.json()) as UpdateResult).message).toBe(mode);
    }
    expect((await req('/internal/update', { method: 'POST', body: '{"mode":"force"}' })).status).toBe(400);
    expect((await req('/internal/update', { method: 'POST', body: 'nope' })).status).toBe(400);
    expect(calls).toEqual([
      ['update', 'check'],
      ['update', 'scheduled'],
      ['update', 'now'],
    ]);
  });

  test('shutdown: 202 first, then the callback with the reason', async () => {
    const { req, calls } = make();
    const r = await req('/internal/shutdown', { method: 'POST', body: '{"reason":"restart"}' });
    expect(r.status).toBe(202);
    expect(calls).toEqual([]);
    await Bun.sleep(80);
    expect(calls).toEqual([['shutdown', 'restart']]);
    expect((await req('/internal/shutdown', { method: 'POST', body: '{"reason":"later"}' })).status).toBe(400);
  });

  test('the token file: written on demand, owner-only, removed only while it is ours', () => {
    const { control, tokenFile } = make();
    expect(existsSync(tokenFile)).toBe(false);
    control.writeToken();
    expect(readFileSync(tokenFile, 'utf8')).toBe(`${TOKEN}\n`);
    if (process.platform !== 'win32') expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    // A newer instance wrote its own: ours must not delete it.
    writeFileSync(tokenFile, 'other\n');
    control.removeToken();
    expect(readFileSync(tokenFile, 'utf8')).toBe('other\n');
    control.writeToken();
    control.removeToken();
    expect(existsSync(tokenFile)).toBe(false);
    control.removeToken();
  });

  test('a generated token is 32 random bytes in hex, different per instance', () => {
    const tokens = [1, 2].map(() => {
      const tokenFile = join(dir, `gen${++n}`, 'control.token');
      createControl({ tokenFile, status: () => STATUS, shutdown: () => {} }).writeToken();
      return readFileSync(tokenFile, 'utf8').trim();
    });
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
});

describe('through the HTTP handler and the CLI client', () => {
  test('the client reads the token file and reaches status; without the file it is unavailable', async () => {
    const { control, tokenFile } = make();
    const s = setup({ control });
    const run = join(tokenFile, '..');
    const fetchVia = async (url: string, init?: RequestInit) => (await s.handler(new Request(url, init)))!;
    const client = createControlClient({
      paths: { run },
      envFile: join(dir, 'none.env'),
      env: { LISTEN: '127.0.0.1:8081' },
      fetch: fetchVia,
    });
    expect(await client.available()).toBe(false);
    control.writeToken();
    expect(await client.available()).toBe(true);
    expect((await client.status()).version).toBe('9.9.9');
    await client.shutdown('stop');
  });
});

describe('over a real listener', () => {
  // Bun.serve closes a request that has sent nothing for idleTimeout seconds
  // (10 by default, which run.ts keeps): the doctor long poll (up to 30 s) and
  // an update (minutes) run longer. Scaled down here: 1 s idle, a 6 s answer.
  // Bun checks idle sockets on a 4 s tick, so a 1 s timeout closes the request
  // anywhere up to ~4 s in; the answer has to come after that.
  const longPoll = async (lift: boolean) => {
    const { control } = make({
      doctor: {
        create: () => ({ id: 'a'.repeat(32), url: '', expiresAt: 0 }),
        wait: async () => (await Bun.sleep(6000), { state: 'pending' }),
      },
    });
    const handler = setup({ control, timeout: lift ? (req, s) => server.timeout(req, s) : undefined }).handler;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 1,
      fetch: async (req) => (await handler(req))!,
    });
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/internal/doctor/sessions/${'a'.repeat(32)}?wait=25000`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      return { status: r.status, body: await r.json() };
    } finally {
      server.stop(true);
    }
  };

  test('a control call that answers after the idle timeout gets through', async () => {
    expect(await longPoll(true)).toEqual({ status: 200, body: { state: 'pending' } });
  }, 15_000);

  test('(without lifting the timeout Bun drops it: what the test above guards)', async () => {
    await expect(longPoll(false)).rejects.toThrow();
  }, 15_000);
});
