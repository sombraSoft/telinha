import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliContext } from '../src/cli/args.ts';
import { ACTIONS, elevateCommand, run, serviceSpec } from '../src/cli/service.ts';
import { NotElevatedError, ServiceInstallError, type InstallOptions, type InstallResult, type ServiceManager, type ServiceStatus } from '../src/service/index.ts';
import type { RunLoopOptions } from '../src/service/runloop.ts';
import { resolvePaths } from '../src/paths.ts';

const WIN_HOME = 'C:\\Users\\ana\\AppData\\Local\\Telinha';
const LINUX_HOME = '/opt/telinha';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctx(o: { argv: string[]; platform?: 'win32' | 'linux'; compiled?: boolean; locale?: 'en' | 'pt-BR' }) {
  const platform = o.platform ?? 'win32';
  const home = platform === 'win32' ? WIN_HOME : LINUX_HOME;
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ TELINHA_HOME: home }, platform);
  const c: CliContext = {
    argv: o.argv, env: { TELINHA_HOME: home }, paths, envFile: `${paths.config}/telinha.env`, locale: o.locale ?? 'en', tty: false, yes: false,
    stdout: (l) => out.push(l), stderr: (l) => err.push(l), compiled: o.compiled ?? true, version: '0.7.0',
  };
  return { ctx: c, out, err, platform, home, paths };
}

const args = { flags: {}, positionals: [], rest: [] };
const OK: InstallResult = { ok: true, steps: { task: 'ok', firewall: 'ok', start: 'ok' }, hints: ['loginctl enable-linger ana'] };

function fakeManager(o: { kind?: ServiceManager['kind']; status?: ServiceStatus; install?: (opts: InstallOptions) => Promise<InstallResult>; fail?: string } = {}) {
  const calls: string[] = [];
  const installs: InstallOptions[] = [];
  const m: ServiceManager = {
    kind: o.kind ?? 'windows-task',
    async install(opts) {
      calls.push('install');
      installs.push(opts);
      return o.install ? o.install(opts) : OK;
    },
    async uninstall(opts) {
      calls.push(`uninstall firewall=${opts.firewall}`);
      if (o.fail) throw new Error(o.fail);
    },
    async start() {
      calls.push('start');
      if (o.fail) throw new Error(o.fail);
    },
    async stop() {
      calls.push('stop');
    },
    async restart() {
      calls.push('restart');
    },
    async status() {
      calls.push('status');
      return o.status ?? { installed: true, running: true, enabled: true, detail: 'task Ready, last result 0; telinha answering' };
    },
  };
  return { manager: m, calls, installs };
}

