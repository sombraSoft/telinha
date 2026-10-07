import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile, mergeEnv, parseEnvFile } from '../src/envfile.ts';

const parityWarning = (k: string) =>
  `envfile: ${k} contains $, \\ or #; single-quote it so Docker and native read the same value`;

describe('parseEnvFile', () => {
  test('comments, blank lines, export prefix, trimming', () => {
    const { vars, warnings } = parseEnvFile(
      [
        '# a comment',
        '',
        '   ',
        '  # indented comment',
        'A=1',
        '  B = two words  ',
        'export C=3',
        'export\tD=4',
        'E=',
        'F=a=b',
        'exportG=5',
      ].join('\n'),
    );
    expect(vars).toEqual({ A: '1', B: 'two words', C: '3', D: '4', E: '', F: 'a=b', exportG: '5' });
    expect(warnings).toEqual([]);
  });

  test('CRLF line endings and a BOM', () => {
    expect(parseEnvFile('﻿A=1\r\nB=2\r\n').vars).toEqual({ A: '1', B: '2' });
  });

  test('matching quotes are stripped, nothing is unescaped or interpolated', () => {
    const { vars } = parseEnvFile(
      [
        `S='it''s'`,
        'D="a\\nb"',
        `Q=''`,
        'DQ=""',
        `MIX='abc"`,
        `ONE='`,
        'HASH=abc #not a comment',
        `INNER='a "b" c'`,
      ].join('\n'),
    );
    expect(vars).toEqual({
      S: "it''s",
      D: 'a\\nb',
      Q: '',
      DQ: '',
      MIX: `'abc"`,
      ONE: "'",
      HASH: 'abc #not a comment',
      INNER: 'a "b" c',
    });
  });

  test('bad keys and lines without = are skipped and reported without the value', () => {
    const { vars, warnings } = parseEnvFile('1A=x\nGOOD=1\nBAD-KEY=x\nsk-live-secret\n=v');
    expect(vars).toEqual({ GOOD: '1' });
    expect(warnings).toEqual([
      'envfile: line 1: bad key "1A", skipped',
      'envfile: line 3: bad key "BAD-KEY", skipped',
      'envfile: line 4 has no "=", skipped',
      'envfile: line 5: bad key "", skipped',
    ]);
    expect(warnings.join()).not.toContain('sk-live-secret');
  });

  test('$, \\ or # outside single quotes warn (Docker would read them differently)', () => {
    const { vars, warnings } = parseEnvFile('A=pa$$\nB="x\\y"\nC=a#b\nD="$HOME"\nE=plain\nF="plain"');
    expect(vars).toEqual({ A: 'pa$$', B: 'x\\y', C: 'a#b', D: '$HOME', E: 'plain', F: 'plain' });
    expect(warnings).toEqual(['A', 'B', 'C', 'D'].map(parityWarning));
  });

  test('single-quoted values with $, \\ or # do not warn', () => {
    const { vars, warnings } = parseEnvFile(`A='pa$$'\nB='x\\y'\nC='a#b'`);
    expect(vars).toEqual({ A: 'pa$$', B: 'x\\y', C: 'a#b' });
    expect(warnings).toEqual([]);
  });

  test('later lines win', () => {
    expect(parseEnvFile('A=1\nA=2').vars).toEqual({ A: '2' });
  });
});

describe('loadEnvFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telinha-envfile-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('null when absent', () => {
    expect(loadEnvFile(join(dir, 'nope.env'))).toBeNull();
    expect(loadEnvFile(join(dir, 'missing', 'telinha.env'))).toBeNull();
  });

  test('parses an existing file', () => {
    const p = join(dir, 'telinha.env');
    writeFileSync(p, "A=1\nB='$x'\nC=$y\n");
    expect(loadEnvFile(p)).toEqual({ vars: { A: '1', B: '$x', C: '$y' }, warnings: [parityWarning('C')] });
  });

  test('throws when the path cannot be read', () => {
    // A directory stands in for an unreadable file (EISDIR); permissions are not portable to Windows.
    const d = join(dir, 'adir.env');
    mkdirSync(d);
    expect(() => loadEnvFile(d)).toThrow();
  });
});

describe('mergeEnv', () => {
  test('process env wins over the file', () => {
    expect(mergeEnv({ A: 'file', B: 'file' }, { A: 'proc', C: 'proc' })).toEqual({ A: 'proc', B: 'file', C: 'proc' });
  });

  test('empty or undefined process vars do not override', () => {
    expect(mergeEnv({ A: 'file', B: 'file' }, { A: '', B: undefined })).toEqual({ A: 'file', B: 'file' });
  });

  test('does not mutate its inputs', () => {
    const file = { A: '1' };
    mergeEnv(file, { A: '2' });
    expect(file).toEqual({ A: '1' });
  });
});
