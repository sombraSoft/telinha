import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSupervisor, redactLine, type ChildHandle, type ChildSpec, type SupervisorDeps } from '../src/supervisor.ts';

const T0 = 1_700_000_000_000;
// Not a pid anywhere: Windows pids are multiples of 4, Linux pid_max is <= 4194304.
// The stale-kill path really calls process.kill/taskkill on it and gets ESRCH / "not found".
const NO_PID = 2_147_483_647;
const enc = new TextEncoder();

/** Lets the exit watchers and chained ops run (promise callbacks + a macrotask). */
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

interface FakeHandle extends ChildHandle {
  name: string;
  env: Record<string, string>;
  kills: (NodeJS.Signals | undefined)[];
  exit(code: number | null): void;
  push(text: string): void;
  closeOut(): void;
}

/**
 * Fake spawn: handles whose exit is resolved by the test (or by kill() when
 * `autoExit`, like a process that honours SIGTERM) and whose stdout the test
 * feeds. Every spawn/kill/exit/prepare lands in `events` for order assertions.
 */
function fakes(o: { autoExit?: boolean; fakeTime?: boolean } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const handles: FakeHandle[] = [];
  let nextPid = 1000;
  const spawn: NonNullable<SupervisorDeps['spawn']> = (spec, env) => {
    const pid = ++nextPid;
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => { resolveExit = r; });
    let out!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { out = c; } });
    let done = false;
    const h: FakeHandle = {
      name: spec.name, pid, exited, stdout, stderr: null, env, kills: [],
      kill(signal) {
        h.kills.push(signal);
        events.push(`kill ${spec.name}#${pid}`);
        if (o.autoExit !== false) queueMicrotask(() => h.exit(null));
      },
      exit(code) {
        if (done) return;
        done = true;
        events.push(`exit ${spec.name}#${pid}`);
        resolveExit(code);
      },
      push: (text) => out.enqueue(enc.encode(text)),
      closeOut: () => out.close(),
    };
    events.push(`spawn ${spec.name}#${pid}`);
    handles.push(h);
    return h;
  };

  // Fake clock and sleep: delays are recorded, resolved by the test or by the abort signal.
  let clock = T0;
  const sleeps: { ms: number; aborted: boolean; resolve: () => void }[] = [];
  const sleep: NonNullable<SupervisorDeps['sleep']> = (ms, signal) => new Promise<void>((resolve) => {
    const s = { ms, aborted: false, resolve };
    sleeps.push(s);
    if (signal?.aborted) {
      s.aborted = true;
      return resolve();
    }
    signal?.addEventListener('abort', () => { s.aborted = true; resolve(); }, { once: true });
  });

  const spec = (name: string, extra: Partial<ChildSpec> = {}): ChildSpec => ({
    name,
    cmd: [`/opt/bin/${name}-bin`, '--flag', name],
    prepare: async () => void events.push(`prepare ${name}`),
    ...extra,
  });
  const create = (specs: ChildSpec[], extra: Partial<SupervisorDeps> = {}) => createSupervisor({
    specs,
    log: (...a) => void logs.push(a.map(String).join(' ')),
    spawn,
    platform: 'linux',
    ...(o.fakeTime === false ? {} : { now: () => clock, sleep }),
    ...extra,
  });
  return {
    events, logs, handles, sleeps, spec, create,
    last: () => handles.at(-1)!,
    byName: (name: string) => handles.filter((h) => h.name === name),
    delays: () => sleeps.map((s) => s.ms),
    advance: (ms: number) => { clock += ms; },
    /** Resolves the i-th recorded sleep (default: the newest) as if its time passed. */
    fire: (i = sleeps.length - 1) => sleeps[i]!.resolve(),
  };
}

