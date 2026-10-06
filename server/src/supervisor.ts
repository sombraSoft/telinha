// Generic child-process supervisor: spawns the ChildSpec[] it is given, pipes
// their output to the log as "[name] line", restarts crashes with backoff and
// stops everything on request. It knows nothing about LiveKit or Caddy:
// children.ts builds the specs and run.ts passes the environment children
// start from.
//
// Shutdown facts verified on Bun 1.4.2 (Windows 11, Windows Terminal as the
// console host; WSL for Linux) that run.ts's signal wiring relies on:
// - Closing the console window delivers SIGHUP to every bun process on that
//   console, newest first: a child spawned by telinha got its SIGHUP first and
//   was force-terminated ~5 s later while its handler still ran; only then did
//   telinha's own SIGHUP handler run, and it too had ~5 s (not 10) before the
//   OS ended it. 'exit' does not fire when that deadline hits, and a handler
//   that never calls process.exit is cut off. So when stop() runs from the
//   SIGHUP handler the children are usually gone already (rules 4/5 below skip
//   them) and stop() must finish well inside 5 s: on Windows the kill is
//   taskkill /F, no grace.
// - Ctrl+C (CTRL_C_EVENT) reaches every process on the console at once as
//   SIGINT, children included, with no deadline; a child that exits on it does
//   so before or while telinha's handler runs. Same race, same rules.
// - Linux: `detached: true` puts a child in its own session (own pgid/sid), so
//   a terminal Ctrl+C reaches telinha only, which then SIGTERMs the children.
//   The flip side is that children outlive a SIGKILLed telinha, hence the
//   pidfile cleanup in start() and stopSync() on 'exit'.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export interface ChildSpec {
  name: string;                       // log prefix, restart key: "livekit" | "caddy" | "cloudflared" | "caddy-l4" (TURN over TLS, later)
  cmd: string[];                      // argv; cmd[0] absolute (from findBinary). NEVER a secret (shows in ps/tasklist and logs)
  env?: Record<string, string>;       // merged over deps.baseEnv, not over process.env
  cwd?: string;
  /** Runs before every (re)start: render config files, create dirs. */
  prepare?: () => Promise<void>;
  /** Optional readiness probe; start() resolves once every probe passed (or its timeout threw). */
  ready?: { url: string; timeoutMs: number };
  /** Restart backoff; defaults { minMs: 1000, maxMs: 60_000, resetAfterMs: 60_000 }. */
  restart?: { minMs: number; maxMs: number; resetAfterMs: number };
  /** How long SIGTERM gets before SIGKILL; default 5000. */
  stopGraceMs?: number;
  /** Secret values to blank out in forwarded output (`***`): a child may echo a URL that carries its token in an error. */
  redact?: string[];
}

export type ChildState = 'starting' | 'up' | 'restarting' | 'stopped';

export interface Supervisor {
  start(): Promise<void>;                  // spawns all, waits for ready probes
  restart(name: string): Promise<void>;    // graceful stop + prepare + spawn, no backoff
  stop(): Promise<void>;                   // stops all; idempotent
  /** Last resort for process.on('exit'): kills without waiting (Linux SIGKILL, Windows taskkill), skips reaped children. */
  stopSync(): void;
  status(): { name: string; state: ChildState; pid: number | null; restarts: number; since: number }[];
}

/** Is `pid` alive, and which executable runs there (basename; Linux comm may be cut at 15 chars). */
export type ProcessInfo = (pid: number) => { alive: boolean; exe: string | null };

export interface SupervisorDeps {
  specs: ChildSpec[];
  log: (...a: unknown[]) => void;
  /** Environment every child starts from; spec.env is merged over it. run.ts passes childBaseEnv(process.env). Default: {} — never process.env. */
  baseEnv?: Record<string, string>;
  /** Injected for tests; default Bun.spawn. Receives the final env. */
  spawn?: (spec: ChildSpec, env: Record<string, string>) => ChildHandle;
  now?: () => number;
  /** Must resolve early (and the caller re-check `stopping`) when `signal` aborts; default setTimeout + abort listener. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Pidfile for stale-child cleanup; omit in tests. */
  pidfile?: string;
  /** Default oracle reads /proc or tasklist; tests inject a fake. */
  processInfo?: ProcessInfo;
  platform?: NodeJS.Platform;
}
export interface ChildHandle { pid: number; exited: Promise<number | null>; stdout: ReadableStream<Uint8Array> | null; stderr: ReadableStream<Uint8Array> | null; kill(signal?: NodeJS.Signals): void }

