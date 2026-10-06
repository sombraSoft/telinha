import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBinary, homeOfExe, resolvePaths } from '../src/paths.ts';

describe('resolvePaths', () => {
  test('win32: %LOCALAPPDATA%\\Telinha', () => {
    expect(resolvePaths({ LOCALAPPDATA: 'C:\\Users\\zé\\AppData\\Local' }, 'win32', false)).toEqual({
      home: 'C:\\Users\\zé\\AppData\\Local\\Telinha',
      bin: 'C:\\Users\\zé\\AppData\\Local\\Telinha\\bin',
      config: 'C:\\Users\\zé\\AppData\\Local\\Telinha\\config',
      data: 'C:\\Users\\zé\\AppData\\Local\\Telinha\\data',
      run: 'C:\\Users\\zé\\AppData\\Local\\Telinha\\data\\run',
      logs: 'C:\\Users\\zé\\AppData\\Local\\Telinha\\logs',
      logFile: 'C:\\Users\\zé\\AppData\\Local\\Telinha\\logs\\telinha.log',
    });
  });

  test('linux root: /opt/telinha, XDG ignored', () => {
    expect(resolvePaths({ HOME: '/root', XDG_DATA_HOME: '/xdg' }, 'linux', true)).toEqual({
      home: '/opt/telinha',
      bin: '/opt/telinha/bin',
      config: '/opt/telinha/config',
      data: '/opt/telinha/data',
      run: '/opt/telinha/data/run',
      logs: '/opt/telinha/logs',
      logFile: '/opt/telinha/logs/telinha.log',
    });
  });

  test('linux user: ~/.local/share/telinha', () => {
    const p = resolvePaths({ HOME: '/home/ze' }, 'linux', false);
    expect(p.home).toBe('/home/ze/.local/share/telinha');
    expect(p.config).toBe('/home/ze/.local/share/telinha/config');
    expect(p.run).toBe('/home/ze/.local/share/telinha/data/run');
  });

  test('linux user: XDG_DATA_HOME respected, empty one ignored', () => {
    expect(resolvePaths({ HOME: '/home/ze', XDG_DATA_HOME: '/xdg' }, 'linux', false).home).toBe('/xdg/telinha');
    expect(resolvePaths({ HOME: '/home/ze', XDG_DATA_HOME: '' }, 'linux', false).home).toBe('/home/ze/.local/share/telinha');
  });

  test('TELINHA_HOME wins on every platform', () => {
    expect(resolvePaths({ TELINHA_HOME: '/telinha' }, 'linux', true).data).toBe('/telinha/data');
    expect(resolvePaths({ TELINHA_HOME: '/telinha', HOME: '/home/ze' }, 'linux', false).bin).toBe('/telinha/bin');
    expect(resolvePaths({ TELINHA_HOME: 'D:\\tl', LOCALAPPDATA: 'C:\\x' }, 'win32', false).config).toBe('D:\\tl\\config');
  });

  test('BIN_DIR and DATA_DIR override their own entries; run follows DATA_DIR', () => {
    const p = resolvePaths({ TELINHA_HOME: '/telinha', BIN_DIR: '/usr/local/bin', DATA_DIR: '/data' }, 'linux', true);
    expect(p).toEqual({
      home: '/telinha', bin: '/usr/local/bin', config: '/telinha/config',
      data: '/data', run: '/data/run', logs: '/telinha/logs', logFile: '/telinha/logs/telinha.log',
    });
  });
});

describe('homeOfExe', () => {
  const none = () => false;
  test('<home>/bin/telinha[.exe] under a home named telinha: that home', () => {
    expect(homeOfExe('C:\\Telinha\\bin\\telinha.exe', 'win32', none)).toBe('C:\\Telinha');
    expect(homeOfExe('C:\\Users\\ana\\AppData\\Local\\Telinha\\BIN\\telinha.exe', 'win32', none)).toBe('C:\\Users\\ana\\AppData\\Local\\Telinha');
    expect(homeOfExe('/srv/telinha/bin/telinha', 'linux', none)).toBe('/srv/telinha');
  });

  test('another name counts once it holds config/telinha.env', () => {
    expect(homeOfExe('D:\\apps\\screen\\bin\\telinha.exe', 'win32', none)).toBeNull();
    expect(homeOfExe('D:\\apps\\screen\\bin\\telinha.exe', 'win32', (p) => p === 'D:\\apps\\screen\\config\\telinha.env')).toBe('D:\\apps\\screen');
  });

  test('not in a bin dir (a download), or ~/bin: no home', () => {
    expect(homeOfExe('C:\\Users\\ana\\Downloads\\telinha.exe', 'win32', none)).toBeNull();
    expect(homeOfExe('/home/ana/bin/telinha', 'linux', none)).toBeNull();
    expect(homeOfExe('/usr/local/lib/telinha/telinha', 'linux', () => true)).toBeNull();
  });
});

describe('findBinary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telinha-paths-'));
  const bin = join(dir, 'bin');
  const onPath = join(dir, 'path');
  mkdirSync(bin);
  mkdirSync(onPath);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const exe = (d: string, name: string) => {
    const p = join(d, process.platform === 'win32' ? `${name}.exe` : name);
    writeFileSync(p, '');
    chmodSync(p, 0o755);
    return p;
  };

  test('BIN_DIR before PATH', () => {
    const local = exe(bin, 'both-tool');
    exe(onPath, 'both-tool');
    expect(findBinary('both-tool', { bin }, onPath)).toBe(local);
  });

  test('falls back to PATH', () => {
    const p = exe(onPath, 'path-tool');
    expect(findBinary('path-tool', { bin }, onPath)?.toLowerCase()).toBe(p.toLowerCase());
  });

  test('null when nowhere', () => {
    expect(findBinary('telinha-no-such-tool', { bin }, onPath)).toBeNull();
  });
});
