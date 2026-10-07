import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliContext } from '../src/cli/args.ts';
import type { UpdateMode, UpdateResult } from '../src/cli/control.ts';
import { run, UPDATE_FLAGS } from '../src/cli/update.ts';
import { resolvePaths } from '../src/paths.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NONE: UpdateResult = {
  current: '0.7.0',
  latest: 'v0.7.0',
  pin: null,
  target: null,
  staged: null,
  failed: null,
  pending: null,
  deferredSince: null,
  action: 'none',
  message: 'up to date (0.7.0)',
};
const STAGED: UpdateResult = {
  ...NONE,
  latest: 'v0.8.0',
  target: 'v0.8.0',
  staged: { tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: 1, failedStarts: 0 },
  action: 'staged',
  message: 'v0.8.0 installed; restarting to apply it',
};

function ctx(o: { argv: string[]; compiled?: boolean; locale?: 'en' | 'pt-BR'; envFileText?: string }) {
  const home = mkdtempSync(join(tmpdir(), 'telinha-upd-'));
  dirs.push(home);
  mkdirSync(join(home, 'config'), { recursive: true });
  const envFile = join(home, 'config', 'telinha.env');
  if (o.envFileText !== undefined) writeFileSync(envFile, o.envFileText);
  const out: string[] = [];
  const err: string[] = [];
  const c: CliContext = {
    argv: o.argv,
    env: { TELINHA_HOME: home },
    paths: resolvePaths({ TELINHA_HOME: home }),
    envFile,
    locale: o.locale ?? 'en',
    tty: false,
    yes: false,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    compiled: o.compiled ?? true,
    version: '0.7.0',
  };
  return { ctx: c, out, err };
}

const args = { flags: {}, positionals: [], rest: [] };

function control(available: boolean, result: UpdateResult = NONE) {
  const modes: UpdateMode[] = [];
  return {
    modes,
    client: { available: async () => available, update: async (mode: UpdateMode) => (modes.push(mode), result) },
  };
}

function updater(result: UpdateResult) {
  const modes: UpdateMode[] = [];
  const made: { current: string; pin: string | null }[] = [];
  const factory = (o: { current: string; pin: string | null }) => {
    made.push(o);
    return { update: async (mode: UpdateMode) => (modes.push(mode), { ...result, pin: o.pin }) };
  };
  return { modes, made, factory };
}