const DEFAULT_RESTART = { minMs: 1000, maxMs: 60_000, resetAfterMs: 60_000 };
const DEFAULT_GRACE_MS = 5000;
const PROBE_EVERY_MS = 250;
/** After killing a stale child: how often and how many times to check it is gone (ports freed) before prepare() probes them. */
const STALE_GONE_EVERY_MS = 50;
const STALE_GONE_CHECKS = 60;

interface Child {
  spec: ChildSpec;
  state: ChildState;
  /** When `state` was last set. */
  since: number;
  handle: ChildHandle | null;
  /** undefined while the current handle runs; set by the exit watcher (never kill a reaped pid). */
  exitCode: number | null | undefined;
  /** When the current handle was spawned (backoff reset). */
  startedAt: number;
  /** Consecutive runs shorter than resetAfterMs: the backoff exponent. */
  shortRuns: number;
  /** Crash respawns so far (restart() does not count). */
  restarts: number;
  /** Bumped by stop() and restart(): a respawn from an older generation never spawns. */
  generation: number;
  /** Backoff sleep of a scheduled crash-restart, aborted by stop()/restart(). */
  pending: AbortController | null;
  /** Per-child op chain: restarts and crash respawns run one at a time. */
  op: Promise<void>;
  /** Inside restart(): exits are expected, never scheduled. */
  restarting: boolean;
}

interface PidEntry { name: string; pid: number; exe: string }

/** Windows has no SIGTERM and proc.kill() ends only the direct process; taskkill /T takes the tree. False when it is missing or found no such pid (exit 128). */
function taskkill(pid: number): boolean {
  try {
    return Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  } catch {
    return false; // no taskkill: the caller ends the direct process instead
  }
}

function bunSpawn(platform: NodeJS.Platform): NonNullable<SupervisorDeps['spawn']> {
  return (spec, env) => {
    const proc = Bun.spawn(spec.cmd, {
      cwd: spec.cwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Own session on Linux: a terminal Ctrl+C (SIGINT to the foreground
      // process group) must reach telinha only, which then SIGTERMs the
      // children in order. On Windows `detached` means a new console instead.
      detached: platform === 'linux',
    });
    return {
      pid: proc.pid,
      exited: proc.exited,
      stdout: proc.stdout,
      stderr: proc.stderr,
      kill(signal) {
        if (platform === 'win32' && taskkill(proc.pid)) return;
        proc.kill(signal);
      },
    };
  };
}

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

/** Is `pid` alive and what runs there: /proc on Linux, tasklist on Windows. */
export function defaultProcessInfo(platform: NodeJS.Platform = process.platform): ProcessInfo {
  const dead = { alive: false, exe: null };
  if (platform === 'win32') {
    return (pid) => {
      try {
        // CSV rows: "livekit-server.exe","1234","Console","1","12,345 K"; a sentence instead when no task matches.
        const out = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString();
        const m = /^"([^"]*)","(\d+)"/m.exec(out);
        return m && Number(m[2]) === pid ? { alive: true, exe: m[1]! } : dead;
      } catch {
        return dead;
      }
    };
  }
  return (pid) => {
    try {
      return { alive: true, exe: readFileSync(`/proc/${pid}/comm`, 'utf8').trim() };
    } catch {
      // comm unreadable (or not Linux): try the argv; no /proc entry means no process.
    }
    try {
      const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? '';
      return { alive: true, exe: argv0 ? basename(argv0) : null };
    } catch {
      return dead;
    }
  };
}

/** Kill a pid we hold no handle for (a stale child from a previous run): no grace, it is an orphan holding our ports. */
function killPid(pid: number, platform: NodeJS.Platform) {
  if (platform === 'win32' && taskkill(pid)) return;
  process.kill(pid, 'SIGKILL');
}

