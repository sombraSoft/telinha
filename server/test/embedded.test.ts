import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedWebDir } from '../src/embedded.ts';
import { commit, hostTarget, isCompiled, version, versionLine } from '../src/version.ts';

const rootVersion = (await Bun.file(join(import.meta.dir, '..', '..', 'package.json')).json()).version as string;

describe('version (dev)', () => {
  test('not compiled under bun test', () => {
    expect(isCompiled()).toBe(false);
    expect(commit()).toBeNull();
  });

  test('version comes from the root package.json', () => {
    expect(version()).toBe(rootVersion);
  });

  test('versionLine names version, bun and target', () => {
    expect(versionLine()).toStartWith(`telinha ${rootVersion} (bun ${Bun.version}, `);
  });
});

describe('hostTarget', () => {
  test.each([
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['win32', 'x64', 'windows-x64'],
    ['win32', 'arm64', 'windows-arm64'],
  ])('%s/%s -> %s', (platform, arch, want) => {
    expect(hostTarget(platform, arch)).toBe(want as ReturnType<typeof hostTarget>);
  });

  test.each([
    ['darwin', 'arm64'],
    ['linux', 'ia32'],
    ['freebsd', 'x64'],
  ])('%s/%s throws', (platform, arch) => {
    expect(() => hostTarget(platform, arch)).toThrow('no telinha build');
  });
});

describe('embeddedWebDir', () => {
  test('null in dev', () => {
    expect(embeddedWebDir()).toBeNull();
  });

  test('compiled: the dir when it has index.html, else null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'telinha-embedded-'));
    try {
      expect(embeddedWebDir({ compiled: true, dir })).toBeNull();
      writeFileSync(join(dir, 'index.html'), '<!doctype html>');
      expect(embeddedWebDir({ compiled: true, dir })).toBe(dir);
      expect(embeddedWebDir({ compiled: false, dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
