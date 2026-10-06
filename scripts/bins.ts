// Downloads the pinned child binaries (LiveKit, Caddy, cloudflared) listed in
// versions.json, verifying each asset's sha256 before anything is extracted.
// Used by dev/E2E, the Docker build and (phase 2) `telinha setup`. Runs in the
// Alpine Bun image too (busybox tar, no bash), so it imports nothing from server/.
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = ['livekit', 'caddy', 'cloudflared'] as const;
export type Tool = (typeof TOOLS)[number];
export type Os = 'linux' | 'windows';
export type Arch = 'amd64' | 'arm64';
export const PLATFORMS = ['linux-amd64', 'linux-arm64', 'windows-amd64'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Versions = Record<Tool, { version: string; sha256: Record<Platform, string> }>;
export type Spec = { url: string; asset: string; archive: 'tar.gz' | 'zip' | null; member: string };

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const VERSIONS_FILE = join(ROOT, 'versions.json');

const GH = 'https://github.com';

// Data-driven so phase 2 can point a tool at another source (Caddy -> our CI asset).
// `member` is the file inside the archive (or the saved name for a raw binary).
export function assetSpec(tool: Tool, version: string, os: Os, arch: Arch): Spec {
  const exe = os === 'windows' ? '.exe' : '';
  const archive = os === 'windows' ? 'zip' : 'tar.gz';
  switch (tool) {
    case 'livekit': {
      const asset = `livekit_${version}_${os}_${arch}.${archive}`;
      return { url: `${GH}/livekit/livekit/releases/download/v${version}/${asset}`, asset, archive, member: `livekit-server${exe}` };
    }
    case 'caddy': {
      const asset = `caddy_${version}_${os}_${arch}.${archive}`;
      return { url: `${GH}/caddyserver/caddy/releases/download/v${version}/${asset}`, asset, archive, member: `caddy${exe}` };
    }
    case 'cloudflared': {
      const asset = `cloudflared-${os}-${arch}${exe}`;
      return { url: `${GH}/cloudflare/cloudflared/releases/download/${version}/${asset}`, asset, archive: null, member: `cloudflared${exe}` };
    }
  }
}

export async function loadVersions(): Promise<Versions> {
  return (await Bun.file(VERSIONS_FILE).json()) as Versions;
}

export async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

function hostOs(): Os {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`unsupported host ${process.platform}; pass --os and --arch`);
}

function hostArch(): Arch {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  throw new Error(`unsupported host arch ${process.arch}; pass --os and --arch`);
}

async function extract(archive: 'tar.gz' | 'zip', file: string, cwd: string): Promise<void> {
  let cmd: string[];
  if (process.platform === 'win32') {
    // bsdtar reads .zip and .tar.gz. Call it by full path: Git for Windows puts a
    // GNU tar first on PATH that handles neither zip nor C:\ paths.
    cmd = [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), '-xf', file];
  } else if (archive === 'zip') {
    cmd = ['unzip', '-oq', file];
  } else {
    cmd = ['tar', '-xzf', file];
  }
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited with ${code}`);
}

export type EnsureOptions = {
  os: Os;
  arch: Arch;
  outDir: string;
  versions?: Versions;
  log?: (msg: string) => void;
};

export async function ensureBinaries(names: Tool[], o: EnsureOptions): Promise<Record<Tool, string>> {
  const versions = o.versions ?? (await loadVersions());
  const log = o.log ?? ((m: string) => console.log(m));
  const platform = `${o.os}-${o.arch}` as Platform;
  if (!PLATFORMS.includes(platform)) throw new Error(`no binaries for ${platform}`);
  await mkdir(o.outDir, { recursive: true });

  const out = {} as Record<Tool, string>;
  for (const name of names) {
    const { version, sha256: hashes } = versions[name];
    const spec = assetSpec(name, version, o.os, o.arch);
    const bin = join(o.outDir, spec.member);
    // Sidecar records which version `bin` is, so a pin bump re-downloads.
    const sidecar = join(o.outDir, `${name}.version`);
    out[name] = bin;
    if ((await Bun.file(bin).exists()) && (await Bun.file(sidecar).exists()) && (await Bun.file(sidecar).text()).trim() === version) {
      log(`[bins] ${name} ${version} already present`);
      continue;
    }

    const expected = hashes[platform];
    if (!expected) throw new Error(`${name}: no sha256 for ${platform} in versions.json (run: bun scripts/versions.ts refresh)`);
    log(`[bins] downloading ${spec.asset}`);
    const data = await download(spec.url);
    const actual = sha256(data);
    // Verify before touching the disk so a bad download never gets extracted.
    if (actual !== expected) throw new Error(`${spec.asset}: sha256 ${actual}, expected ${expected}`);

    await rm(sidecar, { force: true });
    if (spec.archive === null) {
      await Bun.write(bin, data);
    } else {
      // Extract into a scratch dir: archives carry LICENSE/README we don't want in outDir.
      const tmp = join(o.outDir, `.tmp-${name}`);
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      try {
        await Bun.write(join(tmp, spec.asset), data);
        await extract(spec.archive, spec.asset, tmp);
        const extracted = join(tmp, spec.member);
        if (!(await Bun.file(extracted).exists())) throw new Error(`${spec.asset} did not contain ${spec.member}`);
        await rm(bin, { force: true });
        await rename(extracted, bin);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    }
    if (o.os === 'linux') await chmod(bin, 0o755);
    await Bun.write(sidecar, `${version}\n`); // last, so an interrupted run retries
  }
  return out;
}

function parseArgs(argv: string[]) {
  let os: Os = hostOs();
  let arch: Arch = hostArch();
  let outDir = process.env.BIN_DIR || join(ROOT, '.cache', 'telinha', 'bin');
  const names: Tool[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
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
      outDir = value();
    } else if ((TOOLS as readonly string[]).includes(a)) {
      names.push(a as Tool);
    } else {
      throw new Error(`unknown argument ${a}\nusage: bun scripts/bins.ts [--os linux|windows] [--arch amd64|arm64] [--out DIR] [${TOOLS.join(' ')}]`);
    }
  }
  return { os, arch, outDir, names: names.length ? names : [...TOOLS] };
}

if (import.meta.main) {
  try {
    const { names, ...o } = parseArgs(process.argv.slice(2));
    const paths = await ensureBinaries(names, o);
    for (const p of Object.values(paths)) console.log(p);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
