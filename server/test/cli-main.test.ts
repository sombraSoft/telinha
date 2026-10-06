import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliContext, ParsedArgs } from '../src/cli/args.ts';
import { main, scanGlobals, type MainDeps } from '../src/cli/main.ts';
import { versionLine } from '../src/version.ts';

const home = mkdtempSync(join(tmpdir(), 'telinha-main-'));
const configured = mkdtempSync(join(tmpdir(), 'telinha-main-env-'));
mkdirSync(join(configured, 'config'));
writeFileSync(join(configured, 'config', 'telinha.env'), 'PUBLIC_URL=https://t.example.com\n');
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configured, { recursive: true, force: true });
});

function harness(o: Partial<MainDeps> & { tty?: boolean; homeDir?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { cmd: string; args?: ParsedArgs; ctx: CliContext; pause?: boolean }[] = [];
  const runner = (cmd: string) => async (args: ParsedArgs, ctx: CliContext) => (calls.push({ cmd, args, ctx }), 7);
  const deps: MainDeps = {
    env: { TELINHA_HOME: o.homeDir ?? home, LANG: 'en_US.UTF-8' },
    stdinTty: o.tty ?? false,
    stdoutTty: o.tty ?? false,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    commands: { setup: runner('setup'), doctor: runner('doctor'), update: runner('update'), service: runner('service') },
    run: async (ctx, r) => void calls.push({ cmd: 'run', ctx, pause: r.pauseOnError }),
    offerSetup: async (ctx) => (calls.push({ cmd: 'offer', ctx }), 5),
    waitForEnter: async () => void calls.push({ cmd: 'enter', ctx: undefined as never }),
    ...o,
  };
  return { deps, out, err, calls, main: (argv: string[]) => main(argv, deps) };
}

describe('scanGlobals', () => {
  test('the command is the first bare word that is not a --home/--lang value', () => {
    expect(scanGlobals(['--home', 'D:\\x', 'service', 'install', '--firewall'])).toMatchObject({ command: 'service', positionals: ['install'], home: 'D:\\x' });
    expect(scanGlobals(['--lang=pt-BR', '-y', 'doctor', '--json'])).toMatchObject({ command: 'doctor', lang: 'pt-BR', yes: true });
    expect(scanGlobals([])).toMatchObject({ command: null, help: false, version: false });
    expect(scanGlobals(['help', 'update'])).toMatchObject({ command: 'help', positionals: ['update'] });
    expect(scanGlobals(['setup', '--', 'x'])).toMatchObject({ command: 'setup', positionals: [] });
  });
});

describe('main', () => {
  test('--version / -v: the version line, exit 0, nothing else runs', async () => {
    for (const argv of [['--version'], ['-v'], ['doctor', '-v']]) {
      const h = harness();
      expect(await h.main(argv)).toBe(0);
      expect(h.out).toEqual([versionLine()]);
      expect(h.calls).toEqual([]);
    }
  });

  test('help, --help and help <command>', async () => {
    let h = harness();
    expect(await h.main(['help'])).toBe(0);
    expect(h.out[0]).toContain('Usage: telinha [command] [flags]');
    h = harness();
    expect(await h.main(['--help'])).toBe(0);
    expect(h.out[0]).toContain('Commands:');
    h = harness();
    expect(await h.main(['help', 'doctor'])).toBe(0);
    expect(h.out[0]).toStartWith('Usage: telinha doctor');
    h = harness();
    expect(await h.main(['service', '--help'])).toBe(0);
    expect(h.out[0]).toStartWith('Usage: telinha service');
    h = harness();
    expect(await h.main(['--lang', 'pt-BR', 'help'])).toBe(0);
    expect(h.out[0]).toContain('Uso: telinha');
    h = harness();
    expect(await h.main(['help', 'nope'])).toBe(2);
  });

  test('unknown command: usage on stderr, exit 2', async () => {
    const h = harness();
    expect(await h.main(['frobnicate'])).toBe(2);
    expect(h.err).toEqual(['unknown command frobnicate', 'Usage: telinha [command] [flags]. Run telinha help for the list of commands.']);
    expect(h.calls).toEqual([]);
  });

  test('subcommands get the full argv in the context and their exit code is returned', async () => {
    for (const cmd of ['setup', 'doctor', 'update', 'service']) {
      const h = harness();
      expect(await h.main([cmd, '--yes', 'x'])).toBe(7);
      expect(h.calls.map((c) => c.cmd)).toEqual([cmd]);
      expect(h.calls[0]!.ctx.argv).toEqual([cmd, '--yes', 'x']);
      expect(h.calls[0]!.ctx.yes).toBe(true);
      expect(h.calls[0]!.args!.positionals).toEqual([cmd, 'x']);
    }
  });

  test('--home is TELINHA_HOME for the command; --lang picks the language', async () => {
    const h = harness();
    await h.main(['doctor', '--home', configured, '--lang', 'pt-BR']);
    const ctx = h.calls[0]!.ctx;
    expect(ctx.paths.home).toBe(configured);
    expect(ctx.envFile).toBe(join(configured, 'config', 'telinha.env'));
    expect(ctx.locale).toBe('pt-BR');
  });

  test('a bad --lang is a usage error', async () => {
    const h = harness();
    expect(await h.main(['doctor', '--lang', 'fr'])).toBe(2);
    expect(h.err[0]).toContain('--lang must be en or pt-BR');
  });

  test('run is the default; it returns null (the service lives on)', async () => {
    for (const argv of [[], ['run'], ['run', '--home', configured]]) {
      const h = harness();
      expect(await h.main(argv)).toBeNull();
      expect(h.calls.map((c) => [c.cmd, c.pause])).toEqual([['run', false]]);
    }
  });

  test('run takes the global flags only', async () => {
    let h = harness();
    expect(await h.main(['run', '--json'])).toBe(2);
    expect(h.err[0]).toBe('unknown flag --json');
    h = harness();
    expect(await h.main(['run', 'now'])).toBe(2);
    expect(h.calls).toEqual([]);
  });

  test('no arguments on a TTY without telinha.env: the setup offer instead of a config error', async () => {
    const h = harness({ tty: true });
    expect(await h.main([])).toBe(5);
    // The console stays open until Enter: the next steps (or the error) stay readable.
    expect(h.calls.map((c) => c.cmd)).toEqual(['offer', 'enter']);
    // Declined: nothing else happens, but the window still waits.
    const declined = harness({ tty: true, offerSetup: async () => null });
    expect(await declined.main([])).toBe(0);
    expect(declined.calls.map((c) => c.cmd)).toEqual(['enter']);
    // The wizard threw: the error is printed, then the window waits.
    const failed = harness({ tty: true, offerSetup: async () => { throw new Error('boom'); } });
    expect(await failed.main([])).toBe(1);
    expect(failed.err).toEqual(['telinha: boom']);
    expect(failed.calls.map((c) => c.cmd)).toEqual(['enter']);
  });

  test('with a telinha.env, or arguments, or no TTY: run (pausing on errors only when double-clicked)', async () => {
    let h = harness({ tty: true, homeDir: configured });
    expect(await h.main([])).toBeNull();
    expect(h.calls.map((c) => [c.cmd, c.pause])).toEqual([['run', true]]);
    h = harness({ tty: true });
    expect(await h.main(['run'])).toBeNull();
    expect(h.calls.map((c) => [c.cmd, c.pause])).toEqual([['run', false]]);
    h = harness({ tty: false });
    expect(await h.main([])).toBeNull();
    expect(h.calls.map((c) => c.cmd)).toEqual(['run']);
    // Docker style: no file, the config comes from the environment.
    h = harness({ tty: true, env: { TELINHA_HOME: home, PUBLIC_URL: 'https://t.example.com' } });
    expect(await h.main([])).toBeNull();
    expect(h.calls.map((c) => c.cmd)).toEqual(['run']);
  });
});