describe('start', () => {
  test('prepare runs before each spawn, in spec order, with the merged env', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a', { env: { A: '1' } }), f.spec('b')], { baseEnv: { PATH: '/bin', A: '0' } });
    await sup.start();
    expect(f.events).toEqual(['prepare a', 'spawn a#1001', 'prepare b', 'spawn b#1002']);
    expect(f.handles[0]!.env).toEqual({ PATH: '/bin', A: '1' });
    expect(f.handles[1]!.env).toEqual({ PATH: '/bin', A: '0' });
    expect(sup.status().map((s) => [s.name, s.state, s.pid])).toEqual([['a', 'up', 1001], ['b', 'up', 1002]]);
    await sup.stop();
  });

  test('the child env is baseEnv + spec.env and nothing from process.env', async () => {
    process.env.TELINHA_SUPERVISOR_SENTINEL = 'leaked';
    try {
      const f = fakes();
      const sup = f.create([f.spec('a', { env: { ONLY: 'this' } })], { baseEnv: { HOME: '/h' } });
      await sup.start();
      expect(f.last().env).toEqual({ HOME: '/h', ONLY: 'this' });
      expect('TELINHA_SUPERVISOR_SENTINEL' in f.last().env).toBe(false);
      const noBase = f.create([f.spec('b', { env: { X: 'y' } })]);
      await noBase.start();
      expect(f.last().env).toEqual({ X: 'y' });
      await Promise.all([sup.stop(), noBase.stop()]);
    } finally {
      delete process.env.TELINHA_SUPERVISOR_SENTINEL;
    }
  });

  test('the spawning log line has argv only, never an env value', async () => {
    const f = fakes();
    const sup = f.create([f.spec('cloudflared', { env: { TUNNEL_TOKEN: 'eyJ-very-secret' } })], { baseEnv: { PATH: '/base/path' } });
    await sup.start();
    const line = f.logs.find((l) => l.startsWith('spawning cloudflared'))!;
    expect(line).toBe('spawning cloudflared: /opt/bin/cloudflared-bin --flag cloudflared');
    expect(f.logs.join('\n')).not.toContain('eyJ-very-secret');
    expect(f.logs.join('\n')).not.toContain('/base/path');
    await sup.stop();
  });

  test('start() twice throws', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a')]);
    await sup.start();
    expect(sup.start()).rejects.toThrow('already started');
    await sup.stop();
  });

  test('output is logged line by line with the [name] prefix, split chunks and CRLF included', async () => {
    const f = fakes();
    const sup = f.create([f.spec('lk')]);
    await sup.start();
    const h = f.last();
    h.push('hel');
    h.push('lo\r\nwor');
    await settle();
    expect(f.logs.filter((l) => l.startsWith('[lk]'))).toEqual(['[lk] hello']);
    h.push('ld\nlast');
    h.closeOut();
    await settle();
    expect(f.logs.filter((l) => l.startsWith('[lk]'))).toEqual(['[lk] hello', '[lk] world', '[lk] last']);
    await sup.stop();
  });

  test('redact blanks a secret in forwarded output, even when a chunk splits it', async () => {
    const secret = 'SECRET-duck-0123'; // gitleaks:allow
    const f = fakes();
    const sup = f.create([f.spec('caddy', { redact: [secret] })]);
    await sup.start();
    const h = f.last();
    h.push('error: Get "https://www.duckdns.org/update?domains=g&token=SECRET-du');
    h.push('ck-0123&txt=x": dial tcp: lookup www.duckdns.org: no such host\ntrailing token=SECRET-duck-0123'); // gitleaks:allow
    h.closeOut();
    await settle();
    expect(f.logs.filter((l) => l.startsWith('[caddy]'))).toEqual([
      '[caddy] error: Get "https://www.duckdns.org/update?domains=g&token=***&txt=x": dial tcp: lookup www.duckdns.org: no such host',
      '[caddy] trailing token=***',
    ]);
    expect(f.logs.join('\n')).not.toContain(secret);
    await sup.stop();
  });

  test('a spec without redact forwards lines verbatim', async () => {
    const f = fakes();
    const sup = f.create([f.spec('lk')]);
    await sup.start();
    f.last().push('token=abc&x=***\n');
    await settle();
    expect(f.logs.filter((l) => l.startsWith('[lk]'))).toEqual(['[lk] token=abc&x=***']);
    await sup.stop();
  });
});

