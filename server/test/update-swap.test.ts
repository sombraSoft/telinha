import { describe, expect, test } from 'bun:test';
import { basename } from 'node:path';
import { readState } from '../src/update/state.ts';
import { finish, newestOld, rollback, stage, sweep } from '../src/update/swap.ts';
import type { UpdateFs } from '../src/update/types.ts';

const T0 = 1_700_000_000_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** In-memory UpdateFs: paths normalized to /, busy paths refuse rm/rename like a running exe on Windows. */
function memFs() {
  const files = new Map<string, { data: Uint8Array; mtimeMs: number }>();
  const busy = new Set<string>();
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
      ops.push(`rename ${basename(f)} -> ${basename(t)}`);
    },
    async rm(p) {
      if (busy.has(n(p))) throw err('EBUSY', p);
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
  return { fs, files, busy, ops, put, text, names };
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

describe('rollback', () => {
  const staged = { tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: T0, failedStarts: 2 };

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

  test('finish clears staged in update.json and sweeps', async () => {
    const m = memFs();
    const statePath = '/t/data/run/update.json';
    m.put(statePath, JSON.stringify({ staged: { tag: 'v0.8.0', previous: '0.7.0', previousFile: 'telinha.old-0.7.0', at: 1, failedStarts: 1 }, lastCheck: 5 }));
    m.put(`${BIN}/telinha`, 'x');
    m.put(`${BIN}/telinha.old-0.7.0`, 'x');
    await finish({ fs: m.fs, bin: BIN, statePath });
    expect(await readState(m.fs, statePath)).toEqual({ lastCheck: 5 });
    expect(m.names()).toEqual(['telinha', 'update.json']);
    // Idempotent without a staged record.
    await finish({ fs: m.fs, bin: BIN, statePath });
    expect(await readState(m.fs, statePath)).toEqual({ lastCheck: 5 });
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
