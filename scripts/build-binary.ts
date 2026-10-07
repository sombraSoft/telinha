// Native binaries: Bun.build with `compile` per target (the Solid JSX plugin
// and the built page embedded), then the release archives and SHA256SUMS. The
// Windows zips also carry the tray icon (telinha-tray.exe, built by dotnet).
// Also packs our Caddy build (the Dockerfile's caddy-export output) as a release archive.
//
//   bun scripts/build-binary.ts [--target <t>...] [--version X.Y.Z] [--out dist-bin] [--smoke] [--tray PATH] [--no-pack]
//   bun scripts/build-binary.ts pack --target <t>... --from DIR [--tray PATH] [--out dist-bin]
//   bun scripts/build-binary.ts sums [--out dist-bin]
//   bun scripts/build-binary.ts pack-caddy --target <one target> --from DIR [--out dist-bin]
//
// <t>: linux-x64 | linux-arm64 | windows-x64 | windows-arm64 | linux | windows | host.
// Default: this OS's targets. Windows targets need a Windows host: the version
// resource (ProductName etc.) is only written there. Cross builds need every
// OpenTUI native package: `bun install --os='*' --cpu='*'` first.
// --no-pack compiles only (no archives, no sums). `pack` archives binaries built
// earlier (the release signs them in between): DIR/<target>/telinha[.exe] and,
// for Windows, --tray else DIR/tray/telinha-tray.exe.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import solidPlugin from '@opentui/solid/bun-plugin';
import { type Entry, writeArchive } from '../server/src/archive.ts';
import {
  archiveContents,
  archiveFiles,
  assetName,
  caddyAssetName,
  caddyExeName,
  exeName,
  formatSums,
  SUMS,
} from '../server/src/release.ts';
import { hostTarget, TARGETS, type Target } from '../server/src/version.ts';

const ROOT = resolve(import.meta.dir, '..');

// x64 ships the baseline builds only: the default ones need AVX2 and die with
// "Illegal instruction" on older or low-end home servers.
const BUN_TARGET: Record<Target, Bun.Build.CompileTarget> = {
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64-baseline',
  'windows-arm64': 'bun-windows-arm64',
};

// Binary sizes before the terminal UI landed; --smoke fails past baseline +
// SIZE_MARGIN, which catches Babel or a second copy of something big getting bundled.
const SIZE_BASELINE: Record<Target, number> = {
  'linux-x64': 83_248_608,
  'linux-arm64': 83_216_680,
  'windows-x64': 88_020_992,
  'windows-arm64': 79_513_088,
};
const SIZE_MARGIN = 20_000_000;
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

const isWindows = (t: Target) => t.startsWith('windows-');
// Every name comes from release.ts, so the fetchers and this packer agree.
// The binary archives; the sums also cover the caddy archives, the Docker
// bundle and the image digest when they sit next to them (the release job puts
// them there): every download is verified the way the native one verifies a binary.
const ASSETS = new Set(TARGETS.map(assetName));
const CADDY_ASSETS = new Set(TARGETS.map(caddyAssetName));
const EXTRA_SUMMED = ['telinha-deploy.tar.gz', 'telinha-image.digest'];

const step = (s: string) => console.log(`\n==> ${s}`);

export interface Options {
  mode: 'compile' | 'pack' | 'sums' | 'pack-caddy';
  targets: Target[];
  version: string;
  out: string;
  smoke: boolean;
  /** compile: write the archives and SHA256SUMS (off with --no-pack). */
  pack: boolean;
  /** compile, pack: the telinha-tray.exe for the Windows zips. */
  tray?: string;
  /** pack: the compile output (DIR/<target>/...); pack-caddy: the directory holding caddy[.exe]. */
  from?: string;
}

function expand(t: string, platform: string): Target[] {
  if (t === 'host') return [hostTarget(platform)];
  if (t === 'linux') return ['linux-x64', 'linux-arm64'];
  if (t === 'windows') return ['windows-x64', 'windows-arm64'];
  if ((TARGETS as readonly string[]).includes(t)) return [t as Target];
  throw new Error(`unknown target ${t} (want ${[...TARGETS, 'linux', 'windows', 'host'].join(', ')})`);
}

