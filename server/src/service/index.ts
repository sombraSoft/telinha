// Service managers: Task Scheduler on Windows, systemd (system or user unit) on
// Linux. Both run `telinha service run`, the loop in runloop.ts, and both talk
// to the host only through an injected spawn so tests assert exact argv.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ControlClient, createControlClient } from '../cli/control.ts';
import type { Locale } from '../cli/strings.ts';
import type { Paths } from '../paths.ts';
import { defaultProcessInfo, type ProcessInfo } from '../supervisor.ts';
import { createSystemd } from './systemd.ts';
import { createWindowsTask } from './windows.ts';

type Env = Record<string, string | undefined>;

export interface SpawnOutcome {
  code: number;
  stdout: string;
  stderr: string;
}
export type SpawnFn = (cmd: string[], o?: { timeoutMs?: number }) => Promise<SpawnOutcome>;

export interface ServiceFs {
  readText(path: string): Promise<string | null>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  rm(path: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

export type StepOutcome = 'ok' | 'skipped' | `failed: ${string}`;

/** What install() did, step by step; also the contents of service/install-result.json. */
export interface InstallResult {
  ok: boolean;
  /** task: the scheduled task or unit; firewall: the inbound rules; start: the first start. */
  steps: { task: StepOutcome; firewall: StepOutcome; start: StepOutcome };
  error?: string;
  /** Commands the user still has to run by hand (e.g. loginctl enable-linger). */
  hints: string[];
}

export interface InstallOptions {
  firewall: boolean;
  /** Absolute path of the executable the service runs. */
  exe: string;
  home: string;
  locale: Locale;
  /** Windows: the account the task runs as (DOMAIN\user) and its SID; default: the current token's user. */
  user?: string;
  sid?: string;
  /** Windows: where to write install-result.json (the elevated child's console closes before anyone reads it). */
  resultFile?: string;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  enabled: boolean;
  detail: string;
}

export interface ServiceManager {
  kind: 'windows-task' | 'systemd-system' | 'systemd-user';
  /** Resolves with the result when every step succeeded; throws ServiceInstallError (carrying the result) otherwise. */
  install(o: InstallOptions): Promise<InstallResult>;
  uninstall(o: { firewall: boolean }): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

export class ServiceInstallError extends Error {
  constructor(readonly result: InstallResult) {
    super(
      result.error ??
        Object.entries(result.steps)
          .filter(([, s]) => s.startsWith('failed'))
          .map(([k, s]) => `${k} ${s}`)
          .join('; '),
    );
    this.name = 'ServiceInstallError';
  }
}

/** Windows: `service install` must run elevated (the task is S4U, the firewall rules are machine-wide). */
export class NotElevatedError extends Error {
  constructor(readonly exe: string) {
    super('service install needs an elevated (administrator) terminal');
    this.name = 'NotElevatedError';
  }
}

/** Everything a manager needs, defaults filled in. */
export interface ServiceDeps {
  platform: NodeJS.Platform;
  isRoot: boolean;
  user: boolean;
  spawn: SpawnFn;
  fs: ServiceFs;
  paths: Paths;
  envFile: string;
  env: Env;
  control: Pick<ControlClient, 'available' | 'shutdown'>;
  /** Is a pid alive and which image runs there (Windows: before killing the pid service.pid names). */
  processInfo: ProcessInfo;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (...a: unknown[]) => void;
}

export interface ServiceManagerOptions {
  platform: NodeJS.Platform;
  isRoot: boolean;
  /** Linux: a user unit even as root. Not root always means a user unit. */
  user?: boolean;
  spawn?: SpawnFn;
  fs?: ServiceFs;
  paths: Paths;
  envFile?: string;
  env?: Env;
  control?: Pick<ControlClient, 'available' | 'shutdown'>;
  processInfo?: ProcessInfo;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (...a: unknown[]) => void;
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs a command to completion with its output captured; a missing program is exit 127, never a throw. */
export const defaultSpawn: SpawnFn = async (cmd, o = {}) => {
  const started = (() => {
    try {
      return { proc: Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true }) };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  })();
  if (!started.proc) return { code: 127, stdout: '', stderr: started.error ?? 'spawn failed' };
  const { proc } = started;
  const timer = o.timeoutMs ? setTimeout(() => proc.kill(), o.timeoutMs) : null;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: code ?? 1, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export function nodeServiceFs(): ServiceFs {
  return {
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    writeFile: (path, data) => writeFile(path, data),
    exists: (path) =>
      stat(path).then(
        () => true,
        () => false,
      ),
    rm: (path) => rm(path, { force: true }),
    mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
  };
}

/** The outcome of one install step: never throws, so every step gets recorded. */
export async function attempt(fn: () => Promise<void>): Promise<StepOutcome> {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return `failed: ${errorMessage(e)}`;
  }
}

/** Throws with the command's stderr (or stdout) when it failed. */
export function must(cmd: string[], r: SpawnOutcome): SpawnOutcome {
  if (r.code !== 0) throw new Error(`${cmd[0]} exited with code ${r.code}: ${(r.stderr || r.stdout).trim()}`.trim());
  return r;
}

export const servicePidFile = (paths: Pick<Paths, 'run'>): string => join(paths.run, 'service.pid');

/** null on a host with no supported service manager (macOS, BSD...). */
export function serviceManager(o: ServiceManagerOptions): ServiceManager | null {
  const env = o.env ?? process.env;
  const envFile = o.envFile ?? env.TELINHA_ENV ?? join(o.paths.config, 'telinha.env');
  const deps: ServiceDeps = {
    platform: o.platform,
    isRoot: o.isRoot,
    user: o.user ?? false,
    spawn: o.spawn ?? defaultSpawn,
    fs: o.fs ?? nodeServiceFs(),
    paths: o.paths,
    envFile,
    env,
    control: o.control ?? createControlClient({ paths: o.paths, envFile, env }),
    processInfo: o.processInfo ?? defaultProcessInfo(o.platform),
    now: o.now ?? Date.now,
    sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    log: o.log ?? (() => {}),
  };
  if (o.platform === 'win32') return createWindowsTask(deps);
  if (o.platform === 'linux') return createSystemd(deps, deps.user || !deps.isRoot);
  return null;
}
