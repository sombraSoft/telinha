import { describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import { type RunLoopChild, type RunLoopOptions, runLoop } from '../src/service/runloop.ts';
import type { UpdateFs, UpdateState } from '../src/update/types.ts';

const T0 = 1_700_000_000_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const PATHS = { bin: '/t/bin', run: '/t/data/run' };
const PIDFILE = '/t/data/run/service.pid';
const STATE = '/t/data/run/update.json';
const CMD = ['/t/bin/telinha', 'run', '--home', '/t'];

function memFs() {
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  const ops: string[] = [];
  let clock = 1;
  const n = (p: string) => p.replace(/\\/g, '/');
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const fs: UpdateFs = {
    async readdir(dir) {
      const d = `${n(dir).replace(/\/$/, '')}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(d) && !k.slice(d.length).includes('/'))
        .map((k) => k.slice(d.length));
    },
    async rename(from, to) {
      const e = files.get(n(from));
      if (!e) throw err('ENOENT', from);
      files.delete(n(from));
      files.set(n(to), e);
      ops.push(`rename ${basename(from)} -> ${basename(to)}`);
    },
    async rm(p) {
      if (files.delete(n(p))) ops.push(`rm ${basename(p)}`);
    },
    async stat(p) {
      const e = files.get(n(p));
      return e ? { size: e.data.length, mtimeMs: e.mtimeMs } : null;
    },
    async readText(p) {
      const e = files.get(n(p));
      return e ? dec.decode(e.data) : null;
    },
    async writeText(p, text) {
      files.set(n(p), { data: enc.encode(text), mtimeMs: ++clock });
      ops.push(`write ${basename(p)}`);
    },
    async readBytes(p) {
      const e = files.get(n(p));
      if (!e) throw err('ENOENT', p);
      return e.data;
    },
    async writeBytes(p, data) {
      files.set(n(p), { data, mtimeMs: ++clock });
    },
    async mkdir() {},
    async openWrite(p) {
      const chunks: Uint8Array[] = [];
      return {
        write: async (c) => void chunks.push(c),
        close: async () => void files.set(n(p), { data: Buffer.concat(chunks), mtimeMs: ++clock }),
      };
    },
  };
  const put = (p: string, text: string, mtimeMs = ++clock) => files.set(n(p), { data: enc.encode(text), mtimeMs });
  const text = (p: string) => {
    const e = files.get(n(p));
    return e ? dec.decode(e.data) : null;
  };
  const names = (dir: string) =>
    [...files.keys()]
      .filter((k) => k.startsWith(`${dir}/`))
      .map((k) => basename(k))
      .sort();
  return {
    fs,
    ops,
    put,
    text,
    names,
    has: (p: string) => files.has(n(p)),
    state: () => JSON.parse(text(STATE) ?? '{}') as UpdateState,
  };
}

interface FakeChild extends RunLoopChild {
  cmd: string[];
  env: Record<string, string | undefined>;
  kills: (NodeJS.Signals | undefined)[];
  exit(code: number | null): void;
  push(text: string): void;
  closeOut(): void;
}

function harness(o: { platform?: NodeJS.Platform; withStdout?: boolean } = {}) {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const sleeps: { ms: number; resolve: () => void; aborted: boolean }[] = [];
  const killed: number[] = [];
  const clock = { t: T0 };
  let signal: ((s: NodeJS.Signals) => void) | null = null;
  let unsubscribed = false;
  let nextPid = 500;
  const m = memFs();
  const spawn: RunLoopOptions['spawn'] = (cmd, env) => {
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    let out: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stdout = o.withStdout
      ? new ReadableStream<Uint8Array>({
          start(c) {
            out = c;
          },
        })
      : null;
    let done = false;
    const c: FakeChild = {
      cmd,
      env,
      pid: ++nextPid,
      exited,
      stdout,
      stderr: null,
      kills: [],
      kill(s) {
        c.kills.push(s);
      },
      exit(code) {
        if (done) return;
        done = true;
        resolveExit(code);
      },
      push: (text) => out?.enqueue(enc.encode(text)),
      closeOut: () => out?.close(),
    };
    children.push(c);
    return c;
  };
  const sleep: RunLoopOptions['sleep'] = (ms, sig) =>
    new Promise<void>((resolve) => {
      const s = { ms, resolve, aborted: false };
      sleeps.push(s);
      sig?.addEventListener(
        'abort',
        () => {
          s.aborted = true;
          resolve();
        },
        { once: true },
      );
    });
  const run = (extra: Partial<RunLoopOptions> = {}) =>
    runLoop({
      cmd: CMD,
      env: { PATH: '/bin', TELINHA_HOME: '/t' },
      paths: PATHS,
      platform: o.platform ?? 'linux',
      pid: 4242,
      log: (...a) => logs.push(a.join(' ')),
      spawn,
      fs: m.fs,
      now: () => clock.t,
      sleep,
      onSignal: (fn) => {
        signal = fn;
        return () => {
          unsubscribed = true;
        };
      },
      taskkill: (pid) => void killed.push(pid),
      graceMs: 8000,
      ...extra,
    });
  return {
    children,
    logs,
    sleeps,
    killed,
    clock,
    m,
    run,
    signal: (s: NodeJS.Signals) => signal?.(s),
    unsubscribed: () => unsubscribed,
    /** Latest sleep, resolved as if the time passed. */
    wake() {
      const s = sleeps[sleeps.length - 1]!;
      clock.t += s.ms;
      s.resolve();
    },
  };
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const STAGED = { tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: 1, failedStarts: 0 };

describe('runLoop', () => {
  test('spawns telinha run with the supervision env, writes service.pid, exit 0 ends the loop and removes it', async () => {
    const h = harness();
    const done = h.run();
    await settle();
    expect(h.children).toHaveLength(1);
    const c = h.children[0]!;
    expect(c.cmd).toEqual(CMD);
    expect(c.env).toEqual({
      PATH: '/bin',
      TELINHA_HOME: '/t',
      TELINHA_SUPERVISED: '1',
      TELINHA_SUPERVISOR_PID: '4242',
    });
    expect(h.m.text(PIDFILE)).toBe('4242\n');
    c.exit(0);
    expect(await done).toBe(0);
    expect(h.m.has(PIDFILE)).toBe(false);
    expect(h.unsubscribed()).toBe(true);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual(['service: started telinha (pid 501)', 'service: telinha stopped (exit 0)']);
  });

  test('exit 3 respawns at once, no backoff', async () => {
    const h = harness();
    const done = h.run();
    await settle();
    h.children[0]!.exit(3);
    await settle();
    expect(h.children).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toContain('service: telinha asked for a restart');
    h.children[1]!.exit(0);
    expect(await done).toBe(0);
  });

  test('crashes back off 1s, 2s, 4s... up to 60s and reset after 5 minutes up', async () => {
    const h = harness();
    const done = h.run();
    const expected = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000];
    for (const ms of expected) {
      await settle();
      h.children[h.children.length - 1]!.exit(1);
      await settle();
      expect(h.sleeps[h.sleeps.length - 1]!.ms).toBe(ms);
      h.wake();
    }
    await settle();
    expect(h.logs).toContain('service: telinha exited with code 1, restarting in 1s');
    expect(h.logs).toContain('service: telinha exited with code 1, restarting in 60s');
    // A long run resets the exponent.
    h.clock.t += 5 * 60_000;
    h.children[h.children.length - 1]!.exit(2);
    await settle();
    expect(h.sleeps[h.sleeps.length - 1]!.ms).toBe(1000);
    h.wake();
    await settle();
    h.children[h.children.length - 1]!.exit(0);
    expect(await done).toBe(0);
    expect(h.m.state()).toEqual({});
  });

  test('a crash with a staged update counts; the second one rolls back and records failed', async () => {
    const h = harness();
    h.m.put(STATE, JSON.stringify({ staged: STAGED, lastCheck: 7 }));
    h.m.put(`${PATHS.bin}/telinha`, 'bad v0.8.0');
    h.m.put(`${PATHS.bin}/telinha.old-0.7.0`, 'good v0.7.0');
    const done = h.run();
    await settle();
    h.children[0]!.exit(1);
    await settle();
    expect(h.m.state().staged?.failedStarts).toBe(1);
    expect(h.m.text(`${PATHS.bin}/telinha`)).toBe('bad v0.8.0');
    expect(h.logs).toContain('service: v0.8.0 failed to start (exit 1); one more try before rolling back');
    h.wake();
    await settle();
    h.children[1]!.exit(1);
    await settle();
    expect(h.m.text(`${PATHS.bin}/telinha`)).toBe('good v0.7.0');
    expect(h.m.text(`${PATHS.bin}/telinha.failed-v0.8.0`)).toBe('bad v0.8.0');
    expect(h.m.state()).toEqual({
      lastCheck: 7,
      failed: { tag: 'v0.8.0', at: h.clock.t, reason: 'start failed twice (exit 1)' },
    });
    expect(h.sleeps[h.sleeps.length - 1]!.ms).toBe(2000);
    h.wake();
    await settle();
    expect(h.children).toHaveLength(3);
    h.children[2]!.exit(0);
    expect(await done).toBe(0);
  });

  test('rollback falls back to the newest telinha.old-* by mtime when previousFile is gone', async () => {
    const h = harness({ platform: 'win32' });
    h.m.put(STATE, JSON.stringify({ staged: { ...STAGED, previousFile: 'telinha.old-0.7.0.exe', failedStarts: 1 } }));
    h.m.put(`${PATHS.bin}/telinha.exe`, 'bad', 100);
    h.m.put(`${PATHS.bin}/telinha.old-0.5.0.exe`, 'oldest', 10);
    h.m.put(`${PATHS.bin}/telinha.old-0.6.0.exe`, 'newest', 50);
    const done = h.run();
    await settle();
    h.children[0]!.exit(1);
    await settle();
    expect(h.m.text(`${PATHS.bin}/telinha.exe`)).toBe('newest');
    expect(h.m.text(`${PATHS.bin}/telinha.failed-v0.8.0.exe`)).toBe('bad');
    expect(h.m.state().failed?.tag).toBe('v0.8.0');
    expect(h.m.state().staged).toBeUndefined();
    h.wake();
    await settle();
    h.children[1]!.exit(0);
    expect(await done).toBe(0);
  });

  test('exit 3 and exit 0 never count against a staged update', async () => {
    const h = harness();
    h.m.put(STATE, JSON.stringify({ staged: STAGED }));
    const done = h.run();
    await settle();
    h.children[0]!.exit(3);
    await settle();
    expect(h.m.state().staged?.failedStarts).toBe(0);
    h.children[1]!.exit(0);
    expect(await done).toBe(0);
    expect(h.m.state().staged?.failedStarts).toBe(0);
  });

  test('Linux: SIGTERM is forwarded; the loop exits with the child code', async () => {
    const h = harness();
    const done = h.run();
    await settle();
    h.signal('SIGTERM');
    await settle();
    expect(h.children[0]!.kills).toEqual(['SIGTERM']);
    expect(h.logs).toContain('service: SIGTERM received, stopping telinha');
    h.children[0]!.exit(0);
    expect(await done).toBe(0);
    expect(h.children).toHaveLength(1);
    expect(h.m.has(PIDFILE)).toBe(false);
  });

  test('Linux: a child ignoring the signal is SIGKILLed after the grace period', async () => {
    const h = harness();
    const done = h.run();
    await settle();
    h.signal('SIGINT');
    await settle();
    expect(h.sleeps.map((s) => s.ms)).toEqual([8000]);
    h.wake();
    await settle();
    expect(h.children[0]!.kills).toEqual(['SIGINT', 'SIGKILL']);
    h.children[0]!.exit(null);
    expect(await done).toBe(1);
  });

  test('Windows: no signal to forward (the console event reached the child); taskkill /T after the grace period', async () => {
    const h = harness({ platform: 'win32' });
    const done = h.run();
    await settle();
    h.signal('SIGHUP');
    await settle();
    expect(h.children[0]!.kills).toEqual([]);
    h.wake();
    await settle();
    expect(h.killed).toEqual([501]);
    h.children[0]!.exit(1);
    expect(await done).toBe(1);
  });

  test('a signal during the backoff sleep ends the loop with the last exit code', async () => {
    const h = harness();
    const done = h.run();
    await settle();
    h.children[0]!.exit(1);
    await settle();
    expect(h.sleeps).toHaveLength(1);
    h.signal('SIGTERM');
    expect(await done).toBe(1);
    expect(h.sleeps[0]!.aborted).toBe(true);
    expect(h.children).toHaveLength(1);
  });

  test('child output is relayed line by line with its own timestamp stripped', async () => {
    const h = harness({ withStdout: true });
    const done = h.run();
    await settle();
    const c = h.children[0]!;
    c.push('2026-10-05T12:00:00.000Z telinha 0.8.0 starting\n2026-10-05T12:00:01.123Z [livekit] ');
    c.push('up\r\nplain line without a timestamp\n');
    await settle();
    expect(h.logs.slice(1)).toEqual(['telinha 0.8.0 starting', '[livekit] up', 'plain line without a timestamp']);
    c.push('tail');
    c.closeOut();
    c.exit(0);
    expect(await done).toBe(0);
    expect(h.logs).toContain('tail');
  });
});
