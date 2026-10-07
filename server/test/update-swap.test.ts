import { describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import { readState } from '../src/update/state.ts';
import { finish, newestOld, rollback, stage, sweep } from '../src/update/swap.ts';
import type { UpdateFs } from '../src/update/types.ts';

const T0 = 1_700_000_000_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * In-memory UpdateFs: paths normalized to /, busy paths refuse rm/rename;
 * running paths (a running exe on Windows) allow the rename, refuse rm, and the
 * lock follows the file to its new name.
 */
function memFs() {
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  const busy = new Set<string>();
  const running = new Set<string>();
  const ops: string[] = [];
  let clock = 1;
  const n = (p: string) => p.replace(/\\/g, '/');
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const fs: UpdateFs = {
    async readdir(dir) {
      const d = `${n(dir).replace(/\/$/, '')}/`;
      return [...files.keys()].filter((k) => k.startsWith(d) && !k.slice(d.length).includes('/')).map((k) => k.slice(d.length));
    },
    async rename(from, to) {
      const f = n(from);
      const t = n(to);
      if (busy.has(f)) throw err('EBUSY', f);
      const e = files.get(f);
      if (!e) throw err('ENOENT', f);
      files.delete(f);
      files.set(t, e);
      if (running.delete(f)) running.add(t);
      ops.push(`rename ${basename(f)} -> ${basename(t)}`);
    },
    async rm(p) {
      if (busy.has(n(p)) || running.has(n(p))) throw err('EBUSY', p);
      if (files.delete(n(p))) ops.push(`rm ${basename(p)}`);
    },
    async stat(p) {
      const e = files.get(n(p));
      return e ? { size: e.data.length, mtimeMs: e.mtimeMs } : null;
    },
    async readText(p) {
      const e = files.get(n(p));
      return e ? dec.decode(e.data) : null;
    },
    async writeText(p, text) {
      files.set(n(p), { data: enc.encode(text), mtimeMs: ++clock });
    },
    async readBytes(p) {
      const e = files.get(n(p));
      if (!e) throw err('ENOENT', p);
      return e.data;
    },
    async writeBytes(p, data) {
      files.set(n(p), { data, mtimeMs: ++clock });
      ops.push(`write ${basename(p)}`);
    },
    async mkdir() {},
    async openWrite(p) {
      const chunks: Uint8Array[] = [];
      return {
        write: async (c) => void chunks.push(c),
        close: async () => void files.set(n(p), { data: Buffer.concat(chunks), mtimeMs: ++clock }),
      };
    },
  };
  const put = (p: string, text: string, mtimeMs = ++clock) => files.set(n(p), { data: enc.encode(text), mtimeMs });
  const text = (p: string) => {
    const e = files.get(n(p));
    return e ? dec.decode(e.data) : null;
  };
  const names = () => [...files.keys()].map((k) => basename(k)).sort();
  return { fs, files, busy, running, ops, put, text, names };
}

const BIN = '/t/bin';
const now = () => T0;

describe('stage', () => {
  test('renames in order with a unique .old-<version> name and records what it did', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha`, 'v0.7.0 binary');
    m.put(`${BIN}/telinha.new`, 'v0.8.0 binary');
    m.put(`${BIN}/telinha.old-0.6.0`, 'leftover');
    m.put(`${BIN}/telinha.failed-v0.6.5`, 'leftover');
    const logs: string[] = [];
    const staged = await stage({ fs: m.fs, bin: BIN, platform: 'linux', tag: 'v0.8.0', current: '0.7.0', now, log: (...a) => logs.push(a.join(' ')) });
    expect(m.ops).toEqual(['rm telinha.old-0.6.0', 'rm telinha.failed-v0.6.5', 'rename telinha -> telinha.old-0.7.0', 'rename telinha.new -> telinha']);
    expect(m.text(`${BIN}/telinha`)).toBe('v0.8.0 binary');
    expect(m.text(`${BIN}/telinha.old-0.7.0`)).toBe('v0.7.0 binary');
    expect(staged).toEqual({ tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: T0, failedStarts: 0 });
    expect(logs.join('\n')).toContain('v0.8.0 installed as telinha (previous 0.7.0 kept as telinha.old-0.7.0)');
  });

  test('Windows names carry .exe', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha.exe`, 'old');
    m.put(`${BIN}/telinha.new.exe`, 'new');
    const staged = await stage({ fs: m.fs, bin: BIN, platform: 'win32', tag: 'v0.8.0', current: '0.7.0', now });
    expect(staged.previousFile).toBe('telinha.old-0.7.0.exe');
    expect(m.names()).toEqual(['telinha.exe', 'telinha.old-0.7.0.exe']);
    expect(m.text(`${BIN}/telinha.exe`)).toBe('new');
  });

  test('a busy leftover (EBUSY) is tolerated and a taken .old name gets a timestamp suffix', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha.exe`, 'v0.7.0');
    m.put(`${BIN}/telinha.new.exe`, 'v0.8.0');
    // The loop still executes from this one: the sweep cannot delete it.
    m.put(`${BIN}/telinha.old-0.7.0.exe`, 'running loop binary');
    m.busy.add(`${BIN}/telinha.old-0.7.0.exe`);
    const logs: string[] = [];
    const staged = await stage({ fs: m.fs, bin: BIN, platform: 'win32', tag: 'v0.8.0', current: '0.7.0', now, log: (...a) => logs.push(a.join(' ')) });
    expect(staged.previousFile).toBe(`telinha.old-0.7.0-${Math.floor(T0 / 1000)}.exe`);
    expect(m.text(`${BIN}/telinha.old-0.7.0.exe`)).toBe('running loop binary');
    expect(m.text(`${BIN}/${staged.previousFile}`)).toBe('v0.7.0');
    expect(m.text(`${BIN}/telinha.exe`)).toBe('v0.8.0');
    expect(logs.some((l) => l.includes('telinha.old-0.7.0.exe not removed yet'))).toBe(true);
  });

  test('second rename failing undoes the first', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha`, 'current');
    m.put(`${BIN}/telinha.new`, 'new');
    m.busy.add(`${BIN}/telinha.new`);
    await expect(stage({ fs: m.fs, bin: BIN, platform: 'linux', tag: 'v0.8.0', current: '0.7.0', now })).rejects.toThrow('EBUSY');
    expect(m.text(`${BIN}/telinha`)).toBe('current');
    expect(m.ops).toEqual(['rename telinha -> telinha.old-0.7.0', 'rename telinha.old-0.7.0 -> telinha']);
  });

  test('nothing to install without telinha.new', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha`, 'current');
    await expect(stage({ fs: m.fs, bin: BIN, platform: 'linux', tag: 'v0.8.0', current: '0.7.0', now })).rejects.toThrow('nothing to install');
    expect(m.ops).toEqual([]);
  });
});

describe('tray', () => {
  const winStage = (m: ReturnType<typeof memFs>, logs: string[] = []) =>
    stage({ fs: m.fs, bin: BIN, platform: 'win32', tag: 'v0.8.0', current: '0.7.0', now, log: (...a) => logs.push(a.join(' ')) });
  const install = (m: ReturnType<typeof memFs>) => {
    m.put(`${BIN}/telinha.exe`, 'v0.7.0');
    m.put(`${BIN}/telinha.new.exe`, 'v0.8.0');
  };

  test('staged alongside telinha.exe: the installed tray becomes telinha-tray.old-<current>.exe', async () => {
    const m = memFs();
    install(m);
    m.put(`${BIN}/telinha-tray.exe`, 'tray v0.7.0');
    m.put(`${BIN}/telinha-tray.new.exe`, 'tray v0.8.0');
    m.put(`${BIN}/telinha-tray.old-0.6.0.exe`, 'leftover');
    const logs: string[] = [];
    const staged = await winStage(m, logs);
    expect(m.ops).toEqual([
      'rm telinha-tray.old-0.6.0.exe',
      'rename telinha.exe -> telinha.old-0.7.0.exe', 'rename telinha.new.exe -> telinha.exe',
      'rename telinha-tray.exe -> telinha-tray.old-0.7.0.exe', 'rename telinha-tray.new.exe -> telinha-tray.exe',
    ]);
    expect(staged).toEqual({
      tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0.exe', trayPreviousFile: 'telinha-tray.old-0.7.0.exe', at: T0, failedStarts: 0,
    });
    expect(m.text(`${BIN}/telinha-tray.exe`)).toBe('tray v0.8.0');
    expect(m.text(`${BIN}/telinha-tray.old-0.7.0.exe`)).toBe('tray v0.7.0');
    expect(logs.join('\n')).toContain('tray installed as telinha-tray.exe (previous kept as telinha-tray.old-0.7.0.exe)');
  });

  test('a running tray is renamed aside, survives the sweep as .old and goes once it has exited', async () => {
    const m = memFs();
    install(m);
    m.put(`${BIN}/telinha-tray.exe`, 'tray v0.7.0');
    m.put(`${BIN}/telinha-tray.new.exe`, 'tray v0.8.0');
    m.running.add(`${BIN}/telinha.exe`);
    m.running.add(`${BIN}/telinha-tray.exe`);
    const staged = await winStage(m);
    expect(staged.trayPreviousFile).toBe('telinha-tray.old-0.7.0.exe');
    expect(m.text(`${BIN}/telinha-tray.exe`)).toBe('tray v0.8.0');
    expect(await sweep(m.fs, BIN)).toEqual([]);
    expect(m.text(`${BIN}/telinha-tray.old-0.7.0.exe`)).toBe('tray v0.7.0');
    // The tray relaunched from the new file: the next sweep removes its old one.
    m.running.delete(`${BIN}/telinha-tray.old-0.7.0.exe`);
    expect(await sweep(m.fs, BIN)).toEqual(['telinha-tray.old-0.7.0.exe']);
  });

  test('no staged telinha-tray.new.exe (older release): the installed tray is left alone', async () => {
    const m = memFs();
    install(m);
    m.put(`${BIN}/telinha-tray.exe`, 'tray v0.7.0');
    const staged = await winStage(m);
    expect(staged.trayPreviousFile).toBeUndefined();
    expect(m.ops).toEqual(['rename telinha.exe -> telinha.old-0.7.0.exe', 'rename telinha.new.exe -> telinha.exe']);
    expect(m.text(`${BIN}/telinha-tray.exe`)).toBe('tray v0.7.0');
  });

  test('tray not installed: the staged .new is kept uninstalled as telinha-tray.dist.exe, for a later setup', async () => {
    const m = memFs();
    install(m);
    m.put(`${BIN}/telinha-tray.new.exe`, 'tray v0.8.0');
    const logs: string[] = [];
    const staged = await winStage(m, logs);
    expect(staged.trayPreviousFile).toBeUndefined();
    expect(m.ops).toEqual(['rename telinha.exe -> telinha.old-0.7.0.exe', 'rename telinha.new.exe -> telinha.exe', 'rename telinha-tray.new.exe -> telinha-tray.dist.exe']);
    expect(m.names()).toEqual(['telinha-tray.dist.exe', 'telinha.exe', 'telinha.old-0.7.0.exe']);
    expect(m.text(`${BIN}/telinha-tray.dist.exe`)).toBe('tray v0.8.0');
    expect(logs).toContain('update: v0.8.0 tray not installed; kept as telinha-tray.dist.exe');
  });

  test('opted out with a kept copy: it is replaced like an installed tray, never installed', async () => {
    const m = memFs();
    install(m);
    m.put(`${BIN}/telinha-tray.dist.exe`, 'tray v0.7.0');
    m.put(`${BIN}/telinha-tray.new.exe`, 'tray v0.8.0');
    const staged = await winStage(m);
    expect(staged.trayPreviousFile).toBe('telinha-tray.old-0.7.0.exe');
    expect(m.names()).toEqual(['telinha-tray.dist.exe', 'telinha-tray.old-0.7.0.exe', 'telinha.exe', 'telinha.old-0.7.0.exe']);
    expect(m.text(`${BIN}/telinha-tray.dist.exe`)).toBe('tray v0.8.0');
    expect(m.text(`${BIN}/telinha-tray.old-0.7.0.exe`)).toBe('tray v0.7.0');
  });

  test('a tray that cannot be replaced is logged, its .new removed, and the update still stages', async () => {
    const m = memFs();
    install(m);
    m.put(`${BIN}/telinha-tray.exe`, 'tray v0.7.0');
    m.put(`${BIN}/telinha-tray.new.exe`, 'tray v0.8.0');
    m.busy.add(`${BIN}/telinha-tray.exe`);
    const logs: string[] = [];
    const staged = await winStage(m, logs);
    expect(staged.trayPreviousFile).toBeUndefined();
    expect(m.text(`${BIN}/telinha.exe`)).toBe('v0.8.0');
    expect(m.text(`${BIN}/telinha-tray.exe`)).toBe('tray v0.7.0');
    expect(m.names()).toEqual(['telinha-tray.exe', 'telinha.exe', 'telinha.old-0.7.0.exe']);
    expect(logs.some((l) => l.startsWith('update: tray not replaced: EBUSY'))).toBe(true);
  });

  test('the second tray rename failing puts the installed tray back', async () => {
    const m = memFs();
    install(m);
    m.put(`${BIN}/telinha-tray.exe`, 'tray v0.7.0');
    m.put(`${BIN}/telinha-tray.new.exe`, 'tray v0.8.0');
    m.busy.add(`${BIN}/telinha-tray.new.exe`);
    const logs: string[] = [];
    const staged = await winStage(m, logs);
    expect(staged.trayPreviousFile).toBeUndefined();
    expect(m.text(`${BIN}/telinha-tray.exe`)).toBe('tray v0.7.0');
    expect(m.ops.slice(2)).toEqual(['rename telinha-tray.exe -> telinha-tray.old-0.7.0.exe', 'rename telinha-tray.old-0.7.0.exe -> telinha-tray.exe']);
    expect(logs.some((l) => l.startsWith('update: tray not replaced'))).toBe(true);
  });

  const staged = { tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0.exe', trayPreviousFile: 'telinha-tray.old-0.7.0.exe', at: T0, failedStarts: 2 };

  test('rollback restores the previous tray and keeps the bad one as telinha-tray.failed-<tag>.exe', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha.exe`, 'bad');
    m.put(`${BIN}/telinha.old-0.7.0.exe`, 'good');
    m.put(`${BIN}/telinha-tray.exe`, 'tray bad');
    m.put(`${BIN}/telinha-tray.old-0.7.0.exe`, 'tray good');
    // The new tray is running: renaming it aside still works.
    m.running.add(`${BIN}/telinha-tray.exe`);
    const logs: string[] = [];
    await rollback({ fs: m.fs, bin: BIN, platform: 'win32', staged, exitCode: 1, now, log: (...a) => logs.push(a.join(' ')) });
    expect(m.ops).toEqual([
      'rename telinha.exe -> telinha.failed-v0.8.0.exe', 'rename telinha.old-0.7.0.exe -> telinha.exe',
      'rename telinha-tray.exe -> telinha-tray.failed-v0.8.0.exe', 'rename telinha-tray.old-0.7.0.exe -> telinha-tray.exe',
    ]);
    expect(m.text(`${BIN}/telinha-tray.exe`)).toBe('tray good');
    expect(m.text(`${BIN}/telinha-tray.failed-v0.8.0.exe`)).toBe('tray bad');
    expect(logs.join('\n')).toContain('tray rolled back (telinha-tray.old-0.7.0.exe)');
  });

  test('rollback of the tray is best effort: a failure is logged, the executable rollback stands', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha.exe`, 'bad');
    m.put(`${BIN}/telinha.old-0.7.0.exe`, 'good');
    m.put(`${BIN}/telinha-tray.exe`, 'tray bad');
    m.put(`${BIN}/telinha-tray.old-0.7.0.exe`, 'tray good');
    m.busy.add(`${BIN}/telinha-tray.old-0.7.0.exe`);
    const logs: string[] = [];
    const failed = await rollback({ fs: m.fs, bin: BIN, platform: 'win32', staged, exitCode: 1, now, log: (...a) => logs.push(a.join(' ')) });
    expect(failed.tag).toBe('v0.8.0');
    expect(m.text(`${BIN}/telinha.exe`)).toBe('good');
    expect(m.text(`${BIN}/telinha-tray.exe`)).toBe('tray bad');
    expect(logs.some((l) => l.startsWith('update: tray not rolled back'))).toBe(true);
  });

  test('rollback puts the previous tray back where the tray is now: the kept copy of an opted-out install', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha.exe`, 'bad');
    m.put(`${BIN}/telinha.old-0.7.0.exe`, 'good');
    m.put(`${BIN}/telinha-tray.dist.exe`, 'tray bad');
    m.put(`${BIN}/telinha-tray.old-0.7.0.exe`, 'tray good');
    await rollback({ fs: m.fs, bin: BIN, platform: 'win32', staged, exitCode: 1, now });
    expect(m.names()).toEqual(['telinha-tray.dist.exe', 'telinha-tray.failed-v0.8.0.exe', 'telinha.exe', 'telinha.failed-v0.8.0.exe']);
    expect(m.text(`${BIN}/telinha-tray.dist.exe`)).toBe('tray good');
  });

  test('rollback leaves an uninstalled tray uninstalled and skips the tray when the executable stayed', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha.exe`, 'bad');
    m.put(`${BIN}/telinha.old-0.7.0.exe`, 'good');
    m.put(`${BIN}/telinha-tray.old-0.7.0.exe`, 'tray good');
    await rollback({ fs: m.fs, bin: BIN, platform: 'win32', staged, exitCode: 1, now });
    expect(m.names()).toEqual(['telinha-tray.old-0.7.0.exe', 'telinha.exe', 'telinha.failed-v0.8.0.exe']);

    const kept = memFs();
    kept.put(`${BIN}/telinha.exe`, 'bad');
    kept.put(`${BIN}/telinha-tray.exe`, 'tray bad');
    kept.put(`${BIN}/telinha-tray.old-0.7.0.exe`, 'tray good');
    await rollback({ fs: kept.fs, bin: BIN, platform: 'win32', staged, exitCode: 1, now });
    expect(kept.ops).toEqual([]);
  });

  test('newestOld never picks a tray file', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha-tray.old-0.9.0.exe`, 'tray', 99);
    m.put(`${BIN}/telinha.old-0.6.0.exe`, 'old', 10);
    expect(await newestOld(m.fs, BIN, 'win32')).toBe('telinha.old-0.6.0.exe');
  });
});

