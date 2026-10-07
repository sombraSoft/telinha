// `telinha service run`: the process the service manager starts. It serves
// nothing itself; it spawns `telinha run`, relays its output to the log and
// restarts it: at once when it asks (exit 3: an update was staged, a restart
// was requested), with backoff when it crashes, never when it stopped on
// purpose (exit 0). It also judges a staged update: two failed starts in a row
// roll the executable back. The child holds our stdin pipe and our pid so it
// can notice when this loop is gone.

import type { Paths } from '../paths.ts';
import { readState, statePath, writeState } from '../update/state.ts';
import { rollback } from '../update/swap.ts';
import { errorMessage, nodeFs, type UpdateFs } from '../update/types.ts';
import { servicePidFile } from './index.ts';

export interface RunLoopChild {
  pid: number;
  exited: Promise<number | null>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill(signal?: NodeJS.Signals): void;
}
export type SpawnChild = (cmd: string[], env: Record<string, string | undefined>) => RunLoopChild;

export interface RunLoopOptions {
  /** `<bin>/telinha run ...` (dev: bun + index.ts). */
  cmd: string[];
  env: Record<string, string | undefined>;
  paths: Pick<Paths, 'run' | 'bin'>;
  platform?: NodeJS.Platform;
  /** This loop's pid, written to service.pid and handed to the child. */
  pid?: number;
  /** Every line: the loop's own and the child's (its timestamp stripped, the logger adds one). */
  log: (...a: unknown[]) => void;
  spawn?: SpawnChild;
  fs?: UpdateFs;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Subscribes to SIGTERM/SIGINT/SIGHUP; returns the unsubscribe. */
  onSignal?: (fn: (signal: NodeJS.Signals) => void) => () => void;
  /** Windows: ends a process tree. */
  taskkill?: (pid: number) => Promise<void> | void;
  backoff?: { minMs: number; maxMs: number; resetAfterMs: number };
  /** After a signal, how long the child gets before it is killed hard. */
  graceMs?: number;
}

export const EXIT_RESTART = 3;
const DEFAULT_BACKOFF = { minMs: 1000, maxMs: 60_000, resetAfterMs: 5 * 60_000 };
const DEFAULT_GRACE_MS = 8000;
/** Child lines already carry the server's timestamp; the logger adds its own. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const bunSpawn: SpawnChild = (cmd, env) => {
  // stdin stays a pipe we never write: the child reads EOF on it the moment this process dies.
  const proc = Bun.spawn(cmd, { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  return {
    pid: proc.pid,
    exited: proc.exited,
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill: (signal) => proc.kill(signal),
  };
};

const defaultOnSignal: NonNullable<RunLoopOptions['onSignal']> = (fn) => {
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  const handlers = signals.map((s) => [s, () => fn(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  return () => {
    for (const [s, h] of handlers) process.off(s, h);
  };
};

const defaultTaskkill = (pid: number) => {
  try {
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // no taskkill: nothing more to do
  }
};

async function relay(stream: ReadableStream<Uint8Array> | null, log: RunLoopOptions['log']) {
  if (!stream) return;
  const decoder = new TextDecoder();
  let rest = '';
  const emit = (line: string) => log(line.replace(TIMESTAMP_RE, ''));
  try {
    for await (const chunk of stream) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) emit(line);
    }
  } catch {
    // the pipe breaks when the child is killed: whatever arrived is logged below
  }
  if (rest) emit(rest);
}

/** Runs until the child stops on purpose or a signal arrives; resolves with the exit code to use. */
export async function runLoop(o: RunLoopOptions): Promise<number> {
  const fs = o.fs ?? nodeFs();
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const spawn = o.spawn ?? bunSpawn;
  const platform = o.platform ?? process.platform;
  const pid = o.pid ?? process.pid;
  const backoff = o.backoff ?? DEFAULT_BACKOFF;
  const graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
  const taskkill = o.taskkill ?? defaultTaskkill;
  const { log } = o;
  const pidfile = servicePidFile(o.paths);
  const stateFile = statePath(o.paths);

  let child: RunLoopChild | null = null;
  let exited = false;
  let stopping: NodeJS.Signals | null = null;
  const stopCtl = new AbortController();
  let exponent = 0;

  // Linux: pass the signal on and give the child graceMs. Windows: a console
  // event already reached the child; only a hard end remains for a stuck one.
  function forward(c: RunLoopChild, signal: NodeJS.Signals) {
    if (platform !== 'win32') {
      try {
        c.kill(signal);
      } catch {
        // already gone
      }
    }
    void (async () => {
      const timer = new AbortController();
      const done = await Promise.race([c.exited.then(() => true), sleep(graceMs, timer.signal).then(() => false)]);
      timer.abort();
      if (done || exited) return;
      log(`service: telinha still running ${graceMs / 1000}s after ${signal}, killing it`);
      if (platform === 'win32') await taskkill(c.pid);
      else c.kill('SIGKILL');
    })();
  }

  const unsubscribe = (o.onSignal ?? defaultOnSignal)((signal) => {
    if (stopping) return;
    stopping = signal;
    log(`service: ${signal} received, stopping telinha`);
    stopCtl.abort();
    if (child && !exited) forward(child, signal);
  });

  /** A crash with a staged update counts against it; the second one rolls back. */
  async function judge(code: number) {
    const state = await readState(fs, stateFile);
    const staged = state.staged;
    if (!staged) return;
    staged.failedStarts += 1;
    if (staged.failedStarts < 2) {
      log(`service: ${staged.tag} failed to start (exit ${code}); one more try before rolling back`);
      await writeState(fs, stateFile, state);
      return;
    }
    const failed = await rollback({ fs, bin: o.paths.bin, platform, staged, exitCode: code, now, log });
    await writeState(fs, stateFile, { ...state, staged: undefined, failed });
  }

  await fs.mkdir(o.paths.run);
  await fs.writeText(pidfile, `${pid}\n`);
  let code = 0;
  try {
    for (;;) {
      const startedAt = now();
      exited = false;
      child = spawn(o.cmd, { ...o.env, TELINHA_SUPERVISED: '1', TELINHA_SUPERVISOR_PID: String(pid) });
      log(`service: started telinha (pid ${child.pid})`);
      const relays = Promise.all([relay(child.stdout, log), relay(child.stderr, log)]);
      if (stopping) forward(child, stopping);
      const exit = await child.exited;
      exited = true;
      // Lines still in flight when the process ended; bounded, a broken pipe never hangs the loop.
      await Promise.race([relays, new Promise((r) => setTimeout(r, 2000))]);
      code = exit ?? 1;
      if (stopping) return code;
      if (code === 0) {
        log('service: telinha stopped (exit 0)');
        return 0;
      }
      if (code === EXIT_RESTART) {
        log('service: telinha asked for a restart');
        continue;
      }
      try {
        await judge(code);
      } catch (e) {
        log(`service: update state not updated: ${errorMessage(e)}`);
      }
      if (now() - startedAt >= backoff.resetAfterMs) exponent = 0;
      const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** exponent);
      exponent++;
      log(`service: telinha exited with code ${code}, restarting in ${delay / 1000}s`);
      await sleep(delay, stopCtl.signal);
      if (stopping) return code;
    }
  } finally {
    unsubscribe();
    await fs.rm(pidfile).catch(() => {});
  }
}