describe('redactLine', () => {
  test.each([
    ['no secrets', 'token=abc', [], 'token=abc'],
    ['empty secret is skipped', 'token=abc', [''], 'token=abc'],
    ['every occurrence', 'abc abc', ['abc'], '*** ***'],
    ['several secrets', 'a=one b=two', ['one', 'two'], 'a=*** b=***'],
    ['the URL-encoded form too', 'token=a%2Bb%2Fc and a+b/c', ['a+b/c'], 'token=*** and ***'],
  ] as const)('%s', (_, line, secrets, want) => {
    expect(redactLine(line, secrets)).toBe(want);
  });

  test('no list leaves the line alone', () => {
    expect(redactLine('token=abc')).toBe('token=abc');
  });
});

describe('ready probes (real Bun.serve, real time)', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  function probeServer(okAfter: number) {
    let hits = 0;
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(++hits > okAfter ? 'ok' : 'nope', { status: hits > okAfter ? 200 : 503 }) });
    return { url: `http://127.0.0.1:${server.port}/`, hits: () => hits };
  }

  test('start() resolves once the probe answers 2xx; state goes starting -> up', async () => {
    const f = fakes({ fakeTime: false });
    const p = probeServer(2);
    const sup = f.create([f.spec('lk', { ready: { url: p.url, timeoutMs: 5000 } })]);
    const started = sup.start();
    await settle();
    expect(sup.status()[0]!.state).toBe('starting');
    await started;
    expect(p.hits()).toBe(3);
    expect(sup.status()[0]!.state).toBe('up');
    await sup.stop();
  });

  test('start() rejects after timeoutMs', async () => {
    const f = fakes({ fakeTime: false });
    const p = probeServer(Infinity);
    const sup = f.create([f.spec('lk', { ready: { url: p.url, timeoutMs: 600 } })]);
    const t = Date.now();
    await expect(sup.start()).rejects.toThrow(/timed out waiting for lk/);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(p.hits()).toBeGreaterThanOrEqual(2);
    await sup.stop();
  });

  test('start() rejects early when the child dies before the probe passes', async () => {
    const f = fakes({ fakeTime: false });
    const p = probeServer(Infinity);
    const sup = f.create([f.spec('lk', { ready: { url: p.url, timeoutMs: 10_000 } })]);
    const started = sup.start();
    await settle();
    f.last().exit(3);
    const t = Date.now();
    await expect(started).rejects.toThrow('lk exited with code 3 before it was ready');
    expect(Date.now() - t).toBeLessThan(2000);
    // The crash scheduled a (real, 1 s) backoff restart; stop() cancels it without waiting.
    await sup.stop();
    await settle();
    expect(f.handles).toHaveLength(1);
    expect(f.logs).toContain('[lk] restart cancelled');
  });

  test('a 2xx answered while our child already died is not ours: never "up"', async () => {
    // Another LiveKit on the port answers; ours failed to bind and exited meanwhile.
    const f = fakes({ fakeTime: false });
    server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      fetch: () => {
        f.last().exit(1);
        return new Response('ok');
      },
    });
    const sup = f.create([f.spec('lk', { ready: { url: `http://127.0.0.1:${server.port}/`, timeoutMs: 10_000 } })]);
    await expect(sup.start()).rejects.toThrow('lk exited with code 1 before it was ready');
    expect(sup.status()[0]!.state).not.toBe('up');
    await sup.stop();
  });

  test('stop() while a probe is pending makes start() reject', async () => {
    const f = fakes({ fakeTime: false });
    const p = probeServer(Infinity);
    const sup = f.create([f.spec('lk', { ready: { url: p.url, timeoutMs: 10_000 } })]);
    const started = sup.start();
    await settle();
    await sup.stop();
    await expect(started).rejects.toThrow('stopped while waiting');
    expect(f.last().kills).toEqual(['SIGTERM']);
  });
});

