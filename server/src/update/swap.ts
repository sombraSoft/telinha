// Putting a downloaded executable in place and taking it out again. The
// running file is renamed, never deleted: Windows allows renaming a running
// exe but not removing it, Linux keeps the inode open either way. Every
// replaced file gets a unique name (telinha.old-<version>, telinha.failed-<tag>)
// so a busy leftover from the last update never blocks the next one; sweeps are
// best effort and the file in use simply survives until the service restarts.
import { join } from 'node:path';
import type { UpdateFailed, UpdateStaged } from '../cli/control.ts';
import { readState, writeState } from './state.ts';
import { errorMessage, type UpdateFs } from './types.ts';

export const exeName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'telinha.exe' : 'telinha');
const ext = (platform: NodeJS.Platform) => (platform === 'win32' ? '.exe' : '');
const LEFTOVER_RE = /^telinha\.(old|failed)-/;

type Log = (...a: unknown[]) => void;
const quiet: Log = () => {};

/** Removes every telinha.old-* / telinha.failed-* it can; a busy one (EBUSY/EPERM on Windows) stays. Returns the names removed. */
export async function sweep(fs: UpdateFs, bin: string, log: Log = quiet): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(bin)) {
    if (!LEFTOVER_RE.test(name)) continue;
    try {
      await fs.rm(join(bin, name));
      removed.push(name);
    } catch (e) {
      log(`update: ${name} not removed yet (${errorMessage(e)})`);
    }
  }
  return removed;
}

/** The newest telinha.old-* for this platform by mtime, or null. */
export async function newestOld(fs: UpdateFs, bin: string, platform: NodeJS.Platform): Promise<string | null> {
  const suffix = ext(platform);
  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of await fs.readdir(bin)) {
    if (!name.startsWith('telinha.old-') || !name.endsWith(suffix) || (!suffix && name.endsWith('.exe'))) continue;
    const s = await fs.stat(join(bin, name));
    if (s && (!best || s.mtimeMs > best.mtimeMs)) best = { name, mtimeMs: s.mtimeMs };
  }
  return best?.name ?? null;
}

/** A name nothing in `bin` uses yet: `<base><suffix>`, else `<base>-<unix seconds><suffix>`. */
async function freeName(fs: UpdateFs, bin: string, base: string, suffix: string, now: number): Promise<string> {
  const plain = `${base}${suffix}`;
  if (!(await fs.stat(join(bin, plain)))) return plain;
  return `${base}-${Math.floor(now / 1000)}${suffix}`;
}

export interface StageOptions {
  fs: UpdateFs;
  bin: string;
  platform: NodeJS.Platform;
  tag: string;
  /** The version being replaced (names the .old file). */
  current: string;
  now: () => number;
  log?: Log;
}

/**
 * telinha -> telinha.old-<current>, telinha.new -> telinha. When the second
 * rename fails the first is undone, so the service can always be restarted.
 */
export async function stage(o: StageOptions): Promise<UpdateStaged> {
  const log = o.log ?? quiet;
  const exe = exeName(o.platform);
  const fresh = join(o.bin, `telinha.new${ext(o.platform)}`);
  if (!(await o.fs.stat(fresh))) throw new Error(`nothing to install: ${fresh} is missing`);
  await sweep(o.fs, o.bin, log);
  const oldName = await freeName(o.fs, o.bin, `telinha.old-${o.current}`, ext(o.platform), o.now());
  const current = join(o.bin, exe);
  const old = join(o.bin, oldName);
  const hadCurrent = !!(await o.fs.stat(current));
  if (hadCurrent) await o.fs.rename(current, old);
  try {
    await o.fs.rename(fresh, current);
  } catch (e) {
    if (hadCurrent) await o.fs.rename(old, current).catch((undo: unknown) => log(`update: could not restore ${exe}: ${errorMessage(undo)}`));
    throw e;
  }
  log(`update: ${o.tag} installed as ${exe} (previous ${o.current} kept as ${oldName})`);
  return { tag: o.tag, previous: o.current, previousFile: oldName, at: o.now(), failedStarts: 0 };
}

export interface RollbackOptions {
  fs: UpdateFs;
  bin: string;
  platform: NodeJS.Platform;
  staged: UpdateStaged;
  exitCode: number;
  now: () => number;
  log?: Log;
}

/**
 * telinha -> telinha.failed-<tag>, the recorded previous file (else the newest
 * telinha.old-*) -> telinha. Returns the `failed` record; with no previous file
 * only the record is produced and the current executable stays.
 */
export async function rollback(o: RollbackOptions): Promise<UpdateFailed> {
  const log = o.log ?? quiet;
  const failed: UpdateFailed = { tag: o.staged.tag, at: o.now(), reason: `start failed twice (exit ${o.exitCode})` };
  const exe = exeName(o.platform);
  const current = join(o.bin, exe);
  let previous: string | null = (await o.fs.stat(join(o.bin, o.staged.previousFile))) ? o.staged.previousFile : null;
  if (!previous) previous = await newestOld(o.fs, o.bin, o.platform);
  if (!previous) {
    log(`update: ${o.staged.tag} failed to start twice and no previous executable exists; keeping it`);
    return failed;
  }
  const failedName = await freeName(o.fs, o.bin, `telinha.failed-${o.staged.tag}`, ext(o.platform), o.now());
  const aside = join(o.bin, failedName);
  try {
    await o.fs.rename(current, aside);
  } catch (e) {
    log(`update: cannot move ${exe} aside (${errorMessage(e)}); rollback skipped`);
    return failed;
  }
  try {
    await o.fs.rename(join(o.bin, previous), current);
  } catch (e) {
    await o.fs.rename(aside, current).catch(() => {});
    log(`update: cannot restore ${previous} (${errorMessage(e)}); rollback skipped`);
    return failed;
  }
  log(`update: rolled back to ${o.staged.previous} (${previous}); ${o.staged.tag} kept as ${failedName}`);
  return failed;
}

/** A started version proved itself: forget the staged record and sweep the leftovers. */
export async function finish(o: { fs: UpdateFs; bin: string; statePath: string; log?: Log }): Promise<void> {
  const state = await readState(o.fs, o.statePath);
  if (state.staged) {
    (o.log ?? quiet)(`update: ${state.staged.tag} started fine`);
    await writeState(o.fs, o.statePath, { ...state, staged: undefined });
  }
  await sweep(o.fs, o.bin, o.log);
}