describe('rollback', () => {
  const staged ={ tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: T0, failedStarts: 2 };

  test('puts the recorded previous file back and keeps the bad one as telinha.failed-<tag>', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha`, 'bad v0.8.0');
    m.put(`${BIN}/telinha.old-0.7.0`, 'good v0.7.0');
    const failed = await rollback({ fs: m.fs, bin: BIN, platform: 'linux', staged, exitCode: 1, now });
    expect(failed).toEqual({ tag: 'v0.8.0', at: T0, reason: 'start failed twice (exit 1)' });
    expect(m.ops).toEqual(['rename telinha -> telinha.failed-v0.8.0', 'rename telinha.old-0.7.0 -> telinha']);
    expect(m.text(`${BIN}/telinha`)).toBe('good v0.7.0');
    expect(m.text(`${BIN}/telinha.failed-v0.8.0`)).toBe('bad v0.8.0');
  });

  test('falls back to the newest telinha.old-* by mtime when the recorded file is gone', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha.exe`, 'bad', 50);
    m.put(`${BIN}/telinha.old-0.5.0.exe`, 'older', 10);
    m.put(`${BIN}/telinha.old-0.6.0.exe`, 'newest old', 30);
    m.put(`${BIN}/telinha.old-0.6.5.exe`, 'in between', 20);
    m.put(`${BIN}/telinha.old-0.9.0`, 'wrong platform', 99);
    expect(await newestOld(m.fs, BIN, 'win32')).toBe('telinha.old-0.6.0.exe');
    expect(await newestOld(m.fs, BIN, 'linux')).toBe('telinha.old-0.9.0');
    await rollback({ fs: m.fs, bin: BIN, platform: 'win32', staged: { ...staged, previousFile: 'telinha.old-0.7.0.exe' }, exitCode: 2, now });
    expect(m.text(`${BIN}/telinha.exe`)).toBe('newest old');
    expect(m.text(`${BIN}/telinha.failed-v0.8.0.exe`)).toBe('bad');
  });

  test('no previous file: the record is produced, the executable stays', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha`, 'bad');
    const logs: string[] = [];
    const failed = await rollback({ fs: m.fs, bin: BIN, platform: 'linux', staged, exitCode: 1, now, log: (...a) => logs.push(a.join(' ')) });
    expect(failed.tag).toBe('v0.8.0');
    expect(m.ops).toEqual([]);
    expect(m.text(`${BIN}/telinha`)).toBe('bad');
    expect(logs[0]).toContain('no previous executable');
  });

  test('restore failing puts the bad file back so something runs', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha`, 'bad');
    m.put(`${BIN}/telinha.old-0.7.0`, 'good');
    m.busy.add(`${BIN}/telinha.old-0.7.0`);
    await rollback({ fs: m.fs, bin: BIN, platform: 'linux', staged, exitCode: 1, now });
    expect(m.text(`${BIN}/telinha`)).toBe('bad');
    expect(m.ops).toEqual(['rename telinha -> telinha.failed-v0.8.0', 'rename telinha.failed-v0.8.0 -> telinha']);
  });
});