describe('telinha update', () => {
  test('flags', () => {
    expect(UPDATE_FLAGS).toEqual({ check: 'boolean', now: 'boolean' });
  });

  test('service running: --check asks it to look, the default honours the deferral, --now does not', async () => {
    for (const [argv, mode] of [
      [['update', '--check'], 'check'],
      [['update'], 'scheduled'],
      [['update', '--now'], 'now'],
    ] as const) {
      const c = control(true, NONE);
      const t = ctx({ argv: [...argv] });
      expect(await run(args, t.ctx, { control: c.client })).toBe(0);
      expect(c.modes).toEqual([mode]);
      expect(t.out).toContain('Telinha 0.7.0');
      expect(t.out).toContain('Newest stable release: v0.7.0');
      expect(t.out).toContain('Up to date.');
    }
  });

  test('service running, update staged: says the service restarts', async () => {
    const c = control(true, STAGED);
    const t = ctx({ argv: ['update'] });
    expect(await run(args, t.ctx, { control: c.client })).toBe(0);
    expect(t.out).toContain('Asking the running service...');
    expect(t.out).toContain('v0.8.0 installed; the service is restarting to apply it.');
  });

  test('deferred: how many rooms and which version, exit 0', async () => {
    const c = control(true, {
      ...NONE,
      latest: 'v0.8.0',
      target: 'v0.8.0',
      deferredSince: 5,
      action: 'deferred',
      message: '3 room(s) open, will update to v0.8.0 when they close',
    });
    const t = ctx({ argv: ['update'], locale: 'pt-BR' });
    expect(await run(args, t.ctx, { control: c.client })).toBe(0);
    expect(t.out).toContain(
      '3 sala(s) aberta(s); a atualização pra v0.8.0 é aplicada quando elas fecharem (telinha update --now não espera).',
    );
  });

  test('failed and pending results exit 1 and explain', async () => {
    const failed = control(true, {
      ...NONE,
      latest: 'v0.8.0',
      target: 'v0.8.0',
      failed: { tag: 'v0.8.0', at: 1, reason: 'sha256 mismatch' },
      action: 'failed',
      message: 'x',
    });
    const f = ctx({ argv: ['update'] });
    expect(await run(args, f.ctx, { control: failed.client })).toBe(1);
    expect(f.out).toContain(
      'v0.8.0 failed: sha256 mismatch. Skipped until a newer release; telinha update --now retries it.',
    );

    const pending = control(true, {
      ...NONE,
      latest: 'v0.8.0',
      target: 'v0.8.0',
      pending: { tag: 'v0.8.0', since: 1 },
      action: 'pending',
      message: 'x',
    });
    const p = ctx({ argv: ['update', '--now'] });
    expect(await run(args, p.ctx, { control: pending.client })).toBe(1);
    expect(p.out).toContain('v0.8.0 is not downloadable yet; it will be retried.');
  });

  test('service not running, not compiled: native installs only (but --check still works)', async () => {
    const t = ctx({ argv: ['update'], compiled: false });
    expect(await run(args, t.ctx, { control: control(false).client })).toBe(1);
    expect(t.err).toEqual([
      'Updates apply to native installs only. Docker: docker compose pull; from a clone: git pull.',
    ]);
    const u = updater({ ...NONE, latest: 'v0.8.0', target: 'v0.8.0', message: 'v0.8.0 is available' });
    const c = ctx({ argv: ['update', '--check'], compiled: false });
    expect(await run(args, c.ctx, { control: control(false).client, updater: u.factory })).toBe(0);
    expect(u.modes).toEqual(['check']);
    expect(c.out).toContain('v0.8.0 is available.');
  });

  test('service not running, compiled: stages here and says to start telinha; nothing to defer so default = now', async () => {
    for (const argv of [['update'], ['update', '--now']]) {
      const u = updater(STAGED);
      const t = ctx({ argv, envFileText: 'UPDATE_PIN=v0.8.0\nLOCALE=en\n' });
      expect(await run(args, t.ctx, { control: control(false).client, updater: u.factory })).toBe(0);
      expect(u.modes).toEqual(['now']);
      expect(u.made).toEqual([{ current: '0.7.0', pin: 'v0.8.0' }]);
      expect(t.out).toContain('Pinned to v0.8.0 (UPDATE_PIN)');
      expect(t.out).toContain('v0.8.0 installed; start Telinha to use it.');
    }
  });

  test('root, service down, bin/ owned by the service user: never stages there itself', async () => {
    const u = updater(STAGED);
    const t = ctx({ argv: ['update'] });
    expect(
      await run(args, t.ctx, { control: control(false).client, updater: u.factory, uid: 0, binOwner: () => 998 }),
    ).toBe(1);
    expect(u.modes).toEqual([]);
    expect(t.err.join('\n')).toContain('The service updates itself here');
    // --check writes nothing: still allowed.
    expect(
      await run(args, ctx({ argv: ['update', '--check'] }).ctx, {
        control: control(false).client,
        updater: u.factory,
        uid: 0,
        binOwner: () => 998,
      }),
    ).toBe(0);
  });

  test('the pin also comes from the process environment, and no file means no pin', async () => {
    const u = updater(NONE);
    const t = ctx({ argv: ['update', '--check'] });
    t.ctx.env.UPDATE_PIN = 'v0.6.0';
    await run(args, t.ctx, { control: control(false).client, updater: u.factory });
    expect(u.made[0]?.pin).toBe('v0.6.0');
    const none = updater(NONE);
    const n = ctx({ argv: ['update', '--check'] });
    await run(args, n.ctx, { control: control(false).client, updater: none.factory });
    expect(none.made[0]?.pin).toBeNull();
  });

  test('offline: latest unknown is said so', async () => {
    const u = updater({ ...NONE, latest: null });
    const t = ctx({ argv: ['update', '--check'] });
    await run(args, t.ctx, { control: control(false).client, updater: u.factory });
    expect(t.out).toContain('Newest stable release: unknown (offline, or none published)');
  });

  test('an unknown or secret flag: usage, exit 2, nothing asked of the service', async () => {
    for (const argv of [
      ['update', '--nwo'],
      ['update', '--check', '--discord-token', 'x'],
    ]) {
      const c = control(true, NONE);
      const t = ctx({ argv });
      expect(await run({ flags: {}, positionals: ['update'], rest: [] }, t.ctx, { control: c.client })).toBe(2);
      expect(c.modes).toEqual([]);
      expect(t.err.at(-1)).toContain('Usage: telinha update');
    }
  });
});
