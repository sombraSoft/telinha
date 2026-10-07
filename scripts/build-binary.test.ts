import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archiveFiles, buildConfig, packSources, parseArgs } from './build-binary.ts';

const ROOT = resolve(import.meta.dir, '..');
const opts = { version: '0.7.0-rc.1', commit: 'abc1234', outfile: '/tmp/out/telinha' };

describe('buildConfig', () => {
  test('Solid plugin, minified, no sourcemap, the server entry', () => {
    const c = buildConfig('linux-x64', opts);
    expect(c.plugins?.map((p) => p.name)).toHaveLength(1);
    expect(c.minify).toBe(true);
    expect(c.sourcemap).toBe('none');
    expect(c.entrypoints).toEqual([join(ROOT, 'server', 'src', 'index.ts')]);
  });

  test('BUILD_* defines are JSON strings', () => {
    const d = buildConfig('windows-arm64', opts).define!;
    expect(d.BUILD_VERSION).toBe('"0.7.0-rc.1"');
    expect(d.BUILD_COMMIT).toBe('"abc1234"');
    expect(d.BUILD_TARGET).toBe('"windows-arm64"');
  });

  test('the OpenTUI libc define only on Linux', () => {
    expect(buildConfig('linux-x64', opts).define!['process.env.OPENTUI_LIBC']).toBe('"glibc"');
    expect(buildConfig('linux-arm64', opts).define!['process.env.OPENTUI_LIBC']).toBe('"glibc"');
    expect(buildConfig('windows-x64', opts).define!).not.toHaveProperty(['process.env.OPENTUI_LIBC']);
  });

  test('compile: baseline x64 targets, the page as an asset, no autoload', () => {
    for (const [t, bun] of [
      ['linux-x64', 'bun-linux-x64-baseline'],
      ['linux-arm64', 'bun-linux-arm64'],
      ['windows-x64', 'bun-windows-x64-baseline'],
      ['windows-arm64', 'bun-windows-arm64'],
    ] as const) {
      const c = buildConfig(t, opts).compile as Bun.CompileBuildOptions;
      expect(c.target).toBe(bun);
      expect(c.outfile).toBe(opts.outfile);
      expect(c.assets).toEqual([join(ROOT, 'web', 'dist')]);
      expect(c.autoloadDotenv).toBe(false);
      expect(c.autoloadBunfig).toBe(false);
    }
  });

  test('the version resource only on Windows, with four numbers', () => {
    expect((buildConfig('linux-x64', opts).compile as Bun.CompileBuildOptions).windows).toBeUndefined();
    expect((buildConfig('windows-x64', opts).compile as Bun.CompileBuildOptions).windows).toEqual({
      title: 'Telinha', publisher: 'sombraSoft', version: '0.7.0.0',
      description: 'Telinha screen share server', copyright: 'MIT',
    });
  });
});

describe('parseArgs', () => {
  test('host target and Windows-host rule', () => {
    expect(parseArgs(['--target', 'host', '--version', '1.2.3'], 'linux').targets).toEqual(['linux-x64']);
    expect(parseArgs(['--target', 'linux-x64', '--version', '1.2.3'], 'win32').targets).toEqual(['linux-x64']);
    expect(() => parseArgs(['--target', 'windows'], 'linux')).toThrow('compile Windows targets on Windows');
  });
});