describe('sweep and finish', () => {
  test('sweep removes old/failed files only, skipping busy ones', async () => {
    const m = memFs();
    m.put(`${BIN}/telinha`, 'x');
    m.put(`${BIN}/telinha.old-0.6.0`, 'x');
    m.put(`${BIN}/telinha.failed-v0.6.1`, 'x');
    m.put(`${BIN}/telinha.old-0.7.0`, 'busy');
    m.put(`${BIN}/livekit-server`, 'x');
    m.busy.add(`${BIN}/telinha.old-0.7.0`);
    expect((await sweep(m.fs, BIN)).sort()).toEqual(['telinha.failed-v0.6.1', 'telinha.old-0.6.0']);
    expect(m.names()).toEqual(['livekit-server', 'telinha', 'telinha.old-0.7.0']);
  });

  test('sweep removes tray leftovers too, never the tray or its staged .new', async () => {
    const m = memFs();
    for (const name of ['telinha-tray.exe', 'telinha-tray.new.exe', 'telinha-tray.old-0.6.0.exe', 'telinha-tray.failed-v0.6.1.exe', 'telinha-tray.old-manual-1700000000.exe']) {
      m.put(`${BIN}/${name}`, 'x');
    }
    expect((await sweep(m.fs, BIN)).sort()).toEqual(['telinha-tray.failed-v0.6.1.exe', 'telinha-tray.old-0.6.0.exe', 'telinha-tray.old-manual-1700000000.exe']);
    expect(m.names()).toEqual(['telinha-tray.exe', 'telinha-tray.new.exe']);
  });

  test('finish records the staged update as applied, clears staged in update.json and sweeps', async () => {
    const m = memFs();
    const statePath = '/t/data/run/update.json';
    const applied = { tag: 'v0.8.0', previous: '0.7.0', at: T0 };
    m.put(statePath, JSON.stringify({
      staged: { tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: 1, failedStarts: 1 },
      applied: { tag: 'v0.7.0', previous: '0.6.0', at: 1 },
      lastCheck: 5,
    }));
    m.put(`${BIN}/telinha`, 'x');
    m.put(`${BIN}/telinha.old-0.7.0`, 'x');
    await finish({ fs: m.fs, bin: BIN, statePath, now });
    expect(await readState(m.fs, statePath)).toEqual({ applied, lastCheck: 5 });
    expect(m.names()).toEqual(['telinha', 'update.json']);
    // Idempotent without a staged record: applied stays until the next update replaces it.
    await finish({ fs: m.fs, bin: BIN, statePath, now: () => T0 + 1 });
    expect(await readState(m.fs, statePath)).toEqual({ applied, lastCheck: 5 });
  });

  test('readState tolerates a missing or corrupt file', async () => {
    const m = memFs();
    expect(await readState(m.fs, '/none.json')).toEqual({});
    m.put('/bad.json', '{not json');
    expect(await readState(m.fs, '/bad.json')).toEqual({});
    m.put('/arr.json', '[1]');
    expect(await readState(m.fs, '/arr.json')).toEqual({});
  });
});
