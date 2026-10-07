// Native binaries: Bun.build with `compile` per target (the Solid JSX plugin
// and the built page embedded), then the release archives and SHA256SUMS. Also
// packs our Caddy build (the Dockerfile's caddy-export output) as a release archive.
//
//   bun scripts/build-binary.ts [--target <t>...] [--version X.Y.Z] [--out dist-bin] [--smoke]
//   bun scripts/build-binary.ts sums [--out dist-bin]
//   bun scripts/build-binary.ts pack-caddy --target <one target> --from DIR [--out dist-bin]
//
// <t>: linux-x64 | linux-arm64 | windows-x64 | windows-arm64 | linux | windows | host.
// Default: this OS's targets. Windows targets need a Windows host: the version
// resource (ProductName etc.) is only written there. Cross builds need every
// OpenTUI native package: `bun install --os='*' --cpu='*'` first.
import solidPlugin from '@opentui/solid/bun-plugin';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeTarGz, writeZip, type Entry } from '../server/src/archive.ts';
import { caddyAssetName } from '../server/src/releasetag.ts';
import { TARGETS, hostTarget, type Target } from '../server/src/version.ts';

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
const exeName = (t: Target) => (isWindows(t) ? 'telinha.exe' : 'telinha');
// Linux gets tar.gz: minimal Debian/Alpine have tar but no unzip.
export const assetName = (t: Target) => `telinha-${t}.${isWindows(t) ? 'zip' : 'tar.gz'}`;
/** Our Caddy for a target, named by releasetag.ts so the fetcher and this packer agree. */
export const caddyAsset = (t: Target) => caddyAssetName(isWindows(t) ? 'windows' : 'linux', t.endsWith('-arm64') ? 'arm64' : 'amd64');
// The binary archives; the sums also cover the caddy archives, the Docker
// bundle and the image digest when they sit next to them (the release job puts
// them there): every download is verified the way the native one verifies a binary.
const ASSETS = new Set(TARGETS.map(assetName));
const CADDY_ASSETS = new Set(TARGETS.map(caddyAsset));
const EXTRA_SUMMED = ['telinha-deploy.tar.gz', 'telinha-image.digest'];

const step = (s: string) => console.log(`\n==> ${s}`);

interface Options {
  mode: 'compile' | 'sums' | 'pack-caddy';
  targets: Target[];
  version: string;
  out: string;
  smoke: boolean;
  /** pack-caddy: the directory holding caddy[.exe]. */
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
  const usage = 'usage: bun scripts/build-binary.ts [--target <t>...] [--version X.Y.Z] [--out DIR] [--smoke]\n'
    + '       bun scripts/build-binary.ts sums [--out DIR]\n'
    + '       bun scripts/build-binary.ts pack-caddy --target <t> --from DIR [--out DIR]';
  let mode: Options['mode'] = 'compile';
  let from: string | undefined;
  let version: string | undefined;
  let out = 'dist-bin';
  let smoke = false;
  const wanted: Target[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value\n${usage}`);
      return v;
    };
    if ((a === 'sums' || a === 'pack-caddy') && i === 0) mode = a;
    else if (a === '--target' && mode !== 'sums') wanted.push(...expand(value(), platform));
    else if (a === '--version' && mode === 'compile') version = value();
    else if (a === '--out') out = value();
    else if (a === '--smoke' && mode === 'compile') smoke = true;
    else if (a === '--from' && mode === 'pack-caddy') from = value();
    else throw new Error(`unknown argument ${a}\n${usage}`);
  }
  if (mode === 'pack-caddy') {
    // Packing only copies bytes, so any host packs any target.
    const targets = [...new Set(wanted)];
    if (targets.length !== 1 || !from) throw new Error(`pack-caddy needs one --target and --from\n${usage}`);
    return { mode, targets, version: '', out: resolve(ROOT, out), smoke: false, from: resolve(from) };
  }
  // Other hosts (macOS included) can still cross-compile the Linux targets.
  const targets = TARGETS.filter((t) => (wanted.length ? wanted.includes(t) : isWindows(t) === (platform === 'win32')));
  if (platform !== 'win32' && targets.some(isWindows)) {
    throw new Error('compile Windows targets on Windows: Bun cannot write the version resource when cross-compiling');
  }
  version ??= (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`--version must look like 1.2.3 or 1.2.3-rc.1, got ${version}`);
  return { mode, targets, version, out: resolve(ROOT, out), smoke };
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
          title: 'Telinha', publisher: 'sombraSoft', version: `${o.version.split('-')[0]!}.0`,
          description: 'Telinha screen share server', copyright: 'MIT',
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

async function pack(t: Target, exe: string, out: string): Promise<string> {
  const entries: Entry[] = [
    { path: exeName(t), mode: 0o755, data: await Bun.file(exe).bytes() },
    { path: 'LICENSE', mode: 0o644, data: await Bun.file(join(ROOT, 'LICENSE')).bytes() },
  ];
  const file = join(out, assetName(t));
  await Bun.write(file, isWindows(t) ? writeZip(entries) : writeTarGz(entries));
  console.log(`${file} (${mb(statSync(file).size)}; ${exeName(t)} ${mb(statSync(exe).size)})`);
  return file;
}

/** `sha256sum -c` format: "<hex>  <name>", sorted by name. */
async function writeSums(out: string, names: string[]): Promise<string> {
  const lines: string[] = [];
  for (const name of [...names].sort()) {
    const hex = new Bun.CryptoHasher('sha256').update(await Bun.file(join(out, name)).bytes()).digest('hex');
    lines.push(`${hex}  ${name}`);
  }
  const file = join(out, 'SHA256SUMS');
  await Bun.write(file, lines.map((l) => `${l}\n`).join(''));
  console.log(`${file}\n${lines.join('\n')}`);
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
  if (line !== want && !line.startsWith(`${want} `)) throw new Error(`--version printed "${line}", want "${want} (...)"`);

  step(`smoke: TELINHA_SMOKE_TUI=1 ${exe} --version`);
  const tui = Bun.spawnSync([exe, '--version'], {
    cwd: o.out, env: { ...process.env, TELINHA_SMOKE_TUI: '1' }, stdout: 'pipe', stderr: 'inherit', timeout: 60_000,
  });
  const frame = tui.stdout.toString().trim();
  console.log(frame);
  if (tui.exitCode !== 0 || !frame.includes('count 1')) throw new Error(`the TUI smoke failed (exit ${tui.exitCode ?? tui.signalCode})`);

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
  const name = isWindows(t) ? 'caddy.exe' : 'caddy';
  const exe = join(from, name);
  if (!existsSync(exe)) throw new Error(`no ${name} in ${from}`);
  await mkdir(out, { recursive: true });
  const file = join(out, caddyAsset(t));
  const entries: Entry[] = [{ path: name, mode: 0o755, data: await Bun.file(exe).bytes() }];
  await Bun.write(file, isWindows(t) ? writeZip(entries) : writeTarGz(entries));
  console.log(file);
  return file;
}

async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  if (o.mode === 'pack-caddy') {
    await packCaddy(o.targets[0]!, o.from!, o.out);
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
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('web/dist/index.html missing: run bun run build first');
  await mkdir(o.out, { recursive: true });
  const commit = shortCommit();
  const assets: string[] = [];
  for (const t of o.targets) {
    const exe = await compile(t, o, commit);
    await pack(t, exe, o.out);
    assets.push(assetName(t));
  }
  step('SHA256SUMS');
  await writeSums(o.out, assets);
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