/** Same executable? Case-insensitive on Windows, `.exe` ignored; /proc/<pid>/comm is cut at 15 chars, so a prefix counts. */
export function sameExe(recorded: string, seen: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (!seen) return false;
  const norm = (s: string) => {
    const b = basename(s).replace(/\.exe$/i, '');
    return platform === 'win32' ? b.toLowerCase() : b;
  };
  const a = norm(recorded);
  const b = norm(seen);
  return a === b || (b.length >= 15 && a.startsWith(b));
}

/** Replaces every non-empty secret, raw or URL-encoded, with `***`. */
export function redactLine(line: string, secrets: readonly string[] = []): string {
  let out = line;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('***');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join('***');
  }
  return out;
}

async function pipe(spec: ChildSpec, stream: ReadableStream<Uint8Array> | null, log: SupervisorDeps['log']) {
  if (!stream) return;
  const { name, redact } = spec;
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for await (const chunk of stream) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) log(`[${name}] ${redactLine(line, redact)}`);
    }
  } catch {
    // the pipe breaks when the child is killed: whatever arrived is logged below
  }
  if (rest) log(`[${name}] ${redactLine(rest, redact)}`);
}

const seconds = (ms: number) => `${ms / 1000}s`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const { log, pidfile } = deps;
  const platform = deps.platform ?? process.platform;
  const baseEnv = deps.baseEnv ?? {};
  const spawn = deps.spawn ?? bunSpawn(platform);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const processInfo = deps.processInfo ?? defaultProcessInfo(platform);
  const children: Child[] = deps.specs.map((spec) => ({
    spec, state: 'stopped', since: now(), handle: null, exitCode: undefined, startedAt: 0,
    shortRuns: 0, restarts: 0, generation: 0, pending: null, op: Promise.resolve(), restarting: false,
  }));
  const byName = new Map(children.map((c) => [c.spec.name, c]));
  let started = false;
  let stopping = false;
  let stopped: Promise<void> | null = null;
  /** Aborted by stop(): wakes probe loops and grace waits. */
  const stopCtl = new AbortController();

  function setState(child: Child, state: ChildState) {
    child.state = state;
    child.since = now();
  }

  /** Runs `fn` after the child's previous op; the stored chain never rejects so one failure does not block the next op. */
  function enqueue(child: Child, fn: () => Promise<void>): Promise<void> {
    const run = child.op.then(fn);
    child.op = run.catch(() => {});
    return run;
  }

  function writePidfile() {
    if (!pidfile) return;
    const entries: PidEntry[] = children
      .filter((c) => c.handle && c.exitCode === undefined)
      .map((c) => ({ name: c.spec.name, pid: c.handle!.pid, exe: basename(c.spec.cmd[0] ?? '') }));
    try {
      mkdirSync(dirname(pidfile), { recursive: true });
      writeFileSync(`${pidfile}.tmp`, JSON.stringify(entries));
      renameSync(`${pidfile}.tmp`, pidfile);
    } catch (e) {
      log(`pidfile ${pidfile} not written: ${message(e)}`);
    }
  }

  function removePidfile() {
    if (!pidfile) return;
    try {
      rmSync(pidfile, { force: true });
    } catch {
      // read-only data dir: the next start() rechecks every entry anyway
    }
  }

  // Children of a previous telinha that died hard (bun --watch, SIGKILL) still
  // hold the ports. Kill them only when the pid still runs the same executable:
  // a recycled pid must never hit an unrelated process. Waits (bounded) for the
  // killed ones to be gone: their ports must be free before livekit's prepare()
  // checks them, or it would mistake our own orphan for a foreign LiveKit.
  async function killStale() {
    if (!pidfile) return;
    let entries: PidEntry[];
    try {
      entries = JSON.parse(readFileSync(pidfile, 'utf8')) as PidEntry[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log(`pidfile ${pidfile} unreadable: ${message(e)}`);
      return;
    }
    if (!Array.isArray(entries)) return;
    const killed: number[] = [];
    for (const e of entries) {
      if (typeof e?.pid !== 'number' || e.pid === process.pid || typeof e.exe !== 'string') continue;
      const info = processInfo(e.pid);
      if (!info.alive || !sameExe(e.exe, info.exe, platform)) continue;
      try {
        killPid(e.pid, platform);
        killed.push(e.pid);
        log(`[${e.name}] killed stale pid ${e.pid}`);
      } catch (err) {
        log(`[${e.name}] could not kill stale pid ${e.pid}: ${message(err)}`);
      }
    }
    for (let i = 0; i < STALE_GONE_CHECKS && killed.some((pid) => processInfo(pid).alive); i++) {
      await sleep(STALE_GONE_EVERY_MS, stopCtl.signal);
      if (stopping) return;
    }
  }

  function spawnChild(child: Child) {
    const { spec } = child;
    // argv only: env holds the one secret each child needs.
    log(`spawning ${spec.name}: ${spec.cmd.join(' ')}`);
    const handle = spawn(spec, { ...baseEnv, ...spec.env });
    child.handle = handle;
    child.exitCode = undefined;
    child.startedAt = now();
    setState(child, spec.ready ? 'starting' : 'up');
    void pipe(spec, handle.stdout, log);
    void pipe(spec, handle.stderr, log);
    void handle.exited.then((code) => onExit(child, handle, code));
    writePidfile();
  }

  function onExit(child: Child, handle: ChildHandle, code: number | null) {
    // Rule 5: a late exit of a handle restart() already replaced is not this child's.
    if (child.handle !== handle) return;
    child.exitCode = code;
    const name = child.spec.name;
    // Rule 4: expected while stopping or restarting; never a crash.
    if (stopping || child.restarting) {
      log(`[${name}] exited with code ${code}`);
      if (!child.restarting) setState(child, 'stopped');
      return;
    }
    const restart = child.spec.restart ?? DEFAULT_RESTART;
    if (now() - child.startedAt >= restart.resetAfterMs) child.shortRuns = 0;
    const delay = nextDelay(child);
    log(`[${name}] exited with code ${code}, restarting in ${seconds(delay)}`);
    void restartAfter(child, delay);
  }

  function nextDelay(child: Child): number {
    const { minMs, maxMs } = child.spec.restart ?? DEFAULT_RESTART;
    const delay = Math.min(maxMs, minMs * 2 ** child.shortRuns);
    child.shortRuns++;
    return delay;
  }

  // Rule 1: the backoff sleep is abortable and the respawn re-checks
  // `stopping` and the generation after it; the respawn itself runs on the op
  // chain so it cannot overlap a restart().
  async function restartAfter(child: Child, delay: number) {
    const name = child.spec.name;
    const gen = child.generation;
    const pending = new AbortController();
    child.pending = pending;
    setState(child, 'restarting');
    await sleep(delay, pending.signal);
    if (child.pending === pending) child.pending = null;
    const cancelled = () => stopping || pending.signal.aborted || child.generation !== gen;
    if (cancelled()) return log(`[${name}] restart cancelled`);
    await enqueue(child, async () => {
      if (cancelled()) return log(`[${name}] restart cancelled`);
      try {
        await child.spec.prepare?.();
        // Rule 2: stop()/restart() moved the generation while prepare ran.
        if (cancelled()) return log(`[${name}] restart cancelled`);
        spawnChild(child);
        child.restarts++;
      } catch (e) {
        // Never give up: a dead LiveKit is a dead product.
        const retry = nextDelay(child);
        log(`[${name}] restart failed: ${message(e)}, retrying in ${seconds(retry)}`);
        void restartAfter(child, retry);
        return;
      }
      if (child.spec.ready) void waitReady(child).catch((e: unknown) => log(`[${name}] ${message(e)}`));
    });
  }

  // GET url every 250 ms until 2xx; bail when the child died or stop() ran.
  async function waitReady(child: Child) {
    const { spec } = child;
    if (!spec.ready) return;
    const handle = child.handle;
    const deadline = now() + spec.ready.timeoutMs;
    while (now() < deadline) {
      if (stopping) throw new Error(`${spec.name}: stopped while waiting for it`);
      if (child.handle !== handle) return; // restart() took over; it runs its own probe
      if (child.exitCode !== undefined) throw new Error(`${spec.name} exited with code ${child.exitCode} before it was ready`);
      try {
        const res = await fetch(spec.ready.url, { signal: AbortSignal.timeout(1000) });
        // Our child must still be running: a 2xx from a process that already died
        // came from someone else on the port (prepare() checks, this is the backstop).
        if (res.ok && child.exitCode === undefined) {
          if (child.handle === handle) setState(child, 'up');
          return;
        }
      } catch {
        // not listening yet
      }
      await sleep(PROBE_EVERY_MS, stopCtl.signal);
    }
    throw new Error(`timed out waiting for ${spec.name} (${spec.ready.url})`);
  }

  // Linux: SIGTERM, up to stopGraceMs, then SIGKILL. Windows: the handle's kill
  // is taskkill /F already, the grace wait only covers the exit. Skips a child
  // whose exit was already observed (its pid may be someone else's by now).
  async function stopChild(child: Child) {
    const { spec } = child;
    const handle = child.handle;
    if (!handle || child.exitCode !== undefined) return;
    handle.kill('SIGTERM');
    const graceMs = spec.stopGraceMs ?? DEFAULT_GRACE_MS;
    const timer = new AbortController();
    const exited = await Promise.race([handle.exited.then(() => true), sleep(graceMs, timer.signal).then(() => false)]);
    timer.abort();
    if (exited || child.exitCode !== undefined || platform === 'win32') return;
    log(`[${spec.name}] still running after ${seconds(graceMs)}, killing`);
    handle.kill('SIGKILL');
    // Bounded: a SIGKILLed process that never reaps must not hang the shutdown.
    const bound = new AbortController();
    await Promise.race([handle.exited, sleep(graceMs, bound.signal)]);
    bound.abort();
  }

  return {
    async start() {
      if (started) throw new Error('supervisor already started');
      if (stopping) throw new Error('supervisor stopped during start');
      started = true;
      await killStale();
      if (stopping) throw new Error('supervisor stopped during start');
      for (const child of children) {
        await child.spec.prepare?.();
        if (stopping) throw new Error('supervisor stopped during start');
        spawnChild(child);
      }
      await Promise.all(children.map((child) => waitReady(child)));
    },

    // Rule 3: bump the generation (cancels a pending crash-restart) and run on
    // the op chain so overlapping restarts and crash respawns serialize.
    restart(name) {
      const child = byName.get(name);
      if (!child) return Promise.reject(new Error(`unknown child ${name}`));
      if (stopping) return Promise.resolve();
      child.generation++;
      child.pending?.abort();
      child.pending = null;
      return enqueue(child, async () => {
        if (stopping) return;
        child.restarting = true;
        try {
          setState(child, 'restarting');
          await stopChild(child); // a no-op when the child is already gone
          if (stopping) return;
          try {
            await child.spec.prepare?.();
            if (stopping) return;
            spawnChild(child);
          } catch (e) {
            // The caller hears about it, but the child must not stay down: retry like a crash.
            const retry = nextDelay(child);
            log(`[${name}] restart failed: ${message(e)}, retrying in ${seconds(retry)}`);
            void restartAfter(child, retry);
            throw e;
          }
        } finally {
          child.restarting = false;
        }
        await waitReady(child);
      });
    },

    // Rule 2: mark, cancel every pending backoff and in-flight respawn, then
    // stop the live children in parallel. Repeat calls share the promise.
    stop() {
      if (stopped) return stopped;
      stopping = true;
      stopCtl.abort();
      for (const child of children) {
        child.generation++;
        child.pending?.abort();
        child.pending = null;
      }
      stopped = (async () => {
        await Promise.all(children.map((child) => stopChild(child)));
        for (const child of children) setState(child, 'stopped');
        removePidfile();
      })();
      return stopped;
    },

    stopSync() {
      stopping = true;
      stopCtl.abort();
      for (const child of children) {
        child.generation++;
        child.pending?.abort();
        if (!child.handle || child.exitCode !== undefined) continue;
        try {
          // No time for SIGTERM-then-wait in an exit handler: on Linux go straight to SIGKILL.
          child.handle.kill(platform === 'win32' ? undefined : 'SIGKILL');
        } catch {
          // already gone
        }
      }
      removePidfile();
    },

    status() {
      return children.map((c) => ({
        name: c.spec.name,
        state: c.state,
        pid: c.handle && c.exitCode === undefined ? c.handle.pid : null,
        restarts: c.restarts,
        since: c.since,
      }));
    },
  };
}
