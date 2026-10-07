// The Windows tray icon as the CLI sees it: bin\telinha-tray.exe (its presence
// is the "installed" state; an opted-out install keeps the release's copy as
// bin\telinha-tray.dist.exe, so setup can install it again), data\run\tray.json
// (written by the running tray), the HKCU Run value that starts it at sign-in,
// and launching or stopping it.
// Every host call goes through an injected spawn so tests assert exact argv.
import { win32 } from 'node:path';
import type { Paths } from '../paths.ts';
import { TRAY_DIST, TRAY_EXE } from '../release.ts';
import { type ProcessInfo, sameExe } from '../supervisor.ts';
import type { ServiceFs, SpawnFn } from './index.ts';

// Windows paths whatever the host (tests run on Linux too).
const { join } = win32;

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE = 'Telinha';
/** How long the tray gets to close on its own before it is killed. */
export const TRAY_STOP_WAIT_MS = 5000;
const STOP_POLL_MS = 250;

export const trayExePath = (paths: Pick<Paths, 'bin'>): string => join(paths.bin, TRAY_EXE);
export const trayStatePath = (paths: Pick<Paths, 'run'>): string => join(paths.run, 'tray.json');
export const trayDistPath = (paths: Pick<Paths, 'bin'>): string => join(paths.bin, TRAY_DIST);

export interface TrayState {
  version: string;
  pid: number;
  startedAt: number;
  exe: string;
}

export interface TrayLauncher {
  launch(exe: string, env: Record<string, string>): void;
}

/** null when the file is missing or is not what the tray writes. */
export async function readTrayState(
  fs: Pick<ServiceFs, 'readText'>,
  paths: Pick<Paths, 'run'>,
): Promise<TrayState | null> {
  const text = await fs.readText(trayStatePath(paths)).catch(() => null);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<TrayState>;
    if (!Number.isInteger(v.pid) || v.pid! <= 0) return null;
    return {
      pid: v.pid!,
      version: typeof v.version === 'string' ? v.version : '',
      startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
      exe: typeof v.exe === 'string' ? v.exe : '',
    };
  } catch {
    return null;
  }
}

/** The pid tray.json names is alive and still the tray (pids get reused after a crash left the file behind). */
export function trayRunning(state: TrayState | null, processInfo: ProcessInfo): boolean {
  if (!state) return false;
  const info = processInfo(state.pid);
  return info.alive && sameExe(TRAY_EXE, info.exe, 'win32');
}

/** `reg query` prints `    Telinha    REG_SZ    "C:\...\telinha-tray.exe"`. */
export function parseRunValue(stdout: string): string | null {
  const m = new RegExp(`^\\s*${RUN_VALUE}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mi').exec(stdout);
  return m ? m[1]! : null;
}

/** The Run value exists and starts this exe (another path is someone else's install). */
export async function autostartEnabled(spawn: SpawnFn, exe: string): Promise<boolean> {
  const r = await spawn(['reg', 'query', RUN_KEY, '/v', RUN_VALUE]);
  if (r.code !== 0) return false;
  return parseRunValue(r.stdout)?.toLowerCase() === `"${exe}"`.toLowerCase();
}

/** The value holds the quoted path, so a home with spaces starts right. Removing an absent value is fine. */
export async function setAutostart(spawn: SpawnFn, exe: string, on: boolean): Promise<void> {
  if (on) {
    const cmd = ['reg', 'add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exe}"`, '/f'];
    const r = await spawn(cmd);
    if (r.code !== 0) throw new Error(`reg add exited with code ${r.code}: ${(r.stderr || r.stdout).trim()}`);
    return;
  }
  const cmd = ['reg', 'delete', RUN_KEY, '/v', RUN_VALUE, '/f'];
  const r = await spawn(cmd);
  if (r.code === 0) return;
  // reg's "not found" text is localized: ask again instead of reading it.
  if ((await spawn(['reg', 'query', RUN_KEY, '/v', RUN_VALUE])).code !== 0) return;
  throw new Error(`reg delete exited with code ${r.code}: ${(r.stderr || r.stdout).trim()}`);
}

export interface StopTrayDeps {
  spawn: SpawnFn;
  fs: Pick<ServiceFs, 'readText' | 'rm'>;
  paths: Pick<Paths, 'run'>;
  processInfo: ProcessInfo;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * Plain `taskkill /PID` first: a window message the tray answers by closing
 * cleanly (icon gone from the notification area, tray.json removed). Only a
 * tray still there after TRAY_STOP_WAIT_MS is killed outright.
 */
export async function stopTray(d: StopTrayDeps): Promise<'stopped' | 'not-running'> {
  const state = await readTrayState(d.fs, d.paths);
  if (!state) return 'not-running';
  if (!trayRunning(state, d.processInfo)) {
    await d.fs.rm(trayStatePath(d.paths));
    return 'not-running';
  }
  const pid = String(state.pid);
  await d.spawn(['taskkill', '/PID', pid]);
  const deadline = d.now() + TRAY_STOP_WAIT_MS;
  while (trayRunning(state, d.processInfo) && d.now() < deadline) await d.sleep(STOP_POLL_MS);
  if (trayRunning(state, d.processInfo)) await d.spawn(['taskkill', '/F', '/PID', pid]);
  // A killed tray leaves its file behind.
  await d.fs.rm(trayStatePath(d.paths));
  return 'stopped';
}

export interface RemoveTrayDeps {
  fs: Pick<ServiceFs, 'exists'> & { rename(from: string, to: string): Promise<void> };
  paths: Pick<Paths, 'bin'>;
  log: (msg: string) => void;
}

/**
 * Uninstalls bin\telinha-tray.exe by renaming it to telinha-tray.dist.exe
 * (over an older one): a later setup installs it again from there, with no
 * download. Windows lets a running exe be renamed, so a tray still closing
 * does not block it.
 */
export async function removeTray(d: RemoveTrayDeps): Promise<'removed' | 'absent'> {
  const exe = trayExePath(d.paths);
  if (!(await d.fs.exists(exe))) return 'absent';
  const dist = trayDistPath(d.paths);
  await d.fs.rename(exe, dist);
  d.log(`tray: ${exe} set aside as ${dist}`);
  return 'removed';
}

/** The caller's environment plus the home: a custom --home reaches the tray even where its exe-relative guess would miss. */
export function trayEnv(env: Record<string, string | undefined>, paths: Pick<Paths, 'home'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  out.TELINHA_HOME = paths.home;
  return out;
}

/**
 * Detached and unreferenced: the tray outlives the command that started it.
 * It runs in bin\, not the caller's folder: Windows keeps a process's current
 * directory from being deleted (often the unzipped download setup ran from).
 */
export function launchTray(exe: string, env: Record<string, string>): void {
  Bun.spawn([exe], {
    cwd: win32.dirname(exe),
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: false,
  }).unref();
}

export const defaultTrayLauncher: TrayLauncher = { launch: launchTray };
