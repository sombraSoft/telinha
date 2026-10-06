// One `run` per TELINHA_HOME. A second one (a console `telinha run` while the
// service is up, a second double-click, a `docker exec ... run`) would kill the
// first one's children as stale and overwrite its control token. The lock is a
// pidfile created exclusively; a file left by a dead process, or whose pid now
// belongs to another program, is replaced.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { defaultProcessInfo, sameExe as defaultSameExe, type ProcessInfo } from './supervisor.ts';

export class AlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`telinha is already running (pid ${pid})`);
    this.name = 'AlreadyRunningError';
  }
}

export interface Lock {
  /** Deletes the pidfile, only while it still names this process. Sync: also used from process.on('exit'). */
  release(): void;
}

export interface LockOptions {
  pid?: number;
  /** This executable (telinha[.exe], or bun when run from source). */
  exe?: string;
  processInfo?: ProcessInfo;
  sameExe?: (recorded: string, seen: string | null, platform: NodeJS.Platform) => boolean;
  platform?: NodeJS.Platform;
  now?: () => number;
}

interface LockRecord { pid: number; exe: string; startedAt: number }

// A file this young that does not parse yet is a racing start writing it, not litter.
const FRESH_MS = 5000;

function read(path: string): LockRecord | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    return Number.isInteger(r.pid) && (r.pid as number) > 0 && typeof r.exe === 'string' ? (r as LockRecord) : null;
  } catch {
    return null;
  }
}

export function acquireLock(path: string, o: LockOptions = {}): Lock {
  const pid = o.pid ?? process.pid;
  const exe = o.exe ?? basename(process.execPath);
  const platform = o.platform ?? process.platform;
  const processInfo = o.processInfo ?? defaultProcessInfo(platform);
  const sameExe = o.sameExe ?? defaultSameExe;
  const now = o.now ?? Date.now;
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; ; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = read(path);
      // Recreated between our unlink and open: another start won the race.
      if (attempt > 0) throw new AlreadyRunningError(held?.pid ?? 0);
      if (held && held.pid !== pid) {
        const info = processInfo(held.pid);
        if (info.alive && sameExe(held.exe, info.exe, platform)) throw new AlreadyRunningError(held.pid);
      } else if (!held) {
        let age = Infinity;
        try {
          age = now() - statSync(path).mtimeMs;
        } catch {
          // gone meanwhile: just retry
        }
        if (age < FRESH_MS) throw new AlreadyRunningError(0);
      }
      // Stale: a dead pid, a reused one, or our own from before a reboot.
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      continue;
    }
    try {
      writeSync(fd, `${JSON.stringify({ pid, exe, startedAt: now() } satisfies LockRecord)}\n`);
    } finally {
      closeSync(fd);
    }
    break;
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      // Another instance may have replaced a file we lost (e.g. deleted by hand): leave theirs alone.
      if (read(path)?.pid !== pid) return;
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    },
  };
}
