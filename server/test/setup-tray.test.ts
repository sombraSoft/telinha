import { describe, expect, test } from 'bun:test';
import type { CliContext } from '../src/cli/args.ts';
import type { SetupDeps, Wizard } from '../src/cli/setup/steps.ts';
import { trayStep, trayStrings } from '../src/cli/setup/tray.ts';
import type { Term } from '../src/cli/term.ts';
import { resolvePaths } from '../src/paths.ts';
import { elevationTypeCommand } from '../src/service/windows.ts';

const ELEVATION_TYPE = elevationTypeCommand()[4];

const HOME = 'C:\\Users\\Ana Souza\\AppData\\Local\\Telinha';
const BIN = `${HOME}\\bin`;
const EXE = `${BIN}\\telinha-tray.exe`;
const STATE = `${HOME}\\data\\run\\tray.json`;
const DOWNLOAD = 'C:\\Users\\Ana Souza\\Downloads\\telinha-windows-x64';
const BESIDE = `${DOWNLOAD}\\telinha-tray.exe`;
const DIST = `${BIN}\\telinha-tray.dist.exe`;
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const T0 = 1_700_000_000_000;

function harness(o: {
  files?: Record<string, string>; procs?: Map<number, string>; elevated?: boolean | 'no-uac';
  platform?: NodeJS.Platform; compiled?: boolean; docker?: boolean; locale?: 'en' | 'pt-BR'; execPath?: string;
  spawnFails?: boolean;
} = {}) {
  const files = new Map(Object.entries(o.files ?? {}));
  const procs = o.procs ?? new Map<number, string>();
  const out: string[] = [];
  const fsCalls: string[] = [];
  const calls: string[][] = [];
  const launches: { exe: string; env: Record<string, string> }[] = [];
  const clock = { t: T0 };
  const term = {
    info: (m: string) => void out.push(m),
    ok: (m: string) => void out.push(`ok ${m}`),
    warn: (m: string) => void out.push(`warn ${m}`),
  } as unknown as Term;
  const deps = {
    platform: o.platform ?? 'win32',
    execPath: o.execPath ?? `${DOWNLOAD}\\telinha.exe`,
    spawn: async (cmd: string[]) => {
      calls.push(cmd);
      // 2: elevated through UAC; 1: an administrator with UAC off; 3: a normal UAC session.
      if (cmd[4] === ELEVATION_TYPE) return { code: 0, stdout: o.elevated === 'no-uac' ? '1\r\n' : o.elevated ? '2\r\n' : '3\r\n', stderr: '' };
      return o.spawnFails ? { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' } : { code: 0, stdout: '', stderr: '' };
    },
    fs: {
      readText: async (p: string) => files.get(p) ?? null,
      exists: async (p: string) => files.has(p),
      mkdir: async (d: string) => void fsCalls.push(`mkdir ${d}`),
      copyFile: async (a: string, b: string) => {
        fsCalls.push(`copy ${a} ${b}`);
        files.set(b, files.get(a)!);
      },
      rename: async (a: string, b: string) => {
        fsCalls.push(`rename ${a} ${b}`);
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      rm: async (p: string) => {
        fsCalls.push(`rm ${p}`);
        files.delete(p);
      },
    },
    processInfo: (pid: number) => (procs.has(pid) ? { alive: true, exe: procs.get(pid)! } : { alive: false, exe: null }),
    tray: { launch: (exe: string, env: Record<string, string>) => void launches.push({ exe, env }) },
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
      // The tray answers the polite taskkill within a second.
      if (clock.t - T0 >= 1000) procs.clear();
    },
  } as unknown as SetupDeps;
  const env = { TELINHA_HOME: HOME, LOCALE: 'pt-BR', USERPROFILE: 'C:\\Users\\Ana Souza', NOT_SET: undefined };
  const ctx = {
    argv: ['setup'], env, paths: resolvePaths(env, 'win32'), compiled: o.compiled ?? true, locale: o.locale ?? 'en',
  } as unknown as CliContext;
  const w = { ctx, deps, out: term, locale: o.locale ?? 'en', docker: o.docker ?? false } as unknown as Wizard;
  return { w, out, fsCalls, calls, launches, files, clock };
}

const running = { [EXE]: 'MZ', [STATE]: JSON.stringify({ version: '0.7.0', pid: 4321, startedAt: T0, exe: EXE }) };

describe('setup tray step', () => {
  test('only for the native binary on Windows, never in Docker', async () => {
    for (const o of [{ platform: 'linux' as const }, { compiled: false }, { docker: true }]) {
      const h = harness({ ...o, files: { [BESIDE]: 'MZ' } });
      await trayStep(h.w, { install: true, autostart: true });
      expect(h.out).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.fsCalls).toEqual([]);
    }
  });

  test('fresh: copies the tray from next to the downloaded exe and starts it with TELINHA_HOME', async () => {
    const h = harness({ files: { [BESIDE]: 'MZ' } });
    await trayStep(h.w, { install: true, autostart: null });
    expect(h.fsCalls).toEqual([`mkdir ${BIN}`, `copy ${BESIDE} ${EXE}`]);
    // No --tray-autostart: the Run value is not touched.
    expect(h.calls.some((c) => c[0] === 'reg')).toBe(false);
    expect(h.launches).toEqual([{ exe: EXE, env: { TELINHA_HOME: HOME, LOCALE: 'pt-BR', USERPROFILE: 'C:\\Users\\Ana Souza' } }]);
    expect(h.out).toEqual(['ok Tray icon started (next to the clock).']);
  });

  test('an installed tray is used as it is; --tray-autostart writes the Run value', async () => {
    const h = harness({ files: { [EXE]: 'MZ', [BESIDE]: 'newer' } });
    await trayStep(h.w, { install: true, autostart: true });
    expect(h.fsCalls).toEqual([]);
    expect(h.files.get(EXE)).toBe('MZ');
    expect(h.calls.filter((c) => c[0] === 'reg')).toEqual([['reg', 'add', RUN_KEY, '/v', 'Telinha', '/t', 'REG_SZ', '/d', `"${EXE}"`, '/f']]);
    expect(h.launches.length).toBe(1);
  });

  test('already running: nothing launched, no elevation check', async () => {
    const h = harness({ files: running, procs: new Map([[4321, 'telinha-tray.exe']]), locale: 'pt-BR' });
    await trayStep(h.w, { install: true, autostart: null });
    expect(h.launches).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.out).toEqual(['ok Ícone na bandeja rodando.']);
  });

  test('elevated terminal: the file and the Run value are in place, the icon is not started', async () => {
    const h = harness({ files: { [BESIDE]: 'MZ' }, elevated: true });
    await trayStep(h.w, { install: true, autostart: true });
    expect(h.files.has(EXE)).toBe(true);
    expect(h.calls.some((c) => c[1] === 'add')).toBe(true);
    expect(h.launches).toEqual([]);
    expect(h.out).toEqual(['Running as administrator: the tray icon was not started; run telinha tray start from a normal terminal.']);
    const pt = harness({ files: { [BESIDE]: 'MZ' }, elevated: true, locale: 'pt-BR' });
    await trayStep(pt.w, { install: true, autostart: null });
    expect(pt.out).toEqual(['Rodando como administrador: o ícone na bandeja não foi iniciado; rode telinha tray start num terminal normal.']);
  });

  test('no tray anywhere (a dev or hand-built binary): one info line, nothing else', async () => {
    for (const execPath of [`${DOWNLOAD}\\telinha.exe`, `${BIN}\\telinha.exe`]) {
      const h = harness({ execPath });
      await trayStep(h.w, { install: true, autostart: true });
      expect(h.out).toEqual([
        `telinha-tray.exe is neither in ${BIN} nor next to this telinha.exe; the tray is not installed. Run telinha.exe setup from the unpacked release zip to install it.`,
      ]);
      expect(h.calls).toEqual([]);
      expect(h.launches).toEqual([]);
    }
  });

  test('--no-tray: Run value removed, the running tray stopped, the file kept uninstalled as telinha-tray.dist.exe', async () => {
    const h = harness({ files: { ...running, [BESIDE]: 'MZ' }, procs: new Map([[4321, 'telinha-tray.exe']]) });
    await trayStep(h.w, { install: false, autostart: false });
    expect(h.calls).toEqual([['reg', 'delete', RUN_KEY, '/v', 'Telinha', '/f'], ['taskkill', '/PID', '4321']]);
    expect(h.files.has(EXE)).toBe(false);
    expect(h.files.get(DIST)).toBe('MZ');
    expect(h.files.has(STATE)).toBe(false);
    // The download next to telinha.exe is not the install.
    expect(h.files.has(BESIDE)).toBe(true);
    expect(h.launches).toEqual([]);
    expect(h.out).toEqual(['Tray icon not installed.']);
  });

  test('--no-tray replaces an older kept copy; without a tray it changes nothing', async () => {
    const h = harness({ files: { [EXE]: 'tray v0.8.0', [DIST]: 'tray v0.7.0' }, locale: 'pt-BR' });
    await trayStep(h.w, { install: false, autostart: true });
    expect(h.fsCalls).toEqual([`rename ${EXE} ${DIST}`]);
    expect(h.files.get(DIST)).toBe('tray v0.8.0');
    // --tray-autostart means nothing without the tray.
    expect(h.calls.some((c) => c[1] === 'add')).toBe(false);
    expect(h.out).toEqual(['Ícone na bandeja não instalado.']);
    await trayStep(h.w, { install: false, autostart: false });
    expect(h.fsCalls).toEqual([`rename ${EXE} ${DIST}`]);
  });

  test('a later run without --no-tray installs it again from bin\\ (setup run from the installed telinha.exe)', async () => {
    const h = harness({ files: { [EXE]: 'MZ' }, execPath: `${BIN}\\telinha.exe` });
    await trayStep(h.w, { install: false, autostart: false });
    expect(h.files.has(EXE)).toBe(false);
    await trayStep(h.w, { install: true, autostart: null });
    expect(h.fsCalls.at(-1)).toBe(`rename ${DIST} ${EXE}`);
    expect(h.files.get(EXE)).toBe('MZ');
    expect(h.files.has(DIST)).toBe(false);
    expect(h.launches).toEqual([{ exe: EXE, env: expect.any(Object) }]);
    expect(h.out.at(-1)).toBe('ok Tray icon started (next to the clock).');
  });

  test('a downloaded tray next to this exe wins over the kept copy, which goes', async () => {
    const h = harness({ files: { [BESIDE]: 'tray v0.9.0', [DIST]: 'tray v0.8.0' } });
    await trayStep(h.w, { install: true, autostart: null });
    expect(h.fsCalls).toEqual([`mkdir ${BIN}`, `copy ${BESIDE} ${EXE}`, `rm ${DIST}`]);
    expect(h.files.get(EXE)).toBe('tray v0.9.0');
    expect(h.files.has(DIST)).toBe(false);
  });

  test('an administrator with UAC off still gets the icon started', async () => {
    const h = harness({ files: { [EXE]: 'MZ' }, elevated: 'no-uac' });
    await trayStep(h.w, { install: true, autostart: null });
    expect(h.launches.length).toBe(1);
    expect(h.out).toEqual(['ok Tray icon started (next to the clock).']);
  });

  test('a failure is a warning, never fatal', async () => {
    const h = harness({ files: { [EXE]: 'MZ' }, spawnFails: true });
    await trayStep(h.w, { install: true, autostart: true });
    expect(h.out).toEqual(['warn Tray icon: reg add exited with code 1: ERROR: Access is denied.']);
  });

  test('pt-BR keeps every key and placeholder', () => {
    expect(Object.keys(trayStrings.ptBR).sort()).toEqual(Object.keys(trayStrings.en).sort());
    for (const [k, v] of Object.entries(trayStrings.en)) {
      const want = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect([...trayStrings.ptBR[k as keyof typeof trayStrings.en].matchAll(/\{(\w+)\}/g)].map((m) => m[1])).toEqual(want);
    }
  });
});
