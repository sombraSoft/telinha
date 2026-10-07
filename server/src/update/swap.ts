// Putting a downloaded executable in place and taking it out again. The
// running file is renamed, never deleted: Windows allows renaming a running
// exe but not removing it, Linux keeps the inode open either way. Every
// replaced file gets a unique name (telinha.old-<version>, telinha.failed-<tag>)
// so a busy leftover from the last update never blocks the next one; sweeps are
// best effort and the file in use simply survives until the service restarts.
// The Windows tray rides along and never fails an update: it is replaced and
// rolled back best effort. An installed tray is telinha-tray.exe; an opted-out
// one is kept as telinha-tray.dist.exe, so setup can install it again offline.
import { join } from 'node:path';
import type { UpdateFailed, UpdateStaged } from '../cli/control.ts';
import { ASIDE_RE, asideBase, exeName, exeSuffix, newExeName, TRAY_DIST, TRAY_EXE, TRAY_NEW } from '../release.ts';
import { readState, writeState } from './state.ts';
import { errorMessage, type UpdateFs } from './types.ts';

type Log = (...a: unknown[]) => void;
const quiet: Log = () => {};

/** Removes every telinha[-tray].old-* / telinha[-tray].failed-* it can; a busy one (EBUSY/EPERM on Windows) stays. Returns the names removed. */
export async function sweep(fs: UpdateFs, bin: string, log: Log = quiet): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await fs.readdir(bin)) {
    if (!ASIDE_RE.test(name)) continue;
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
  const suffix = exeSuffix(platform);
  const prefix = asideBase('telinha', 'old', '');
  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of await fs.readdir(bin)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix) || (!suffix && name.endsWith('.exe'))) continue;
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
  const fresh = join(o.bin, newExeName(o.platform));
  if (!(await o.fs.stat(fresh))) throw new Error(`nothing to install: ${fresh} is missing`);
  await sweep(o.fs, o.bin, log);
  const oldName = await freeName(o.fs, o.bin, asideBase('telinha', 'old', o.current), exeSuffix(o.platform), o.now());
  const current = join(o.bin, exe);
  const old = join(o.bin, oldName);
  const hadCurrent = !!(await o.fs.stat(current));
  if (hadCurrent) await o.fs.rename(current, old);
  try {
    await o.fs.rename(fresh, current);
  } catch (e) {
    if (hadCurrent)
      await o.fs
        .rename(old, current)
        .catch((undo: unknown) => log(`update: could not restore ${exe}: ${errorMessage(undo)}`));
    throw e;
  }
  log(`update: ${o.tag} installed as ${exe} (previous ${o.current} kept as ${oldName})`);
  const trayPreviousFile = await stageTray(o, log);
  return {
    tag: o.tag,
    previous: o.current,
    previousFile: oldName,
    at: o.now(),
    failedStarts: 0,
    ...(trayPreviousFile ? { trayPreviousFile } : {}),
  };
}

/**
 * telinha-tray.exe -> telinha-tray.old-<current>.exe, telinha-tray.new.exe ->
 * telinha-tray.exe when a tray is installed; otherwise the same into
 * telinha-tray.dist.exe, the copy an opted-out install keeps uninstalled (the
 * opt-out survives updates, and `telinha setup` can still install the tray).
 * A running tray lets the rename through and only refuses deletion, so its
 * .old waits for a later sweep. Never throws: the staged .new is removed
 * whatever happens. Returns the .old name when a file was replaced.
 */
async function stageTray(o: StageOptions, log: Log): Promise<string | undefined> {
  const fresh = join(o.bin, TRAY_NEW);
  const drop = () => o.fs.rm(fresh).catch((e: unknown) => log(`update: ${TRAY_NEW} not removed (${errorMessage(e)})`));
  try {
    if (!(await o.fs.stat(fresh))) return undefined;
    const installed = !!(await o.fs.stat(join(o.bin, TRAY_EXE)));
    const name = installed ? TRAY_EXE : TRAY_DIST;
    const current = join(o.bin, name);
    const what = installed ? `tray installed as ${TRAY_EXE}` : `tray not installed; kept as ${TRAY_DIST}`;
    if (!installed && !(await o.fs.stat(current))) {
      await o.fs.rename(fresh, current);
      log(`update: ${o.tag} ${what}`);
      return undefined;
    }
    const oldName = await freeName(o.fs, o.bin, asideBase('telinha-tray', 'old', o.current), '.exe', o.now());
    const old = join(o.bin, oldName);
    await o.fs.rename(current, old);
    try {
      await o.fs.rename(fresh, current);
    } catch (e) {
      await o.fs
        .rename(old, current)
        .catch((undo: unknown) => log(`update: could not restore ${name}: ${errorMessage(undo)}`));
      throw e;
    }
    log(`update: ${o.tag} ${what} (previous kept as ${oldName})`);
    return oldName;
  } catch (e) {
    log(`update: tray not replaced: ${errorMessage(e)}`);
    await drop();
    return undefined;
  }
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
  const failedName = await freeName(
    o.fs,
    o.bin,
    asideBase('telinha', 'failed', o.staged.tag),
    exeSuffix(o.platform),
    o.now(),
  );
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
  // Only once the executable went back, so the tray matches the version that runs.
  await rollbackTray(o, log);
  return failed;
}

/**
 * The tray file -> telinha-tray.failed-<tag>.exe, the recorded previous tray
 * back. The file is wherever the tray is now: telinha-tray.exe, or
 * telinha-tray.dist.exe when it was opted out (before or after the update).
 * Best effort, never throws.
 */
async function rollbackTray(o: RollbackOptions, log: Log): Promise<void> {
  const previousName = o.staged.trayPreviousFile;
  if (!previousName) return;
  try {
    const previous = join(o.bin, previousName);
    if (!(await o.fs.stat(previous))) {
      log(`update: ${previousName} is gone; tray left as is`);
      return;
    }
    let name = TRAY_EXE;
    if (!(await o.fs.stat(join(o.bin, name)))) name = TRAY_DIST;
    const current = join(o.bin, name);
    if (!(await o.fs.stat(current))) {
      log(`update: no tray file; ${previousName} not restored`);
      return;
    }
    const failedName = await freeName(o.fs, o.bin, asideBase('telinha-tray', 'failed', o.staged.tag), '.exe', o.now());
    const aside = join(o.bin, failedName);
    await o.fs.rename(current, aside);
    try {
      await o.fs.rename(previous, current);
    } catch (e) {
      await o.fs.rename(aside, current).catch(() => {});
      throw e;
    }
    log(`update: tray rolled back (${previousName}); ${o.staged.tag} tray kept as ${failedName}`);
  } catch (e) {
    log(`update: tray not rolled back: ${errorMessage(e)}`);
  }
}

/** A started version proved itself: record it as applied, forget the staged record and sweep the leftovers. */
export async function finish(o: {
  fs: UpdateFs;
  bin: string;
  statePath: string;
  now?: () => number;
  log?: Log;
}): Promise<void> {
  const state = await readState(o.fs, o.statePath);
  const { staged } = state;
  if (staged) {
    (o.log ?? quiet)(`update: ${staged.tag} started fine`);
    // Kept until the next applied update overwrites it, so the tray can announce it once.
    const applied = { tag: staged.tag, previous: staged.previous, at: (o.now ?? Date.now)() };
    await writeState(o.fs, o.statePath, { ...state, staged: undefined, applied });
  }
  await sweep(o.fs, o.bin, o.log);
}