describe('crash restarts', () => {
  test('backoff 1, 2, 4 ... capped at maxMs, reset after a run longer than resetAfterMs', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a', { restart: { minMs: 1000, maxMs: 4000, resetAfterMs: 60_000 } })]);
    await sup.start();
    const crash = async (code: number) => {
      f.last().exit(code);
      await settle();
      f.fire();
      await settle();
    };
    await crash(1);
    expect(f.logs).toContain('[a] exited with code 1, restarting in 1s');
    expect(sup.status()[0]!.restarts).toBe(1);
    await crash(1);
    await crash(1);
    await crash(1);
    expect(f.delays()).toEqual([1000, 2000, 4000, 4000]);
    expect(f.events.filter((e) => e.startsWith('prepare'))).toHaveLength(5);
    expect(f.handles).toHaveLength(5);
    // A long run resets the exponent.
    f.advance(60_000);
    await crash(2);
    expect(f.delays().at(-1)).toBe(1000);
    expect(f.logs).toContain('[a] exited with code 2, restarting in 1s');
    expect(sup.status()[0]!.restarts).toBe(5);
    await sup.stop();
  });

  test('status() shows restarting with no pid while the backoff runs', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a')]);
    await sup.start();
    expect(sup.status()[0]).toEqual({ name: 'a', state: 'up', pid: 1001, restarts: 0, since: T0 });
    f.advance(10);
    f.last().exit(1);
    await settle();
    expect(sup.status()[0]).toEqual({ name: 'a', state: 'restarting', pid: null, restarts: 0, since: T0 + 10 });
    f.fire();
    await settle();
    expect(sup.status()[0]).toEqual({ name: 'a', state: 'up', pid: 1002, restarts: 1, since: T0 + 10 });
    await sup.stop();
    expect(sup.status()[0]!.state).toBe('stopped');
  });

  test('a failing prepare is retried with backoff, never given up on', async () => {
    const f = fakes();
    let fail = 2;
    const sup = f.create([f.spec('a', { prepare: async () => { if (fail-- > 0) throw new Error('disk full'); f.events.push('prepare a'); } })]);
    fail = 0;
    await sup.start();
    fail = 2;
    f.last().exit(1);
    await settle();
    f.fire();
    await settle();
    expect(f.logs.at(-1)).toBe('[a] restart failed: disk full, retrying in 2s');
    f.fire();
    await settle();
    expect(f.logs.at(-1)).toBe('[a] restart failed: disk full, retrying in 4s');
    f.fire();
    await settle();
    expect(f.handles).toHaveLength(2);
    expect(f.delays()).toEqual([1000, 2000, 4000]);
    await sup.stop();
  });

  test('a late exit from a replaced handle is ignored', async () => {
    const f = fakes({ autoExit: false });
    const sup = f.create([f.spec('a')]);
    await sup.start();
    const old = f.last();
    const restarted = sup.restart('a');
    await settle();
    old.exit(null); // the SIGTERM took effect
    await restarted;
    expect(f.handles).toHaveLength(2);
    old.exit(1); // cannot happen twice for real; the fake ignores it, and so would the supervisor
    f.events.length = 0;
    await settle();
    expect(f.events).toEqual([]);
    expect(f.delays()).toEqual([5000]); // only the SIGTERM grace wait, no backoff
    const stopping = sup.stop();
    await settle();
    f.last().exit(null);
    await stopping;
  });
});

