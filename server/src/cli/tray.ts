// `telinha tray start | stop | status | autostart on|off`: the Windows tray
// icon. Never started from an elevated process: every command its menu runs
// would run elevated too (the tray itself refuses to run that way).
import { defaultSpawn, nodeServiceFs, type ServiceFs, type SpawnFn } from '../service/index.ts';
import {
  autostartEnabled, defaultTrayLauncher, readTrayState, setAutostart, stopTray, trayEnv, trayExePath, trayRunning,
  type TrayLauncher,
} from '../service/tray.ts';
import { isSplitElevated } from '../service/windows.ts';
import { defaultProcessInfo, type ProcessInfo } from '../supervisor.ts';
import { GLOBAL_FLAGS, parseArgs, UsageError, type CliContext, type ParsedArgs } from './args.ts';
import { defineStrings, ts } from './strings.ts';

export const TRAY_ACTIONS = ['start', 'stop', 'status', 'autostart'] as const;
export type TrayAction = (typeof TRAY_ACTIONS)[number];

const t = defineStrings({
  notWindows: 'the tray exists on Windows only',
  unknownAction: 'unknown tray action {action}',
  noExe: 'telinha-tray.exe is not in {bin}; run telinha setup again',
  alreadyRunning: 'Tray icon already running.',
  elevated: 'Running as administrator: the tray icon was not started; run telinha tray start from a normal terminal.',
  started: 'Tray icon started.',
  stopped: 'Tray icon stopped.',
  notRunning: 'Tray icon is not running.',
  statusLine: 'Tray icon: {state}, starts with Windows: {autostart}',
  stateRunning: 'running (pid {pid}, {version})',
  stateStopped: 'not running',
  stateMissing: 'not installed',
  yes: 'yes',
  no: 'no',
  autostartLine: 'Starts with Windows: {state}.',
  on: 'on',
  off: 'off',
  failed: 'tray {action} failed: {error}',
}, {
  notWindows: 'o ícone na bandeja só existe no Windows',
  unknownAction: 'ação de tray desconhecida {action}',
  noExe: 'o telinha-tray.exe não está em {bin}; rode telinha setup de novo',
  alreadyRunning: 'O ícone na bandeja já está rodando.',
  elevated: 'Rodando como administrador: o ícone na bandeja não foi iniciado; rode telinha tray start num terminal normal.',
  started: 'Ícone na bandeja iniciado.',
  stopped: 'Ícone na bandeja parado.',
  notRunning: 'O ícone na bandeja não está rodando.',
  statusLine: 'Ícone na bandeja: {state}, inicia com o Windows: {autostart}',
  stateRunning: 'rodando (pid {pid}, {version})',
  stateStopped: 'parado',
  stateMissing: 'não instalado',
  yes: 'sim',
  no: 'não',
  autostartLine: 'Inicia com o Windows: {state}.',
  on: 'ligado',
  off: 'desligado',
  failed: 'tray {action} falhou: {error}',
});

export interface TrayCliDeps {
  spawn?: SpawnFn;
  fs?: Pick<ServiceFs, 'readText' | 'exists' | 'rm'>;
  processInfo?: ProcessInfo;
  launcher?: TrayLauncher;
  platform?: NodeJS.Platform;
  /** The environment the tray starts with; default the context's. */
  env?: Record<string, string | undefined>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function run(_args: ParsedArgs, ctx: CliContext, deps: TrayCliDeps = {}): Promise<number> {
  const usage = () => ctx.stderr(ts(ctx.locale, 'helpTray'));
  let positionals: string[];
  try {
    positionals = parseArgs(ctx.argv, { flags: GLOBAL_FLAGS }, { locale: ctx.locale }).positionals;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.stderr(e.message);
    usage();
    return 2;
  }
  if (positionals[0] === 'tray') positionals = positionals.slice(1);
  const [action, value, ...extra] = positionals;
  if (!action) {
    usage();
    return 2;
  }
  if (!(TRAY_ACTIONS as readonly string[]).includes(action)) {
    ctx.stderr(t(ctx.locale, 'unknownAction', { action }));
    usage();
    return 2;
  }
  if (extra.length || (action === 'autostart' ? value !== 'on' && value !== 'off' : value !== undefined)) {
    usage();
    return 2;
  }
  if ((deps.platform ?? process.platform) !== 'win32') {
    ctx.stderr(t(ctx.locale, 'notWindows'));
    return 1;
  }

  const spawn = deps.spawn ?? defaultSpawn;
  const fs = deps.fs ?? nodeServiceFs();
  const processInfo = deps.processInfo ?? defaultProcessInfo('win32');
  const { paths, locale } = ctx;
  const exe = trayExePath(paths);
  const say = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => ctx.stdout(t(locale, key, params));

  try {
    switch (action as TrayAction) {
      case 'start': {
        if (!(await fs.exists(exe))) {
          ctx.stderr(t(locale, 'noExe', { bin: paths.bin }));
          return 1;
        }
        if (trayRunning(await readTrayState(fs, paths), processInfo)) {
          say('alreadyRunning');
          return 0;
        }
        if (await isSplitElevated(spawn)) {
          ctx.stderr(t(locale, 'elevated'));
          return 1;
        }
        (deps.launcher ?? defaultTrayLauncher).launch(exe, trayEnv(deps.env ?? ctx.env, paths));
        say('started');
        return 0;
      }
      case 'stop': {
        const r = await stopTray({
          spawn, fs, paths, processInfo,
          now: deps.now ?? Date.now,
          sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
        });
        say(r === 'stopped' ? 'stopped' : 'notRunning');
        return 0;
      }
      case 'status': {
        const installed = await fs.exists(exe);
        const state = await readTrayState(fs, paths);
        const running = installed && trayRunning(state, processInfo);
        const autostart = await autostartEnabled(spawn, exe);
        say('statusLine', {
          state: running ? t(locale, 'stateRunning', { pid: state!.pid, version: state!.version || '?' }) : t(locale, installed ? 'stateStopped' : 'stateMissing'),
          autostart: t(locale, autostart ? 'yes' : 'no'),
        });
        return running ? 0 : 1;
      }
      case 'autostart': {
        const on = value === 'on';
        // A Run value pointing at a missing file only fails at every sign-in.
        if (on && !(await fs.exists(exe))) {
          ctx.stderr(t(locale, 'noExe', { bin: paths.bin }));
          return 1;
        }
        await setAutostart(spawn, exe, on);
        say('autostartLine', { state: t(locale, on ? 'on' : 'off') });
        return 0;
      }
    }
  } catch (e) {
    ctx.stderr(t(locale, 'failed', { action, error: message(e) }));
    return 1;
  }
}
