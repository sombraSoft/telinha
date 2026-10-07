import { describe, expect, test } from 'bun:test';
import type { CliContext } from '../src/cli/args.ts';
import { ts } from '../src/cli/strings.ts';
import { run, TRAY_ACTIONS, type TrayCliDeps } from '../src/cli/tray.ts';
import { resolvePaths } from '../src/paths.ts';
import type { SpawnOutcome } from '../src/service/index.ts';
import { elevationTypeCommand } from '../src/service/windows.ts';

const ELEVATION_TYPE = elevationTypeCommand()[4];

const HOME = 'D:\\Telinha Casa';
const EXE = `${HOME}\\bin\\telinha-tray.exe`;
const STATE = `${HOME}\\data\\run\\tray.json`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const T0 = 1_700_000_000_000;
const args = { flags: {}, positionals: [], rest: [] };

function harness(
  argv: string[],
  o: {
    platform?: NodeJS.Platform;
    locale?: 'en' | 'pt-BR';
    files?: Record<string, string>;
    procs?: Map<number, string>;
    elevated?: boolean | 'no-uac';
    autostart?: string | null;
    respond?: (cmd: string[]) => Partial<SpawnOutcome> | undefined;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const paths = resolvePaths({ TELINHA_HOME: HOME }, 'win32');
  const ctx: CliContext = {
    argv,
    env: { TELINHA_HOME: HOME, PATH: 'C:\\Windows', LOCALE: 'en', UNSET: undefined },
    paths,
    envFile: `${paths.config}\\telinha.env`,
    locale: o.locale ?? 'en',
    tty: false,
    yes: false,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    compiled: true,
    version: '0.7.0',
  };
  const files = new Map(Object.entries(o.files ?? {}));
  const procs = o.procs ?? new Map<number, string>();
  const calls: string[][] = [];
  const launches: { exe: string; env: Record<string, string> }[] = [];
  const clock = { t: T0 };
  const deps: TrayCliDeps = {
    platform: o.platform ?? 'win32',
    spawn: async (cmd) => {
      calls.push(cmd);
      // 2: elevated through UAC; 1: an administrator with UAC off; 3: a normal UAC session.
      if (cmd[4] === ELEVATION_TYPE)
        return { code: 0, stdout: o.elevated === 'no-uac' ? '1\r\n' : o.elevated ? '2\r\n' : '3\r\n', stderr: '' };
      if (cmd[0] === 'reg' && cmd[1] === 'query') {
        return o.autostart
          ? {
              code: 0,
              stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Telinha    REG_SZ    ${o.autostart}\r\n`,
              stderr: '',
            }
          : { code: 1, stdout: '', stderr: 'ERROR' };
      }
      return { code: 0, stdout: '', stderr: '', ...o.respond?.(cmd) };
    },
    fs: {
      readText: async (p) => files.get(p) ?? null,
      exists: async (p) => files.has(p),
      rm: async (p) => void files.delete(p),
    },
    processInfo: (pid) => (procs.has(pid) ? { alive: true, exe: procs.get(pid)! } : { alive: false, exe: null }),
    launcher: { launch: (exe, env) => void launches.push({ exe, env }) },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  };
  return { run: () => run(args, ctx, deps), out, err, calls, launches, files, clock };
}

const running = { [EXE]: 'MZ', [STATE]: JSON.stringify({ version: '0.7.0', pid: 4321, startedAt: T0, exe: EXE }) };
const trayProc = () => new Map([[4321, 'telinha-tray.exe']]);

describe('telinha tray', () => {
  test('the actions the docs list', () => {
    expect(TRAY_ACTIONS).toEqual(['start', 'stop', 'status', 'autostart']);
  });

  test('usage errors exit 2 with the tray help', async () => {
    for (const argv of [
      ['tray'],
      ['tray', 'nope'],
      ['tray', 'autostart'],
      ['tray', 'autostart', 'maybe'],
      ['tray', 'start', 'now'],
      ['tray', 'status', '--json'],
    ]) {
      const h = harness(argv);
      expect(await h.run()).toBe(2);
      expect(h.err.at(-1)).toBe(ts('en', 'helpTray'));
      expect(h.calls).toEqual([]);
    }
    const h = harness(['tray', 'nope']);
    await h.run();
    expect(h.err[0]).toBe('unknown tray action nope');
  });

  test('not Windows: exit 1, in either language', async () => {
    let h = harness(['tray', 'status'], { platform: 'linux' });
    expect(await h.run()).toBe(1);
    expect(h.err).toEqual(['the tray exists on Windows only']);
    h = harness(['tray', 'start'], { platform: 'darwin', locale: 'pt-BR' });
    expect(await h.run()).toBe(1);
    expect(h.err).toEqual(['o ícone na bandeja só existe no Windows']);
  });

  test('start: launches bin\\telinha-tray.exe with the environment plus TELINHA_HOME', async () => {
    const h = harness(['--home', HOME, 'tray', 'start'], { files: { [EXE]: 'MZ' } });
    expect(await h.run()).toBe(0);
    expect(h.out).toEqual(['Tray icon started.']);
    expect(h.launches).toEqual([{ exe: EXE, env: { TELINHA_HOME: HOME, PATH: 'C:\\Windows', LOCALE: 'en' } }]);
    // The elevation check ran first.
    expect(h.calls.map((c) => c[0])).toEqual(['powershell']);
  });

  test('start from an elevated terminal: refused, exit 1, nothing launched', async () => {
    let h = harness(['tray', 'start'], { files: { [EXE]: 'MZ' }, elevated: true });
    expect(await h.run()).toBe(1);
    expect(h.err).toEqual([
      'Running as administrator: the tray icon was not started; run telinha tray start from a normal terminal.',
    ]);
    expect(h.launches).toEqual([]);
    h = harness(['tray', 'start'], { files: { [EXE]: 'MZ' }, elevated: true, locale: 'pt-BR' });
    expect(await h.run()).toBe(1);
    expect(h.err).toEqual([
      'Rodando como administrador: o ícone na bandeja não foi iniciado; rode telinha tray start num terminal normal.',
    ]);
  });

  test('start as an administrator with UAC off: no normal session exists, so the tray starts', async () => {
    const h = harness(['tray', 'start'], { files: { [EXE]: 'MZ' }, elevated: 'no-uac' });
    expect(await h.run()).toBe(0);
    expect(h.out).toEqual(['Tray icon started.']);
    expect(h.launches.length).toBe(1);
  });

  test('start: already running is fine; a missing exe points at setup', async () => {
    let h = harness(['tray', 'start'], { files: running, procs: trayProc() });
    expect(await h.run()).toBe(0);
    expect(h.out).toEqual(['Tray icon already running.']);
    expect(h.launches).toEqual([]);
    h = harness(['tray', 'start']);
    expect(await h.run()).toBe(1);
    expect(h.err).toEqual([`telinha-tray.exe is not in ${HOME}\\bin; run telinha setup again`]);
    expect(h.calls).toEqual([]);
  });

  test('start: a stale tray.json (pid reused) does not count as running', async () => {
    const h = harness(['tray', 'start'], { files: running, procs: new Map([[4321, 'explorer.exe']]) });
    expect(await h.run()).toBe(0);
    expect(h.launches.length).toBe(1);
  });

  test('stop: taskkill the pid tray.json names; not running is exit 0 too', async () => {
    let h = harness(['tray', 'stop'], { files: running, procs: trayProc() });
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual([
      ['taskkill', '/PID', '4321'],
      ['taskkill', '/F', '/PID', '4321'],
    ]);
    expect(h.out).toEqual(['Tray icon stopped.']);
    h = harness(['tray', 'stop'], { locale: 'pt-BR' });
    expect(await h.run()).toBe(0);
    expect(h.out).toEqual(['O ícone na bandeja não está rodando.']);
  });

  test('status: running (exit 0), not running and not installed (exit 1), with the autostart state', async () => {
    let h = harness(['tray', 'status'], { files: running, procs: trayProc(), autostart: `"${EXE}"` });
    expect(await h.run()).toBe(0);
    expect(h.out).toEqual(['Tray icon: running (pid 4321, 0.7.0), starts with Windows: yes']);
    h = harness(['tray', 'status'], { files: { [EXE]: 'MZ' }, autostart: '"C:\\Elsewhere\\telinha-tray.exe"' });
    expect(await h.run()).toBe(1);
    expect(h.out).toEqual(['Tray icon: not running, starts with Windows: no']);
    h = harness(['tray', 'status'], { locale: 'pt-BR' });
    expect(await h.run()).toBe(1);
    expect(h.out).toEqual(['Ícone na bandeja: não instalado, inicia com o Windows: não']);
  });

  test('autostart on|off writes the Run value for bin\\telinha-tray.exe', async () => {
    let h = harness(['tray', 'autostart', 'on'], { files: { [EXE]: 'MZ' } });
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual([['reg', 'add', RUN_KEY, '/v', 'Telinha', '/t', 'REG_SZ', '/d', `"${EXE}"`, '/f']]);
    expect(h.out).toEqual(['Starts with Windows: on.']);
    h = harness(['tray', 'autostart', 'off'], { locale: 'pt-BR' });
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual([['reg', 'delete', RUN_KEY, '/v', 'Telinha', '/f']]);
    expect(h.out).toEqual(['Inicia com o Windows: desligado.']);
  });

  test('autostart on without the exe is refused; a reg failure is exit 1 with the reason', async () => {
    let h = harness(['tray', 'autostart', 'on']);
    expect(await h.run()).toBe(1);
    expect(h.calls).toEqual([]);
    h = harness(['tray', 'autostart', 'on'], {
      files: { [EXE]: 'MZ' },
      respond: () => ({ code: 1, stderr: 'ERROR: Access is denied.' }),
    });
    expect(await h.run()).toBe(1);
    expect(h.err).toEqual(['tray autostart failed: reg add exited with code 1: ERROR: Access is denied.']);
  });
});