describe('stop', () => {
  test('SIGTERM, then SIGKILL after stopGraceMs; idempotent; pidfile removed', async () => {
    const f = fakes({ autoExit: false });
    const dir = mkdtempSync(join(tmpdir(), 'telinha-sup-'));
    const pidfile = join(dir, 'run', 'children.json');
    try {
      const sup = f.create([f.spec('a', { stopGraceMs: 2000 }), f.spec('b')], { pidfile });
      await sup.start();
      expect(JSON.parse(readFileSync(pidfile, 'utf8'))).toEqual([
        { name: 'a', pid: 1001, exe: 'a-bin' }, { name: 'b', pid: 1002, exe: 'b-bin' },
      ]);
      const [a, b] = f.handles as [FakeHandle, FakeHandle];
      const stopping = sup.stop();
      expect(sup.stop()).toBe(stopping);
      await settle();
      expect(a.kills).toEqual(['SIGTERM']);
      expect(b.kills).toEqual(['SIGTERM']);
      expect(f.delays()).toEqual([2000, 5000]);
      b.exit(null); // b honours SIGTERM
      f.fire(0); // a's grace runs out
      await settle();
      expect(a.kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(b.kills).toEqual(['SIGTERM']);
      expect(f.logs).toContain('[a] still running after 2s, killing');
      a.exit(null);
      await stopping;
      expect(existsSync(pidfile)).toBe(false);
      expect(sup.status().map((s) => [s.state, s.pid])).toEqual([['stopped', null], ['stopped', null]]);
      expect(f.logs).toContain('[a] exited with code null');
      expect(f.handles).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('on win32 the kill is final: no SIGKILL escalation', async () => {
    const f = fakes({ autoExit: false });
    const sup = f.create([f.spec('a')], { platform: 'win32' });
    await sup.start();
    const stopping = sup.stop();
    await settle();
    expect(f.last().kills).toEqual(['SIGTERM']);
    f.fire(); // grace over
    await settle();
    expect(f.last().kills).toEqual(['SIGTERM']);
    await stopping;
  });

  test('a child that already exited is not killed (its pid may be recycled), and stopSync() skips it too', async () => {
    const f = fakes({ autoExit: false });
    const sup = f.create([f.spec('a'), f.spec('b')]);
    await sup.start();
    const [a, b] = f.handles as [FakeHandle, FakeHandle];
    // a dies on Ctrl+C before our handler runs stop(): its exit is observed
    // first and looks like a crash until stop() cancels the scheduled restart.
    a.exit(130);
    await settle();
    expect(f.logs).toContain('[a] exited with code 130, restarting in 1s');
    const stopping = sup.stop();
    await settle();
    expect(a.kills).toEqual([]);
    expect(b.kills).toEqual(['SIGTERM']);
    // b exits during stop(), before the SIGKILL.
    b.exit(null);
    await stopping;
    expect(b.kills).toEqual(['SIGTERM']);
    sup.stopSync();
    expect(a.kills).toEqual([]);
    expect(b.kills).toEqual(['SIGTERM']);
    await settle();
    expect(f.handles).toHaveLength(2); // no respawn of either
    expect(f.logs).toContain('[a] restart cancelled');
    expect(f.logs).toContain('[b] exited with code null');
    expect(f.logs.filter((l) => l.startsWith('[b]') && l.includes('restarting'))).toEqual([]);
  });

  test('stopSync() SIGKILLs live children (Linux) without waiting', async () => {
    const f = fakes({ autoExit: false });
    const sup = f.create([f.spec('a')]);
    await sup.start();
    sup.stopSync();
    expect(f.last().kills).toEqual(['SIGKILL']);
    f.last().exit(null);
    await settle();
    expect(f.handles).toHaveLength(1);
  });

  test('stop() during a backoff sleep aborts it and nothing is spawned', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a')]);
    await sup.start();
    f.last().exit(1);
    await settle();
    expect(f.sleeps).toHaveLength(1);
    await sup.stop();
    await settle();
    expect(f.sleeps[0]!.aborted).toBe(true);
    expect(f.handles).toHaveLength(1);
    expect(f.logs).toContain('[a] restart cancelled');
    expect(f.last().kills).toEqual([]);
  });

  test('prepare in flight when stop() is called: no spawn after it resolves', async () => {
    const f = fakes();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const sup = f.create([f.spec('a', { prepare: async () => { if (++calls > 1) await held; } })]);
    await sup.start();
    f.last().exit(1);
    await settle();
    f.fire();
    await settle();
    expect(calls).toBe(2); // the respawn's prepare is pending
    const stopping = sup.stop();
    release();
    await stopping;
    await settle();
    expect(f.handles).toHaveLength(1);
    expect(f.logs).toContain('[a] restart cancelled');
  });

  test('stop() during start(): the remaining children are not spawned', async () => {
    const f = fakes();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const sup = f.create([f.spec('a'), f.spec('b', { prepare: () => held })]);
    const started = sup.start();
    await settle();
    const stopping = sup.stop();
    release();
    await expect(started).rejects.toThrow('stopped during start');
    await stopping;
    expect(f.handles.map((h) => h.name)).toEqual(['a']);
  });
});

describe('restart', () => {
  test('graceful stop, prepare, spawn; not counted as a crash', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a'), f.spec('b')]);
    await sup.start();
    f.events.length = 0;
    await sup.restart('a');
    expect(f.events).toEqual(['kill a#1001', 'exit a#1001', 'prepare a', 'spawn a#1003']);
    expect(sup.status()[0]).toMatchObject({ state: 'up', pid: 1003, restarts: 0 });
    expect(sup.status()[1]).toMatchObject({ state: 'up', pid: 1002 });
    expect(f.logs).toContain('[a] exited with code null');
    expect(f.logs.filter((l) => l.includes('restarting in'))).toEqual([]);
    await sup.stop();
  });

  test('unknown child rejects; during stop() it is a no-op', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a')]);
    await sup.start();
    await expect(sup.restart('nope')).rejects.toThrow('unknown child nope');
    const stopping = sup.stop();
    await sup.restart('a');
    await stopping;
    expect(f.handles).toHaveLength(1);
  });

  test('during a backoff: the pending respawn is cancelled, exactly one spawn follows', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a')]);
    await sup.start();
    f.last().exit(1);
    await settle();
    expect(f.sleeps).toHaveLength(1);
    await sup.restart('a');
    expect(f.sleeps[0]!.aborted).toBe(true);
    expect(f.handles).toHaveLength(2);
    expect(f.last().kills).toEqual([]); // the dead child was not killed again
    await settle();
    expect(f.handles).toHaveLength(2);
    expect(f.logs).toContain('[a] restart cancelled');
    expect(sup.status()[0]).toMatchObject({ state: 'up', pid: 1002, restarts: 0 });
    await sup.stop();
  });

  test('two concurrent restarts serialize: two spawns, no overlap of stop and spawn', async () => {
    const f = fakes();
    const sup = f.create([f.spec('a')]);
    await sup.start();
    f.events.length = 0;
    await Promise.all([sup.restart('a'), sup.restart('a')]);
    expect(f.events).toEqual([
      'kill a#1001', 'exit a#1001', 'prepare a', 'spawn a#1002',
      'kill a#1002', 'exit a#1002', 'prepare a', 'spawn a#1003',
    ]);
    expect(sup.status()[0]).toMatchObject({ state: 'up', pid: 1003, restarts: 0 });
    await sup.stop();
  });

  test('a restart whose prepare fails rejects, and the child is retried with backoff', async () => {
    const f = fakes();
    let fail = false;
    const sup = f.create([f.spec('a', { prepare: async () => { if (fail) throw new Error('no disk'); f.events.push('prepare a'); } })]);
    await sup.start();
    fail = true;
    await expect(sup.restart('a')).rejects.toThrow('no disk');
    expect(f.logs.at(-1)).toBe('[a] restart failed: no disk, retrying in 1s');
    expect(f.handles).toHaveLength(1);
    expect(sup.status()[0]).toMatchObject({ state: 'restarting', pid: null });
    fail = false;
    f.fire();
    await settle();
    expect(f.handles).toHaveLength(2);
    expect(sup.status()[0]).toMatchObject({ state: 'up', pid: 1002 });
    await sup.stop();
  });

  test('a crash while a restart is queued does not add a third spawn', async () => {
    const f = fakes({ autoExit: false });
    const sup = f.create([f.spec('a')]);
    await sup.start();
    const first = f.last();
    const r1 = sup.restart('a');
    const r2 = sup.restart('a');
    await settle();
    first.exit(1); // dies during its own restart: expected, not a crash
    await r1;
    const second = f.last();
    await settle();
    second.exit(null);
    await r2;
    expect(f.handles).toHaveLength(3);
    expect(f.logs.filter((l) => l.includes('restarting in'))).toEqual([]);
    const stopping = sup.stop();
    await settle();
    f.last().exit(null);
    await stopping;
  });
});