export function parseArgs(argv: string[], platform: string = process.platform): Options {
  const usage =
    'usage: bun scripts/build-binary.ts [--target <t>...] [--version X.Y.Z] [--out DIR] [--smoke] [--tray PATH] [--no-pack]\n' +
    '       bun scripts/build-binary.ts pack --target <t>... --from DIR [--tray PATH] [--out DIR]\n' +
    '       bun scripts/build-binary.ts sums [--out DIR]\n' +
    '       bun scripts/build-binary.ts pack-caddy --target <t> --from DIR [--out DIR]';
  let mode: Options['mode'] = 'compile';
  let from: string | undefined;
  let tray: string | undefined;
  let version: string | undefined;
  let out = 'dist-bin';
  let smoke = false;
  let pack = true;
  const wanted: Target[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value\n${usage}`);
      return v;
    };
    if ((a === 'pack' || a === 'sums' || a === 'pack-caddy') && i === 0) mode = a;
    else if (a === '--target' && mode !== 'sums') wanted.push(...expand(value(), platform));
    else if (a === '--version' && mode === 'compile') version = value();
    else if (a === '--out') out = value();
    else if (a === '--smoke' && mode === 'compile') smoke = true;
    else if (a === '--no-pack' && mode === 'compile') pack = false;
    else if (a === '--tray' && (mode === 'compile' || mode === 'pack')) tray = resolve(value());
    else if (a === '--from' && (mode === 'pack' || mode === 'pack-caddy')) from = value();
    else throw new Error(`unknown argument ${a}\n${usage}`);
  }
  if (mode === 'pack-caddy') {
    // Packing only copies bytes, so any host packs any target.
    const targets = [...new Set(wanted)];
    if (targets.length !== 1 || !from) throw new Error(`pack-caddy needs one --target and --from\n${usage}`);
    return { mode, targets, version: '', out: resolve(ROOT, out), smoke: false, pack: true, from: resolve(from) };
  }
  if (mode === 'pack') {
    // Same here: the release packs exes compiled (and signed) by other jobs.
    const targets = TARGETS.filter((t) => wanted.includes(t));
    if (!targets.length || !from) throw new Error(`pack needs --target and --from\n${usage}`);
    return { mode, targets, version: '', out: resolve(ROOT, out), smoke: false, pack: true, tray, from: resolve(from) };
  }
  if (tray && !pack) throw new Error(`--tray goes into the zips, and --no-pack writes none\n${usage}`);
  // Other hosts (macOS included) can still cross-compile the Linux targets.
  const targets = TARGETS.filter((t) => (wanted.length ? wanted.includes(t) : isWindows(t) === (platform === 'win32')));
  if (platform !== 'win32' && targets.some(isWindows)) {
    throw new Error('compile Windows targets on Windows: Bun cannot write the version resource when cross-compiling');
  }
  version ??= (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`--version must look like 1.2.3 or 1.2.3-rc.1, got ${version}`);
  return { mode, targets, version, out: resolve(ROOT, out), smoke, pack, tray };
}

/** Where `pack` reads a target's binaries: compile's layout under DIR, the tray in DIR/tray unless given. */
export function packSources(t: Target, from: string, tray?: string): { exe: string; tray?: string } {
  const exe = join(from, t, exeName(t));
  const inArchive = archiveContents(t).tray;
  return inArchive ? { exe, tray: tray ?? join(from, 'tray', inArchive) } : { exe };
}

function shortCommit(): string {
  const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, stderr: 'ignore' });
  const sha = r.success ? r.stdout.toString().trim() : '';
  return sha || 'unknown';
}

/** The Bun.build config for one target. The API, not the CLI: only it takes the Solid plugin. */
export function buildConfig(t: Target, o: { version: string; commit: string; outfile: string }): Bun.BuildConfig {
  const define: Record<string, string> = {
    BUILD_VERSION: JSON.stringify(o.version),
    BUILD_COMMIT: JSON.stringify(o.commit),
    BUILD_TARGET: JSON.stringify(t),
  };
  // Keeps only OpenTUI's glibc branch: the Linux binaries are glibc builds (the
  // Alpine image runs the source with OPENTUI_LIBC=musl instead).
  if (!isWindows(t)) define['process.env.OPENTUI_LIBC'] = JSON.stringify('glibc');
  return {
    entrypoints: [join(ROOT, 'server', 'src', 'index.ts')],
    plugins: [solidPlugin],
    minify: true,
    sourcemap: 'none',
    define,
    compile: {
      target: BUN_TARGET[t],
      outfile: o.outfile,
      // Embedded as <virtual root>/dist; embedded.ts looks for it there.
      assets: [join(ROOT, 'web', 'dist')],
      // The binary must never pick up a .env or bunfig.toml from the user's cwd
      // (a project bunfig's preload would even stop it from starting).
      autoloadDotenv: false,
      autoloadBunfig: false,
      // The version resource takes four numbers: 0.7.0-rc.1 -> 0.7.0.0.
      ...(isWindows(t) && {
        windows: {
          title: 'Telinha',
          publisher: 'sombraSoft',
          version: `${o.version.split('-')[0]!}.0`,
          description: 'Telinha screen share server',
          copyright: 'MIT',
        },
      }),
    },
  };
}

async function compile(t: Target, o: Options, commit: string): Promise<string> {
  const outfile = join(o.out, t, exeName(t));
  await rm(join(o.out, t), { recursive: true, force: true });
  step(`compile ${t} (${BUN_TARGET[t]}, ${o.version}, ${commit})`);
  // throw: false so the bundler's own messages are printed, not just "Bundle failed".
  const r = await Bun.build({ ...buildConfig(t, { version: o.version, commit, outfile }), throw: false });
  for (const log of r.logs) console.log(String(log));
  if (!r.success || !existsSync(outfile)) throw new Error(`bun build failed for ${t}`);
  return outfile;
}

async function pack(t: Target, files: { exe: string; tray?: string }, out: string): Promise<string> {
  const entries: Entry[] = [];
  for (const f of archiveFiles(t, { ...files, license: join(ROOT, 'LICENSE') })) {
    if (!existsSync(f.source)) throw new Error(`no ${f.path} at ${f.source}`);
    entries.push({ path: f.path, mode: f.mode, data: await Bun.file(f.source).bytes() });
  }
  const file = join(out, assetName(t));
  await Bun.write(file, writeArchive(t, entries));
  console.log(`${file} (${mb(statSync(file).size)}; ${exeName(t)} ${mb(statSync(files.exe).size)})`);
  return file;
}

async function writeSums(out: string, names: string[]): Promise<string> {
  const sums: Record<string, string> = {};
  for (const name of names)
    sums[name] = new Bun.CryptoHasher('sha256').update(await Bun.file(join(out, name)).bytes()).digest('hex');
  const file = join(out, SUMS);
  const text = formatSums(sums);
  await Bun.write(file, text);
  console.log(`${file}\n${text.trimEnd()}`);
  return file;
}

async function smoke(o: Options): Promise<void> {
  const host = hostTarget();
  const exe = join(o.out, host, exeName(host));
  step(`smoke: ${exe} --version`);
  if (!existsSync(exe)) throw new Error(`no ${host} binary in ${o.out}: build --target host first`);
  const r = Bun.spawnSync([exe, '--version'], { cwd: o.out, stdout: 'pipe', stderr: 'inherit', timeout: 60_000 });
  const line = r.stdout.toString().trim();
  console.log(line);
  if (r.exitCode !== 0) throw new Error(`--version exited with ${r.exitCode ?? r.signalCode}`);
  const want = `telinha ${o.version}`;
  if (line !== want && !line.startsWith(`${want} `))
    throw new Error(`--version printed "${line}", want "${want} (...)"`);

  step(`smoke: TELINHA_SMOKE_TUI=1 ${exe} --version`);
  const tui = Bun.spawnSync([exe, '--version'], {
    cwd: o.out,
    env: { ...process.env, TELINHA_SMOKE_TUI: '1' },
    stdout: 'pipe',
    stderr: 'inherit',
    timeout: 60_000,
  });
  const frame = tui.stdout.toString().trim();
  console.log(frame);
  if (tui.exitCode !== 0 || !frame.includes('count 1'))
    throw new Error(`the TUI smoke failed (exit ${tui.exitCode ?? tui.signalCode})`);

  step('smoke: binary size and contents');
  for (const t of o.targets) {
    const bin = join(o.out, t, exeName(t));
    const size = statSync(bin).size;
    const limit = SIZE_BASELINE[t] + SIZE_MARGIN;
    console.log(`${t}: ${mb(size)} (limit ${mb(limit)})`);
    if (size > limit) throw new Error(`${t} is ${mb(size)}, over ${mb(limit)}: something big got bundled`);
    // The Solid plugin transforms at build time; Babel in the binary means the runtime preload got bundled.
    if (Buffer.from(await Bun.file(bin).arrayBuffer()).includes('@babel/core')) {
      throw new Error(`${t} contains @babel/core: Babel must not be bundled`);
    }
  }
}

/** The buildx export's caddy[.exe] as caddy-<target>.tar.gz|.zip, the one file inside named like the binary. */
async function packCaddy(t: Target, from: string, out: string): Promise<string> {
  const name = caddyExeName(t);
  const exe = join(from, name);
  if (!existsSync(exe)) throw new Error(`no ${name} in ${from}`);
  await mkdir(out, { recursive: true });
  const file = join(out, caddyAssetName(t));
  await Bun.write(file, writeArchive(t, [{ path: name, mode: 0o755, data: await Bun.file(exe).bytes() }]));
  console.log(file);
  return file;
}

async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  if (o.mode === 'pack-caddy') {
    await packCaddy(o.targets[0]!, o.from!, o.out);
    return;
  }
  if (o.mode === 'pack') {
    await mkdir(o.out, { recursive: true });
    const assets: string[] = [];
    for (const t of o.targets) {
      step(`pack ${t}`);
      await pack(t, packSources(t, o.from!, o.tray), o.out);
      assets.push(assetName(t));
    }
    step('SHA256SUMS');
    await writeSums(o.out, assets);
    step('ok');
    return;
  }
  if (o.mode === 'sums') {
    const present = existsSync(o.out) ? readdirSync(o.out) : [];
    const names = present.filter((n) => ASSETS.has(n));
    if (!names.length) throw new Error(`no ${[...ASSETS].join(', ')} in ${o.out}`);
    // The caddy archives are optional: a local run may have built none.
    await writeSums(o.out, [...names, ...present.filter((n) => CADDY_ASSETS.has(n) || EXTRA_SUMMED.includes(n))]);
    return;
  }
  // Whatever is in web/dist gets embedded; without the page the binary is useless.
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html')))
    throw new Error('web/dist/index.html missing: run bun run build first');
  if (o.tray && !existsSync(o.tray)) throw new Error(`no telinha-tray.exe at ${o.tray}`);
  if (o.pack && !o.tray && o.targets.some(isWindows))
    console.warn('warning: windows zips without telinha-tray.exe (no --tray)');
  await mkdir(o.out, { recursive: true });
  const commit = shortCommit();
  const assets: string[] = [];
  for (const t of o.targets) {
    const exe = await compile(t, o, commit);
    if (!o.pack) continue;
    await pack(t, { exe, tray: o.tray }, o.out);
    assets.push(assetName(t));
  }
  if (o.pack) {
    step('SHA256SUMS');
    await writeSums(o.out, assets);
  }
  if (o.smoke) await smoke(o);
  step('ok');
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    console.error(`\nfailed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
