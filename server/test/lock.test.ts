import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, AlreadyRunningError } from '../src/lock.ts';
import { sameExe } from '../src/supervisor.ts';

const dir = mkdtempSync(join(tmpdir(), 'telinha-lock-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(dir, `run${++n}`, 'telinha.pid');
const record = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { pid: number; exe: string; startedAt: number };

/** Fake process table: pid -> executable; anything else is dead. */
const table = (procs: Record<number, string>) => (pid: number) =>
  procs[pid] ? { alive: true, exe: procs[pid]! } : { alive: false, exe: null };

const opts = (pid: number, procs: Record<number, string> = {}) => ({
  pid, exe: 'telinha.exe', platform: 'win32' as const, processInfo: table(procs), sameExe, now: () => 1000,
});

describe('acquireLock', () => {
  test('creates the pidfile (and its directory) with pid, exe and start time', () => {
    const path = fresh();
    const lock = acquireLock(path, opts(10));
    expect(record(path)).toEqual({ pid: 10, exe: 'telinha.exe', startedAt: 1000 });
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  test('a live process of the same executable keeps it: AlreadyRunningError with its pid', () => {
    const path = fresh();
    acquireLock(path, opts(10));
    let err: unknown;
    try {
      acquireLock(path, opts(20, { 10: 'TELINHA.EXE' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as AlreadyRunningError).pid).toBe(10);
    // The holder's file is untouched.
    expect(record(path).pid).toBe(10);
  });

  test('a dead pid is replaced', () => {
    const path = fresh();
    acquireLock(path, opts(10));
    acquireLock(path, opts(20));
    expect(record(path).pid).toBe(20);
  });

  test('a pid now running another program is replaced', () => {
    const path = fresh();
    acquireLock(path, opts(10));
    acquireLock(path, opts(20, { 10: 'chrome.exe' }));
    expect(record(path).pid).toBe(20);
  });

  test('our own pid from before a reboot is replaced', () => {
    const path = fresh();
    acquireLock(path, opts(10));
    acquireLock(path, opts(10, { 10: 'telinha.exe' }));
    expect(record(path).pid).toBe(10);
  });

  test('linux: comm cut at 15 chars still counts as the same executable', () => {
    const path = fresh();
    acquireLock(path, { ...opts(10), exe: 'telinha-from-source', platform: 'linux' });
    expect(() => acquireLock(path, { ...opts(20, { 10: 'telinha-from-so' }), platform: 'linux' })).toThrow(AlreadyRunningError);
  });

  test('garbage: replaced when old, held when it may be a start still writing it', () => {
    const old = fresh();
    acquireLock(old, opts(1)).release();
    writeFileSync(old, 'not json');
    utimesSync(old, new Date(0), new Date(0));
    acquireLock(old, { ...opts(20), now: Date.now });
    expect(record(old).pid).toBe(20);

    const young = fresh();
    acquireLock(young, opts(1)).release();
    writeFileSync(young, '');
    expect(() => acquireLock(young, { ...opts(20), now: Date.now })).toThrow(AlreadyRunningError);
  });

  test('release() deletes only a file that still names this process', () => {
    const path = fresh();
    const mine = acquireLock(path, opts(10));
    // Someone replaced it (a stale lock taken over after ours was deleted by hand).
    writeFileSync(path, JSON.stringify({ pid: 99, exe: 'telinha.exe', startedAt: 1 }));
    mine.release();
    expect(record(path).pid).toBe(99);
  });

  test('release() twice, or after the file vanished, is harmless', () => {
    const path = fresh();
    const lock = acquireLock(path, opts(10));
    rmSync(path);
    lock.release();
    lock.release();
    expect(existsSync(path)).toBe(false);
  });
});
