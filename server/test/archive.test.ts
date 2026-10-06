import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, extractTo, readTarGz, readZip, writeTarGz, writeZip, type Entry } from '../src/archive.ts';

const enc = new TextEncoder();
const bin = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
const longPath = `${'deep/'.repeat(30)}file-with-a-long-name.txt`;
const ENTRIES: Entry[] = [
  { path: 'telinha', mode: 0o755, data: bin },
  { path: 'LICENSE', mode: 0o644, data: enc.encode('MIT\n') },
  { path: 'empty', mode: 0o644, data: new Uint8Array(0) },
  { path: longPath, mode: 0o600, data: enc.encode('long') },
  { path: 'ação/ünïcode.txt', mode: 0o644, data: enc.encode('utf8 name') },
];

const tmp = () => mkdtempSync(join(tmpdir(), 'telinha-archive-'));

describe('round trip', () => {
  for (const [name, write, read] of [
    ['tar.gz', writeTarGz, readTarGz],
    ['zip', writeZip, readZip],
  ] as const) {
    test(`${name}: paths, modes and bytes survive`, () => {
      const back = read(write(ENTRIES));
      expect(back.map((e) => e.path)).toEqual(ENTRIES.map((e) => e.path));
      for (const [i, e] of back.entries()) {
        expect(e.mode).toBe(ENTRIES[i]!.mode);
        expect(Buffer.from(e.data).equals(Buffer.from(ENTRIES[i]!.data))).toBe(true);
      }
    });

    test(`${name}: deterministic`, () => {
      expect(Buffer.from(write(ENTRIES)).equals(Buffer.from(write(ENTRIES)))).toBe(true);
    });
  }

  test('crc32 matches the reference value', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
  });

  test('a corrupt zip is rejected', () => {
    const z = writeZip([{ path: 'a', mode: 0o644, data: enc.encode('hello hello hello hello') }]);
    z[33] = z[33]! ^ 0xff; // inside the first entry's data (30-byte header + 1-byte name)
    expect(() => readZip(z)).toThrow();
  });

  test('a corrupt tar header is rejected', () => {
    const tar = Bun.gunzipSync(writeTarGz([{ path: 'a', mode: 0o644, data: enc.encode('x') }]));
    tar[0] = 'b'.charCodeAt(0);
    expect(() => readTarGz(Bun.gzipSync(new Uint8Array(tar)))).toThrow('checksum');
  });
});

describe('extractTo', () => {
  test('writes the picked files with their modes', async () => {
    const dir = tmp();
    try {
      const written = await extractTo(ENTRIES, dir, (p) => p !== 'LICENSE');
      expect(written).toHaveLength(ENTRIES.length - 1);
      expect(existsSync(join(dir, 'LICENSE'))).toBe(false);
      expect(readFileSync(join(dir, longPath), 'utf8')).toBe('long');
      if (process.platform !== 'win32') {
        expect(statSync(join(dir, 'telinha')).mode & 0o777).toBe(0o755);
        expect(statSync(join(dir, longPath)).mode & 0o777).toBe(0o644);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const bad of ['../evil', 'a/../../evil', '/etc/evil', 'C:/evil', 'C:\\evil', '..\\evil']) {
    test(`rejects ${bad} and writes nothing`, async () => {
      const dir = tmp();
      try {
        const entries = [{ path: 'ok.txt', mode: 0o644, data: enc.encode('ok') }, { path: bad, mode: 0o644, data: enc.encode('x') }];
        await expect(extractTo(entries, dir)).rejects.toThrow(/absolute|escapes/);
        expect(existsSync(join(dir, 'ok.txt'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('zip-slip survives a round trip through the writers and is still rejected', async () => {
    const dir = tmp();
    try {
      const entries = readZip(writeZip([{ path: '../evil', mode: 0o644, data: enc.encode('x') }]));
      await expect(extractTo(entries, dir)).rejects.toThrow('escapes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Archives made by a real tool, when one is on PATH (Windows ships bsdtar, which also writes zip).
describe('real archives', () => {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : Bun.which('tar');
  const usable = !!tar && existsSync(tar);

  test.skipIf(!usable)('reads a tar.gz written by tar', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'hello.txt'), 'hello');
      const r = Bun.spawnSync([tar!, '-czf', 'out.tar.gz', 'hello.txt'], { cwd: dir });
      expect(r.exitCode).toBe(0);
      const entries = readTarGz(readFileSync(join(dir, 'out.tar.gz')));
      const e = entries.find((x) => x.path.replace(/^\.\//, '') === 'hello.txt');
      expect(new TextDecoder().decode(e!.data)).toBe('hello');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!usable)('reads a zip written by bsdtar (skipped when tar cannot write zip)', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'hello.txt'), 'hello '.repeat(100));
      const r = Bun.spawnSync([tar!, '-a', '-cf', 'out.zip', 'hello.txt'], { cwd: dir, stderr: 'ignore' });
      if (r.exitCode !== 0 || !existsSync(join(dir, 'out.zip'))) return;
      const data = readFileSync(join(dir, 'out.zip'));
      // GNU and busybox tar take -a but write a plain tar under the .zip name: not a zip writer.
      if (data[0] !== 0x50 || data[1] !== 0x4b) return;
      const entries = readZip(data);
      expect(new TextDecoder().decode(entries.find((x) => x.path === 'hello.txt')!.data)).toBe('hello '.repeat(100));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
