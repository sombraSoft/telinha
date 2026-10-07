// `bun run caddy`: builds Telinha's Caddy (upstream Caddy plus the modules in
// versions.json) with xcaddy. Needs Go on PATH. The Docker caddy-build stage
// runs it with only versions.json and this file copied in, so it imports
// nothing but node:* builtins.
//
//   bun scripts/caddy-build.ts [--out DIR] [--os linux|windows] [--arch amd64|arm64] [--versions versions.json]
//
// --out defaults to where `bun run bins` puts the helper binaries (BIN_DIR, else
// .cache/telinha/bin), so a bare `bun run caddy` leaves caddy where a dev run finds it.
import { mkdir } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

type Os = 'linux' | 'windows';
type Arch = 'amd64' | 'arm64';
type CaddyBuild = { version: string; xcaddy: string; modules: Record<string, string> };

// What the release needs from this build; list-modules must show both.
const REQUIRED_MODULES = ['dns.providers.duckdns', 'layer4'];

const USAGE = 'usage: bun scripts/caddy-build.ts [--out DIR] [--os linux|windows] [--arch amd64|arm64] [--versions versions.json]';

const hostOs = (): Os | null => (process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'windows' : null);
const hostArch = (): Arch | null => (process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null);

function parseArgs(argv: string[]) {
  let os: Os | undefined;
  let arch: Arch | undefined;
  const root = resolve(import.meta.dir, '..');
  let out = resolve(process.env.BIN_DIR || join(root, '.cache', 'telinha', 'bin'));
  let versions = join(root, 'versions.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === '--os') {
      const v = value();
      if (v !== 'linux' && v !== 'windows') throw new Error(`--os must be linux or windows, got ${v}`);
      os = v;
    } else if (a === '--arch') {
      const v = value();
      if (v !== 'amd64' && v !== 'arm64') throw new Error(`--arch must be amd64 or arm64, got ${v}`);
      arch = v;
    } else if (a === '--out') {
      out = resolve(value());
    } else if (a === '--versions') {
      versions = resolve(value());
    } else {
      throw new Error(`unknown argument ${a}\n${USAGE}`);
    }
  }
  os ??= hostOs() ?? undefined;
  arch ??= hostArch() ?? undefined;
  if (!os || !arch) throw new Error(`unsupported host ${process.platform}/${process.arch}: pass --os and --arch`);
  return { os, arch, out, versions };
}

async function readRecipe(file: string): Promise<CaddyBuild> {
  const c = ((await Bun.file(file).json()) as { caddy?: Partial<CaddyBuild> }).caddy;
  const modules = c?.modules && typeof c.modules === 'object' ? Object.entries(c.modules) : [];
  if (
    typeof c?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(c.version)
    || typeof c.xcaddy !== 'string' || !c.xcaddy.startsWith('v')
    || !modules.length || modules.some(([, tag]) => typeof tag !== 'string' || !tag.startsWith('v'))
  ) {
    throw new Error(`${file}: caddy needs version (x.y.z), xcaddy (vX.Y.Z) and modules ({ path: vX.Y.Z })`);
  }
  return c as CaddyBuild;
}

/** Runs a command with output passed through, so a failure shows Go's own message. */
async function run(cmd: string[], env: Record<string, string | undefined>): Promise<void> {
  console.log(`$ ${cmd.join(' ')}`);
  const p = Bun.spawn(cmd, { env, stdout: 'inherit', stderr: 'inherit' });
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
}

function capture(cmd: string[], env?: Record<string, string | undefined>): string {
  const r = Bun.spawnSync(cmd, { env, stdout: 'pipe', stderr: 'pipe' });
  if (!r.success) throw new Error(`${cmd.join(' ')} failed (${r.exitCode ?? r.signalCode}): ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Where `go install` puts binaries: GOBIN, else the first GOPATH entry's bin. */
function goBin(env: Record<string, string | undefined>): string {
  const [gobin = '', gopath = ''] = capture(['go', 'env', 'GOBIN', 'GOPATH'], env).split(/\r?\n/).map((l) => l.trim());
  if (gobin) return gobin;
  const first = gopath.split(delimiter).find(Boolean);
  if (!first) throw new Error('go env reports neither GOBIN nor GOPATH');
  return join(first, 'bin');
}

async function main(argv: string[]): Promise<void> {
  const o = parseArgs(argv);
  const recipe = await readRecipe(o.versions);
  // Same toolchain settings for both commands. The official golang images pin
  // GOTOOLCHAIN=local; auto lets a Caddy whose go directive is newer than the
  // image fetch the toolchain it needs (checked against Go's checksum database).
  const toolEnv: Record<string, string | undefined> = { ...process.env, CGO_ENABLED: '0', GOFLAGS: '-trimpath', GOTOOLCHAIN: 'auto' };
  // xcaddy runs here, so it is built for this host whatever GOOS/GOARCH say.
  delete toolEnv.GOOS;
  delete toolEnv.GOARCH;
  await run(['go', 'install', `github.com/caddyserver/xcaddy/cmd/xcaddy@${recipe.xcaddy}`], toolEnv);
  const xcaddy = join(goBin(toolEnv), process.platform === 'win32' ? 'xcaddy.exe' : 'xcaddy');

  await mkdir(o.out, { recursive: true });
  const exe = join(o.out, o.os === 'windows' ? 'caddy.exe' : 'caddy');
  const withs = Object.entries(recipe.modules).flatMap(([mod, tag]) => ['--with', `${mod}@${tag}`]);
  // xcaddy passes GOOS/GOARCH through to go build: that is the cross-compile.
  await run([xcaddy, 'build', `v${recipe.version}`, ...withs, '--output', exe], { ...toolEnv, GOOS: o.os, GOARCH: o.arch });
  console.log(exe);

  if (o.os !== hostOs() || o.arch !== hostArch()) {
    console.log(`[caddy] cross-build for ${o.os}/${o.arch}: version and module checks skipped`);
    return;
  }
  // Go's minimal version selection raises Caddy when a module requires a newer
  // one, silently: the pin in versions.json must stay the truth.
  const got = capture([exe, 'version']).trim().split(/\s+/)[0];
  if (got !== `v${recipe.version}`) throw new Error(`built caddy is ${got}, versions.json says v${recipe.version}: a module requires a newer Caddy`);
  const listed = new Set(capture([exe, 'list-modules']).split(/\r?\n/).map((l) => l.trim()));
  const missing = REQUIRED_MODULES.filter((m) => !listed.has(m));
  if (missing.length) throw new Error(`built caddy lacks ${missing.join(', ')}`);
  console.log(`[caddy] ${got} with ${REQUIRED_MODULES.join(', ')}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (e) {
    console.error(`\nfailed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