describe('telinha service', () => {
  test('the spec: --user takes a value on Windows and is a switch on Linux', () => {
    expect(serviceSpec('win32').flags.user).toBe('string');
    expect(serviceSpec('linux').flags.user).toBe('boolean');
    expect(Object.keys(serviceSpec('linux').flags)).toEqual(expect.arrayContaining(['firewall', 'sid', 'result', 'log-file', 'home', 'lang']));
    expect(ACTIONS).toEqual(['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'run']);
  });

  test('no action or an unknown one: usage, exit 2', async () => {
    const none = ctx({ argv: ['service'] });
    expect(await run(args, none.ctx, { manager: fakeManager().manager })).toBe(2);
    expect(none.err[0]).toContain('Usage: telinha service install');
    const bad = ctx({ argv: ['service', 'frobnicate'], locale: 'pt-BR' });
    expect(await run(args, bad.ctx, { manager: fakeManager().manager })).toBe(2);
    expect(bad.err[0]).toBe('ação de service desconhecida frobnicate');
  });

  test('an unknown or secret flag: usage, exit 2, the manager untouched', async () => {
    for (const argv of [['service', 'stop', '--forse'], ['service', 'install', '--tunnel-token', 'x']]) {
      const t = ctx({ argv, platform: 'linux' });
      const m = fakeManager();
      expect(await run(args, t.ctx, { manager: m.manager, platform: 'linux' })).toBe(2);
      expect(m.calls).toEqual([]);
      expect(t.err.at(-1)).toContain('Usage: telinha service install');
    }
  });

  test('start / stop / restart / uninstall call the manager; --firewall reaches uninstall', async () => {
    const f = fakeManager();
    for (const [action, expected] of [['start', 'start'], ['stop', 'stop'], ['restart', 'restart']] as const) {
      const t = ctx({ argv: ['service', action] });
      expect(await run(args, t.ctx, { manager: f.manager })).toBe(0);
      expect(f.calls.at(-1)).toBe(expected);
      expect(t.out).toHaveLength(1);
    }
    const u = ctx({ argv: ['service', 'uninstall', '--firewall'] });
    expect(await run(args, u.ctx, { manager: f.manager })).toBe(0);
    expect(f.calls.at(-1)).toBe('uninstall firewall=true');
    expect(u.out[0]).toBe(`Service removed; the files in ${WIN_HOME} stay.`);
  });

  test('a failing action prints the error and exits 1', async () => {
    const f = fakeManager({ fail: 'schtasks exited with code 1: ERROR: Access is denied.' });
    const t = ctx({ argv: ['service', 'start'] });
    expect(await run(args, t.ctx, { manager: f.manager })).toBe(1);
    expect(t.err).toEqual(['service start failed: schtasks exited with code 1: ERROR: Access is denied.']);
  });

  test('status: one summary line plus the detail; exit 0 only when installed and running', async () => {
    const up = ctx({ argv: ['service', 'status'] });
    expect(await run(args, up.ctx, { manager: fakeManager().manager })).toBe(0);
    expect(up.out).toEqual(['Service (windows-task): installed, running, starts at boot', '  task Ready, last result 0; telinha answering']);
    const down = ctx({ argv: ['service', 'status'], locale: 'pt-BR' });
    expect(await run(args, down.ctx, { manager: fakeManager({ kind: 'systemd-system', status: { installed: true, running: false, enabled: false, detail: 'inactive (dead)' } }).manager })).toBe(1);
    expect(down.out[0]).toBe('Serviço (systemd-system): instalado, parado, não inicia com o sistema');
  });

  test('install: the flags become InstallOptions, steps and hints are printed', async () => {
    const f = fakeManager();
    const t = ctx({ argv: ['service', 'install', '--firewall', '--user', 'PC\\ana', '--sid', 'S-1-5-21-1-2-3-1001', '--result', `${WIN_HOME}\\service\\install-result.json`] });
    expect(await run(args, t.ctx, { manager: f.manager, platform: 'win32' })).toBe(0);
    expect(f.installs).toEqual([{
      firewall: true, exe: `${WIN_HOME}\\bin\\telinha.exe`, home: WIN_HOME, locale: 'en', user: 'PC\\ana', sid: 'S-1-5-21-1-2-3-1001', resultFile: `${WIN_HOME}\\service\\install-result.json`,
    }]);
    expect(t.out).toEqual([
      'service registration: ok', 'firewall rules: ok', 'start: ok',
      'Still to do by hand: loginctl enable-linger ana',
      'Without it Telinha stops whenever you log out of this machine (an SSH session ending counts).',
      'Telinha runs as a service now (windows-task).',
    ]);
  });

  test('install on Linux: --user is a switch, the exe has no extension', async () => {
    const f = fakeManager({ kind: 'systemd-user' });
    const t = ctx({ argv: ['service', 'install', '--user'], platform: 'linux' });
    expect(await run(args, t.ctx, { manager: f.manager, platform: 'linux' })).toBe(0);
    expect(f.installs[0]).toMatchObject({ firewall: false, exe: '/opt/telinha/bin/telinha', home: '/opt/telinha', user: undefined });
  });

  test('install without the native binary is refused', async () => {
    const f = fakeManager();
    const t = ctx({ argv: ['service', 'install'], compiled: false });
    expect(await run(args, t.ctx, { manager: f.manager })).toBe(1);
    expect(f.calls).toEqual([]);
    expect(t.err[0]).toContain('native Telinha binary');
  });

  test('install failure: every step printed, the error on stderr, exit 1', async () => {
    const result: InstallResult = { ok: false, steps: { task: 'ok', firewall: 'failed: netsh could not add rule "Telinha HTTP": nope', start: 'skipped' }, hints: [] };
    const f = fakeManager({ install: async () => { throw new ServiceInstallError(result); } });
    const t = ctx({ argv: ['service', 'install', '--firewall'], locale: 'pt-BR' });
    expect(await run(args, t.ctx, { manager: f.manager })).toBe(1);
    expect(t.out).toEqual(['registro do serviço: ok', 'regras de firewall: netsh could not add rule "Telinha HTTP": nope', 'início: pulado']);
    expect(t.err).toEqual([]);
  });

  test('not elevated: the hint carries the same command line, elevated', async () => {
    const exe = `${WIN_HOME}\\bin\\telinha.exe`;
    const f = fakeManager({ install: async () => { throw new NotElevatedError(exe); } });
    const t = ctx({ argv: ['service', 'install', '--firewall'] });
    expect(await run(args, t.ctx, { manager: f.manager })).toBe(1);
    expect(t.err).toEqual([`service install needs an administrator terminal. Open one and run: ${elevateCommand(exe, ['service', 'install', '--firewall'])}`]);
    expect(elevateCommand(exe, ['service', 'install', '--home', "C:\\it's"])).toBe(
      `powershell -Command "Start-Process -FilePath '${exe}' -ArgumentList 'service','install','--home','C:\\it''s' -Verb RunAs"`,
    );
  });

  test('no service manager on this host', async () => {
    const t = ctx({ argv: ['service', 'status'] });
    expect(await run(args, t.ctx, { manager: null, platform: 'darwin' })).toBe(1);
    expect(t.err[0]).toContain('no service manager for this system (darwin)');
  });

  test('without an injected manager the real factory runs with the injected spawn: Linux --user picks the user unit', async () => {
    const calls: string[][] = [];
    const t = ctx({ argv: ['service', 'status', '--user'], platform: 'linux' });
    const code = await run(args, t.ctx, {
      platform: 'linux', isRoot: true,
      spawn: async (cmd) => (calls.push(cmd), { code: 3, stdout: 'inactive\n', stderr: '' }),
      fs: { readText: async () => null, writeFile: async () => {}, exists: async () => false, rm: async () => {}, mkdir: async () => {} },
      control: { available: async () => false, shutdown: async () => {} },
    });
    expect(code).toBe(1);
    expect(t.out[0]).toBe('Service (systemd-user): not installed, not running, does not start at boot');
    expect(calls[0]).toEqual(['systemctl', '--user', 'is-active', 'telinha']);
  });

  test('run: the loop gets <bin>/telinha run --home <home>, the env with TELINHA_HOME, a rotating log file, and its exit code comes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'telinha-svc-'));
    dirs.push(dir);
    const logFile = join(dir, 'logs', 'telinha.log');
    const seen: RunLoopOptions[] = [];
    const t = ctx({ argv: ['service', 'run', '--log-file', logFile] });
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    let code: number;
    try {
      code = await run(args, t.ctx, {
        runLoop: async (o) => {
          seen.push(o);
          o.log('service: hello');
          return 3;
        },
        pid: 77,
        platform: 'win32',
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(3);
    expect(seen[0]!.cmd).toEqual([`${WIN_HOME}\\bin\\telinha.exe`, 'run', '--home', WIN_HOME]);
    expect(seen[0]!.env).toEqual({ TELINHA_HOME: WIN_HOME });
    expect(seen[0]!.paths).toBe(t.paths);
    expect(seen[0]!.platform).toBe('win32');
    expect(seen[0]!.pid).toBe(77);
    expect(readFileSync(logFile, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z service: hello\n$/);
  });

  test('run in dev on Linux: bun + the script instead of the binary; stdout only (the journal)', async () => {
    const seen: RunLoopOptions[] = [];
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const t = ctx({ argv: ['service', 'run'], platform: 'linux', compiled: false });
      await run(args, t.ctx, {
        runLoop: async (o) => {
          seen.push(o);
          o.log('service: hi');
          return 0;
        },
        platform: 'linux', execPath: '/usr/bin/bun', script: '/src/server/src/index.ts',
      });
      expect(seen[0]!.cmd).toEqual(['/usr/bin/bun', '/src/server/src/index.ts', 'run', '--home', LINUX_HOME]);
      expect(spy).toHaveBeenCalledWith(expect.any(String), 'service: hi');
    } finally {
      spy.mockRestore();
    }
  });
});