// The CI pty smokes grep the setup screens out of OpenTUI's raw diff stream. They
// only run on Linux runners, so the filter is exercised here on a captured-like
// sample, taken verbatim from ci.yml so the two cannot drift.
describe('pty smoke filter (ci.yml)', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const blocks = [...ci.matchAll(/^( *)(sed -E .*?tui\.txt \|\| \{ cat -v tui\.out \| tail -c 4000; exit 1; \})$/gms)]
    .map((m) => m[2]!.split('\n').map((l) => l.replace(new RegExp(`^${m[1]}`), '')).join('\n'));
  const sh = Bun.which('sh');

  test('the image and binaries jobs use the same filter', () => {
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toBe(blocks[0]!);
    expect(blocks[0]).toContain("grep -qF 'WherewillTelinharun?' tui.txt");
  });

  const ESC = '\x1b';
  const BEL = '\x07';
  const right = `${ESC}[1C`;
  const sample = (title: string) => [
    `${ESC}[?1049h${ESC}[?25l${ESC}]10;?${ESC}\\${ESC}]11;?${BEL}${ESC}(B${ESC}[2J`,
    `${ESC}[1;1H${ESC}[38;2;137;180;250m${ESC}[1mTelinha${ESC}[0m setup\r\n`,
    `${ESC}]8;;https://telinha.example/docs${ESC}\\docs${ESC}]8;;${ESC}\\\r\n`,
    `${ESC}[4;3H${ESC}[38;5;15m${title}${ESC}[0m${ESC}[K\r\n`,
    `${ESC}[6;3H${ESC}[48;2;30;30;46m> A computer at home${ESC}[0m\r\n`,
  ].join('');

  const run = (raw: string): number => {
    const dir = mkdtempSync(join(tmpdir(), 'telinha-pty-'));
    try {
      writeFileSync(join(dir, 'tui.out'), raw);
      // A file, not `sh -c`: Windows' argv round trip would collapse the filter's backslashes.
      writeFileSync(join(dir, 'check.sh'), `${blocks[0]!}\n`);
      return Bun.spawnSync([sh!, 'check.sh'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' }).exitCode;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test.skipIf(!sh)('finds the title through SGR, OSC 8 and cursor moves in place of spaces', () => {
    expect(run(sample(`Where${right}will${right}${ESC}[38;2;137;180;250mTelinha${ESC}[39m${right}run?`))).toBe(0);
    expect(run(sample('Where will Telinha run?'))).toBe(0);
  });

  test.skipIf(!sh)('fails without the title', () => {
    expect(run(sample(`Where${right}will${right}it${right}run?`))).toBe(1);
  });
});

describe('parseArgs: compile', () => {
  test('defaults: this OS targets, archives on, no tray', () => {
    const o = parseArgs([], 'linux');
    expect(o).toMatchObject({ mode: 'compile', targets: ['linux-x64', 'linux-arm64'], pack: true, smoke: false, out: join(ROOT, 'dist-bin') });
    expect(o.tray).toBeUndefined();
    expect(parseArgs([], 'win32').targets).toEqual(['windows-x64', 'windows-arm64']);
  });

  test('--tray resolves the path, --no-pack turns the archives off', () => {
    const o = parseArgs(['--target', 'windows', '--tray', 'tray/bin/Release/net48/telinha-tray.exe', '--smoke'], 'win32');
    expect(o).toMatchObject({ targets: ['windows-x64', 'windows-arm64'], pack: true, smoke: true, tray: resolve('tray/bin/Release/net48/telinha-tray.exe') });
    const n = parseArgs(['--target', 'windows-x64', '--no-pack', '--version', '1.2.3-rc.1'], 'win32');
    expect(n).toMatchObject({ targets: ['windows-x64'], pack: false, version: '1.2.3-rc.1' });
  });

  test('--tray with --no-pack has nowhere to go', () => {
    expect(() => parseArgs(['--no-pack', '--tray', 'x.exe'], 'win32')).toThrow('--no-pack writes none');
  });

  test('Windows targets only on Windows; values required', () => {
    expect(() => parseArgs(['--target', 'windows'], 'linux')).toThrow('compile Windows targets on Windows');
    expect(() => parseArgs(['--tray'], 'win32')).toThrow('--tray needs a value');
    expect(() => parseArgs(['--version', '1.2'], 'linux')).toThrow('--version must look like');
  });

  test('pack-only flags are refused', () => {
    expect(() => parseArgs(['--from', 'x'], 'linux')).toThrow('unknown argument --from');
  });
});

describe('parseArgs: pack', () => {
  test('any host packs any target', () => {
    const o = parseArgs(['pack', '--target', 'windows', '--from', 'signed', '--out', 'out'], 'linux');
    expect(o).toMatchObject({ mode: 'pack', targets: ['windows-x64', 'windows-arm64'], from: resolve('signed'), out: join(ROOT, 'out') });
    expect(o.tray).toBeUndefined();
    const t = parseArgs(['pack', '--target', 'linux-x64', '--from', 'd', '--tray', 'tray.exe'], 'win32');
    expect(t).toMatchObject({ targets: ['linux-x64'], tray: resolve('tray.exe') });
  });

  test('needs --target and --from', () => {
    expect(() => parseArgs(['pack', '--from', 'd'], 'linux')).toThrow('pack needs --target and --from');
    expect(() => parseArgs(['pack', '--target', 'windows'], 'linux')).toThrow('pack needs --target and --from');
  });

  test('compile-only flags are refused', () => {
    for (const a of ['--smoke', '--no-pack']) {
      expect(() => parseArgs(['pack', '--target', 'linux', '--from', 'd', a], 'linux')).toThrow(`unknown argument ${a}`);
    }
    expect(() => parseArgs(['pack', '--version', '1.2.3'], 'linux')).toThrow('unknown argument --version');
  });

  test('the mode word only counts first', () => {
    expect(() => parseArgs(['--target', 'linux', 'pack'], 'linux')).toThrow('unknown argument pack');
  });

  test('sums and pack-caddy take no tray', () => {
    expect(() => parseArgs(['sums', '--tray', 'x'], 'linux')).toThrow('unknown argument --tray');
    expect(() => parseArgs(['pack-caddy', '--target', 'linux-x64', '--from', 'd', '--tray', 'x'], 'linux')).toThrow('unknown argument --tray');
  });
});

describe('packSources', () => {
  test('compile layout under DIR; the tray from DIR/tray unless given', () => {
    expect(packSources('windows-arm64', 'D')).toEqual({ exe: join('D', 'windows-arm64', 'telinha.exe'), tray: join('D', 'tray', 'telinha-tray.exe') });
    expect(packSources('windows-x64', 'D', 'T.exe')).toEqual({ exe: join('D', 'windows-x64', 'telinha.exe'), tray: 'T.exe' });
    expect(packSources('linux-x64', 'D', 'T.exe')).toEqual({ exe: join('D', 'linux-x64', 'telinha') });
  });
});

describe('archiveFiles', () => {
  const files = { exe: 'E', tray: 'T', license: 'L' };

  test('Windows zips: telinha.exe, telinha-tray.exe, LICENSE', () => {
    expect(archiveFiles('windows-x64', files)).toEqual([
      { path: 'telinha.exe', mode: 0o755, source: 'E' },
      { path: 'telinha-tray.exe', mode: 0o755, source: 'T' },
      { path: 'LICENSE', mode: 0o644, source: 'L' },
    ]);
  });

  test('a Windows zip without a tray, and Linux never carries one', () => {
    expect(archiveFiles('windows-arm64', { exe: 'E', license: 'L' }).map((f) => f.path)).toEqual(['telinha.exe', 'LICENSE']);
    expect(archiveFiles('linux-arm64', files)).toEqual([
      { path: 'telinha', mode: 0o755, source: 'E' },
      { path: 'LICENSE', mode: 0o644, source: 'L' },
    ]);
  });
});
