import { describe, expect, test } from 'bun:test';
import type { SpawnFn, SpawnOutcome } from '../src/service/index.ts';
import {
  autostartEnabled, parseRunValue, readTrayState, removeTray, RUN_KEY, setAutostart, stopTray, trayEnv, trayExePath, trayRunning, trayStatePath,
} from '../src/service/tray.ts';

const HOME = 'C:\\Users\\Ana Souza\\AppData\\Local\\Telinha';
const PATHS = { home: HOME, bin: `${HOME}\\bin`, run: `${HOME}\\data\\run` };
const EXE = `${HOME}\\bin\\telinha-tray.exe`;
const STATE = `${HOME}\\data\\run\\tray.json`;
const T0 = 1_700_000_000_000;

function recorder(respond: (cmd: string[]) => Partial<SpawnOutcome> | undefined = () => undefined) {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (cmd) => {
    calls.push(cmd);
    return { code: 0, stdout: '', stderr: '', ...respond(cmd) };
  };
  return { spawn, calls };
}

function memFs(init: Record<string, string> = {}) {
  const files = new Map(Object.entries(init));
  const busy = new Set<string>();
  const fs = {
    readText: async (p: string) => files.get(p) ?? null,
    exists: async (p: string) => files.has(p),
    async rm(p: string) {
      if (busy.has(p)) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${p}'`), { code: 'EPERM' });
      files.delete(p);
    },
    async rename(a: string, b: string) {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
  };
  return { fs, files, busy };
}

const stateJson = (pid: number) => JSON.stringify({ version: '0.7.0-rc.1', pid, startedAt: T0, exe: EXE });

describe('paths and tray.json', () => {
  test('the exe in bin and the state file in data\\run, Windows paths on any host', () => {
    expect(trayExePath(PATHS)).toBe(EXE);
    expect(trayStatePath(PATHS)).toBe(STATE);
  });

  test('reads what the tray writes; missing, corrupt or pid-less is null', async () => {
    expect(await readTrayState(memFs({ [STATE]: stateJson(4321) }).fs, PATHS)).toEqual({ version: '0.7.0-rc.1', pid: 4321, startedAt: T0, exe: EXE });
    expect(await readTrayState(memFs().fs, PATHS)).toBeNull();
    expect(await readTrayState(memFs({ [STATE]: '{"pid":' }).fs, PATHS)).toBeNull();
    expect(await readTrayState(memFs({ [STATE]: '{"version":"0.7.0"}' }).fs, PATHS)).toBeNull();
    expect(await readTrayState(memFs({ [STATE]: '{"pid":-1}' }).fs, PATHS)).toBeNull();
    // New fields are additive; missing optional ones get neutral values.
    expect(await readTrayState(memFs({ [STATE]: '{"pid":9,"extra":true}' }).fs, PATHS)).toEqual({ version: '', pid: 9, startedAt: 0, exe: '' });
  });

  test('running = the pid is alive and is still telinha-tray.exe', () => {
    const state = { version: '0.7.0', pid: 9, startedAt: 0, exe: EXE };
    expect(trayRunning(state, () => ({ alive: true, exe: 'telinha-tray.exe' }))).toBe(true);
    expect(trayRunning(state, () => ({ alive: true, exe: 'TELINHA-TRAY.EXE' }))).toBe(true);
    // A reused pid.
    expect(trayRunning(state, () => ({ alive: true, exe: 'notepad.exe' }))).toBe(false);
    expect(trayRunning(state, () => ({ alive: false, exe: null }))).toBe(false);
    expect(trayRunning(null, () => ({ alive: true, exe: 'telinha-tray.exe' }))).toBe(false);
  });
});

describe('autostart (HKCU Run value)', () => {
  const QUERY = `\r\n${RUN_KEY.replace('HKCU', 'HKEY_CURRENT_USER')}\r\n    Telinha    REG_SZ    "${EXE}"\r\n\r\n`;

  test('on: reg add with the quoted path; off: reg delete', async () => {
    const r = recorder();
    await setAutostart(r.spawn, EXE, true);
    await setAutostart(r.spawn, EXE, false);
    expect(r.calls).toEqual([
      ['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Telinha', '/t', 'REG_SZ', '/d', `"${EXE}"`, '/f'],
      ['reg', 'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Telinha', '/f'],
    ]);
  });

  test('off when the value is already gone is fine; a value that stays is an error', async () => {
    // Both the delete and the follow-up query find nothing (reg's text is localized; only the exit codes count).
    let r = recorder(() => ({ code: 1, stderr: 'ERRO: o sistema não conseguiu localizar a chave ou o valor do Registro especificado.' }));
    await setAutostart(r.spawn, EXE, false);
    expect(r.calls.map((c) => c[1])).toEqual(['delete', 'query']);
    r = recorder((cmd) => (cmd[1] === 'delete' ? { code: 1, stderr: 'ERROR: Access is denied.' } : undefined));
    await expect(setAutostart(r.spawn, EXE, false)).rejects.toThrow('reg delete exited with code 1: ERROR: Access is denied.');
    r = recorder(() => ({ code: 1, stderr: 'ERROR: Access is denied.' }));
    await expect(setAutostart(r.spawn, EXE, true)).rejects.toThrow('reg add exited with code 1: ERROR: Access is denied.');
  });

  test('enabled only when the value starts this exe (case-insensitive)', async () => {
    expect(parseRunValue(QUERY)).toBe(`"${EXE}"`);
    const r = recorder(() => ({ stdout: QUERY }));
    expect(await autostartEnabled(r.spawn, EXE)).toBe(true);
    expect(r.calls).toEqual([['reg', 'query', RUN_KEY, '/v', 'Telinha']]);
    expect(await autostartEnabled(r.spawn, EXE.toUpperCase())).toBe(true);
    expect(await autostartEnabled(r.spawn, 'D:\\Other\\bin\\telinha-tray.exe')).toBe(false);
    expect(await autostartEnabled(recorder(() => ({ code: 1 })).spawn, EXE)).toBe(false);
  });
});

describe('stopTray', () => {
  function setup(o: { state?: string; procs?: Map<number, string>; exitsAfterMs?: number } = {}) {
    const m = memFs(o.state ? { [STATE]: o.state } : {});
    const procs = o.procs ?? new Map<number, string>();
    const clock = { t: T0 };
    const r = recorder();
    const deps = {
      spawn: r.spawn, fs: m.fs, paths: PATHS,
      processInfo: (pid: number) => (procs.has(pid) ? { alive: true, exe: procs.get(pid)! } : { alive: false, exe: null }),
      now: () => clock.t,
      sleep: async (ms: number) => {
        clock.t += ms;
        if (o.exitsAfterMs !== undefined && clock.t - T0 >= o.exitsAfterMs) procs.clear();
      },
    };
    return { deps, calls: r.calls, files: m.files, clock };
  }

  test('a tray that closes on the polite taskkill: no /F', async () => {
    const h = setup({ state: stateJson(4321), procs: new Map([[4321, 'telinha-tray.exe']]), exitsAfterMs: 1000 });
    expect(await stopTray(h.deps)).toBe('stopped');
    expect(h.calls).toEqual([['taskkill', '/PID', '4321']]);
    expect(h.clock.t - T0).toBe(1000);
    expect(h.files.has(STATE)).toBe(false);
  });

  test('a tray still there after 5 s is killed with /F, and its tray.json removed', async () => {
    const h = setup({ state: stateJson(4321), procs: new Map([[4321, 'telinha-tray.exe']]) });
    expect(await stopTray(h.deps)).toBe('stopped');
    expect(h.calls).toEqual([['taskkill', '/PID', '4321'], ['taskkill', '/F', '/PID', '4321']]);
    expect(h.clock.t - T0).toBe(5000);
    expect(h.files.has(STATE)).toBe(false);
  });

  test('a stale tray.json (dead pid, or a reused one) is removed and nothing is killed', async () => {
    for (const procs of [new Map<number, string>(), new Map([[4321, 'chrome.exe']])]) {
      const h = setup({ state: stateJson(4321), procs });
      expect(await stopTray(h.deps)).toBe('not-running');
      expect(h.calls).toEqual([]);
      expect(h.files.has(STATE)).toBe(false);
    }
  });

  test('no tray.json: not running', async () => {
    const h = setup();
    expect(await stopTray(h.deps)).toBe('not-running');
    expect(h.calls).toEqual([]);
  });
});

describe('removeTray', () => {
  const DIST = `${HOME}\\bin\\telinha-tray.dist.exe`;

  test('renames the exe to telinha-tray.dist.exe (over an older copy) and logs it', async () => {
    const m = memFs({ [EXE]: 'tray v0.8.0', [DIST]: 'tray v0.7.0' });
    // A tray still closing keeps its file from deletion, not from a rename.
    m.busy.add(EXE);
    const logs: string[] = [];
    expect(await removeTray({ fs: m.fs, paths: PATHS, log: (l) => logs.push(l) })).toBe('removed');
    expect([...m.files.entries()]).toEqual([[DIST, 'tray v0.8.0']]);
    expect(logs).toEqual([`tray: ${EXE} set aside as ${DIST}`]);
  });

  test('nothing there: absent; a failed rename is thrown', async () => {
    expect(await removeTray({ fs: memFs().fs, paths: PATHS, log: () => {} })).toBe('absent');
    const m = memFs({ [EXE]: 'MZ' });
    m.fs.rename = async () => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    };
    await expect(removeTray({ fs: m.fs, paths: PATHS, log: () => {} })).rejects.toThrow('EIO');
  });
});

describe('trayEnv', () => {
  test('the defined values plus TELINHA_HOME, which always wins', () => {
    expect(trayEnv({ PATH: 'C:\\Windows', LOCALE: 'pt-BR', EMPTY: '', GONE: undefined, TELINHA_HOME: 'D:\\old' }, PATHS)).toEqual({
      PATH: 'C:\\Windows', LOCALE: 'pt-BR', EMPTY: '', TELINHA_HOME: HOME,
    });
  });
});