describe('pidfile stale cleanup', () => {
  test('kills only an alive pid that still runs the recorded executable', async () => {
    const f = fakes();
    const dir = mkdtempSync(join(tmpdir(), 'telinha-sup-'));
    const pidfile = join(dir, 'children.json');
    try {
      writeFileSync(pidfile, JSON.stringify([
        { name: 'livekit', pid: NO_PID, exe: 'livekit-server' },        // alive, same exe -> killed
        { name: 'caddy', pid: NO_PID - 4, exe: 'caddy' },               // alive, pid recycled by something else -> left alone
        { name: 'cloudflared', pid: NO_PID - 8, exe: 'cloudflared' },   // gone
        { name: 'me', pid: process.pid, exe: 'bun' },                   // never ourselves
      ]));
      const asked: number[] = [];
      const sup = f.create([f.spec('livekit')], {
        pidfile,
        processInfo: (pid) => {
          asked.push(pid);
          if (pid === NO_PID) return { alive: true, exe: 'livekit-server' };
          if (pid === NO_PID - 4) return { alive: true, exe: 'nginx' };
          return { alive: false, exe: null };
        },
      });
      await sup.start();
      expect(asked).toEqual([NO_PID, NO_PID - 4, NO_PID - 8]);
      const stale = f.logs.filter((l) => l.includes('stale pid'));
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatch(new RegExp(`^\\[livekit\\] (killed|could not kill) stale pid ${NO_PID}`));
      // The new child replaced the file.
      expect(JSON.parse(readFileSync(pidfile, 'utf8'))).toEqual([{ name: 'livekit', pid: 1001, exe: 'livekit-bin' }]);
      await sup.stop();
      expect(existsSync(pidfile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exe match ignores case and .exe on Windows and the 15-char comm cut on Linux; garbage is skipped', async () => {
    const f = fakes();
    const dir = mkdtempSync(join(tmpdir(), 'telinha-sup-'));
    const pidfile = join(dir, 'children.json');
    try {
      writeFileSync(pidfile, JSON.stringify([
        { name: 'a', pid: NO_PID, exe: 'livekit-server' },
        { name: 'b', pid: NO_PID - 4, exe: 'a-very-long-binary-name' },
        { name: 'junk', pid: 'x', exe: 1 },
      ]));
      const win = f.create([f.spec('a')], { pidfile, platform: 'win32', processInfo: () => ({ alive: true, exe: 'LiveKit-Server.EXE' }) });
      await win.start();
      expect(f.logs.filter((l) => l.includes(`stale pid ${NO_PID}`))).toHaveLength(1);
      expect(f.logs.filter((l) => l.includes(`stale pid ${NO_PID - 4}`))).toHaveLength(0);
      await win.stop();
      f.logs.length = 0;
      writeFileSync(pidfile, JSON.stringify([{ name: 'b', pid: NO_PID, exe: 'a-very-long-binary-name' }]));
      const linux = f.create([f.spec('b')], { pidfile, processInfo: () => ({ alive: true, exe: 'a-very-long-bin' }) });
      await linux.start();
      expect(f.logs.filter((l) => l.includes(`stale pid ${NO_PID}`))).toHaveLength(1);
      await linux.stop();
      writeFileSync(pidfile, 'not json');
      const bad = f.create([f.spec('c')], { pidfile });
      await bad.start();
      expect(f.logs.some((l) => l.includes('unreadable'))).toBe(true);
      await bad.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
