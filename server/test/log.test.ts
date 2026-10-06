import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/log.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'telinha-log-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = new Date('2026-10-05T12:00:00.000Z');
const now = () => at;
// "2026-10-05T12:00:00.000Z " is 25 bytes; "x".repeat(4) + "\n" makes 30-byte lines.
const LINE = 30;

describe('createLogger', () => {
  test('stdout: the same arguments as console.log with the timestamp first', () => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { log } = createLogger({ now });
      log('telinha', 1, { a: 1 });
      expect(spy).toHaveBeenCalledWith('2026-10-05T12:00:00.000Z', 'telinha', 1, { a: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  test('file: formatted lines, stdout off', () => {
    const file = join(tmp(), 'logs', 'telinha.log');
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const l = createLogger({ stdout: false, file, now });
      l.log('a', 2, { b: 'c' });
      l.close();
      expect(spy).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe("2026-10-05T12:00:00.000Z a 2 { b: 'c' }\n");
    } finally {
      spy.mockRestore();
    }
  });

  test('rotates at the boundary without splitting lines', () => {
    const file = join(tmp(), 'telinha.log');
    const l = createLogger({ stdout: false, file, now, maxBytes: LINE * 3, keep: 2 });
    for (let i = 0; i < 3; i++) l.log(`${i}`.repeat(4));
    // Exactly at the limit: no rotation yet.
    expect(statSync(file).size).toBe(LINE * 3);
    expect(existsSync(`${file}.1`)).toBe(false);
    l.log('3333');
    expect(readFileSync(file, 'utf8')).toBe(`${at.toISOString()} 3333\n`);
    expect(readFileSync(`${file}.1`, 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
    for (let i = 4; i < 10; i++) l.log(`${i}`.repeat(4));
    l.close();
    // keep = 2: .1 and .2 exist, .3 never does; every file holds whole lines.
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    for (const f of [file, `${file}.1`, `${file}.2`]) {
      const text = readFileSync(f, 'utf8');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.length % LINE).toBe(0);
    }
    expect(readFileSync(file, 'utf8')).toContain('9999');
    expect(readFileSync(`${file}.2`, 'utf8')).toContain('3333');
  });

  test('appends to an existing file and counts its size', () => {
    const file = join(tmp(), 'telinha.log');
    const a = createLogger({ stdout: false, file, now, maxBytes: LINE * 2 });
    a.log('aaaa');
    a.close();
    const b = createLogger({ stdout: false, file, now, maxBytes: LINE * 2 });
    b.log('bbbb');
    b.log('cccc');
    b.close();
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(`${at.toISOString()} aaaa\n${at.toISOString()} bbbb\n`);
    expect(readFileSync(file, 'utf8')).toBe(`${at.toISOString()} cccc\n`);
  });

  test('close() stops file writes; stdout keeps working', () => {
    const file = join(tmp(), 'telinha.log');
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const l = createLogger({ file, now });
      l.log('before');
      l.close();
      l.close();
      l.log('after');
      expect(readFileSync(file, 'utf8')).toBe(`${at.toISOString()} before\n`);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
