// Files the release and the installers hard-code, pinned against release.ts.
// They live outside server/, so these tests stay out of the image's test run.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ASIDE_RE, SUMS, TRAY_DIST, TRAY_EXE, archiveContents, asideBase, assetName, caddyAssetName, exeName, formatSums, newExeName,
} from '../server/src/release.ts';
import { TARGETS } from '../server/src/version.ts';

const ROOT = resolve(import.meta.dir, '..');
const install = (name: string) => readFileSync(join(ROOT, 'deploy', name), 'utf8');

describe('release.yml', () => {
  test('release.yml uploads every asset name', () => {
    const yml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
    const globs = [...yml.matchAll(/^\s*dist-bin\/((?:telinha|caddy)-\*\.(?:tar\.gz|zip))$/gm)].map((m) => m[1]!);
    const match = (name: string) => globs.some((g) => new RegExp(`^${g.replace(/\./g, '\\.').replace('*', '.*')}$`).test(name));
    for (const t of TARGETS) {
      expect(match(assetName(t))).toBe(true);
      expect(match(caddyAssetName(t))).toBe(true);
    }
  });
});

describe('the installers parse SHA256SUMS as release.ts writes it', () => {
  const hex = (c: string) => c.repeat(64);
  const sums = { 'telinha-windows-x64.zip': hex('b'), 'caddy-linux-x64.tar.gz': hex('c'), 'telinha-linux-x64.tar.gz': hex('a') };
  const text = formatSums(sums);

  // The installers' own parsers, taken verbatim from the scripts.
  const awk = /expected=\$\(awk -v f="\$1" '([^']+)' "\$tmp\/SHA256SUMS"\)/.exec(install('install.sh'))?.[1];
  const ps = /^( *)(\$expected = \$null\n.*?\n\1\})$/ms.exec(install('install.ps1'))?.[2];

  test('install.sh and install.ps1 still parse SHA256SUMS the way this test runs them', () => {
    expect(awk).toBe('$2 == f || $2 == "*" f { print $1; exit }');
    expect(ps).toContain("$parts = $line.Trim() -split '\\s+', 2");
    expect(ps).toContain("$parts[1].TrimStart('*') -eq $asset");
    expect(install('install.sh')).toContain(`"$base/${SUMS}"`);
    expect(install('install.ps1')).toContain(`"$base/${SUMS}"`);
  });

  const withMarker = text.replace('  telinha-windows', ' *telinha-windows');
  const run = (cmd: (file: string) => string[], script?: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'telinha-sums-'));
    try {
      writeFileSync(join(dir, SUMS), withMarker);
      if (script) writeFileSync(join(dir, 'check.ps1'), script);
      const r = Bun.spawnSync(cmd(join(dir, SUMS)), { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      expect(r.stderr.toString()).toBe('');
      return r.stdout.toString().trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const awkBin = Bun.which('awk');
  test.skipIf(!awkBin)('install.sh (awk)', () => {
    for (const [name, want] of Object.entries(sums)) expect(run((file) => [awkBin!, '-v', `f=${name}`, awk!, file])).toBe(want);
  });

  const pwsh = Bun.which('pwsh') ?? Bun.which('powershell');
  test.skipIf(!pwsh)('install.ps1 (PowerShell)', () => {
    const names = Object.keys(sums);
    const script = `$sums = Join-Path $PSScriptRoot '${SUMS}'\nforeach ($asset in @(${names.map((n) => `'${n}'`).join(', ')})) {\n${ps}\nWrite-Output $expected\n}\n`;
    expect(run(() => [pwsh!, '-NoProfile', '-NonInteractive', '-File', 'check.ps1'], script).split(/\r?\n/)).toEqual(names.map((n) => sums[n as keyof typeof sums]));
  }, 30_000);
});

// The shell installers cannot import release.ts: what they hard-code is pinned here.
describe('installers', () => {
  test('install.sh: the Linux archive and the program in it', () => {
    const sh = install('install.sh');
    const asset = /^asset=(\S+)$/m.exec(sh)?.[1];
    expect(sh).toContain('x86_64 | amd64) arch=x64 ;;');
    expect(sh).toContain('\tarch=arm64\n');
    for (const arch of ['x64', 'arm64'] as const) expect(asset?.replace('$arch', arch)).toBe(assetName(`linux-${arch}`));
    expect(sh).toContain(`tar -xzf "$tmp/$asset" -C "$tmp/x" ${archiveContents('linux-x64').exe}\n`);
  });

  test('install.ps1: the Windows archive, what it unpacks and the bin names the updater uses', () => {
    const ps1 = install('install.ps1');
    const asset = /^\s*\$asset = "(\S+)"$/m.exec(ps1)?.[1];
    expect(ps1).toContain("'ARM64' { $arch = 'arm64' }");
    expect(ps1).toContain("'AMD64' { $arch = 'x64' }");
    for (const arch of ['x64', 'arm64'] as const) expect(asset?.replace('$arch', arch)).toBe(assetName(`windows-${arch}`));
    const inZip = archiveContents('windows-x64');
    expect(ps1).toContain(`Join-Path $out '${inZip.exe}'`);
    expect(ps1).toContain(`Join-Path $out '${inZip.tray}'`);
    expect(ps1).toContain(`Join-Path $bin '${exeName('windows')}'`);
    expect(ps1).toContain(`Join-Path $bin '${newExeName('windows')}'`);
    expect(ps1).toContain(`Join-Path $bin '${TRAY_EXE}'`);
    expect(ps1).toContain(`Join-Path $bin '${TRAY_DIST}'`);
  });

  test('install.ps1 sets replaced files aside where the updater sweeps them', () => {
    const aside = [...install('install.ps1').matchAll(/Join-Path \$bin "([^"]+)"/g)].map((m) => m[1]!);
    expect(aside).toEqual([`${asideBase('telinha', 'old', 'manual-$stamp')}.exe`, `${asideBase('telinha-tray', 'old', 'manual-$stamp')}.exe`]);
    for (const name of aside) expect(ASIDE_RE.test(name)).toBe(true);
  });
});
