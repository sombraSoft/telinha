// Downloads the child binaries: LiveKit and cloudflared pinned upstream in
// versions.json (sha256 per asset), Caddy built by us and fetched from a Telinha
// release (verified against that release's SHA256SUMS). Every asset is verified
// before anything is extracted. Used by the native `run`/`setup`, dev/E2E
// (scripts/stack.ts) and the Docker build. The image's bins stage copies only
// this file, archive.ts, version.ts, releasetag.ts and versions.json, so other
// server modules are imported as types only.
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import versionsJson from '../../versions.json' with { type: 'json' };
import { readTarGz, readZip } from './archive.ts';
import type { Config } from './config.ts';
import type { Paths } from './paths.ts';
import { REPO, caddyAssetName, latestReleaseTag, parseSums, releaseAssetUrl } from './releasetag.ts';
import { isCompiled, version } from './version.ts';

export const TOOLS = ['livekit', 'caddy', 'cloudflared'] as const;
export type Tool = (typeof TOOLS)[number];
/** Tools downloaded from upstream with a sha256 per asset in versions.json. */
export type PinnedTool = Exclude<Tool, 'caddy'>;
export type Os = 'linux' | 'windows';
export type Arch = 'amd64' | 'arm64';
export const PLATFORMS = ['linux-amd64', 'linux-arm64', 'windows-amd64', 'windows-arm64'] as const;
export type Platform = (typeof PLATFORMS)[number];
/** sha256 per hash key: a platform whose asset is another platform's (see assetSpec) has no entry of its own. */
export type Pinned = { version: string; sha256: Partial<Record<Platform, string>> };
/** How our Caddy is built (scripts/caddy-build.ts); its hashes live in each release's SHA256SUMS. */
export type CaddyBuild = { version: string; xcaddy: string; modules: Record<string, string> };
export type Versions = { livekit: Pinned; cloudflared: Pinned; caddy: CaddyBuild };
/** The Telinha release a caddy asset comes from, and that release's SHA256SUMS (fetched once, on demand). */
export type CaddyRelease = { tag: string; sums: () => Promise<Record<string, string>> };
export type Spec = {
  url: string;
  asset: string;
  archive: 'tar.gz' | 'zip' | null;
  member: string;
  /** The versions.json sha256 key of `asset`; differs from the requested platform when it falls back to another build. */
  hashKey: Platform;
  /** Where the expected hash comes from: versions.json, or the SHA256SUMS of the release the asset is in. */
  verify: 'pinned' | 'release-sums';
};
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// Repo root in dev and /app or /b in the image; never used by the compiled binary.
export const ROOT = join(import.meta.dir, '..', '..');
export const VERSIONS_FILE = join(ROOT, 'versions.json');

const GH = 'https://github.com';
const RELEASE_TIMEOUT_MS = 30_000;

export const isPinned = (tool: Tool): tool is PinnedTool => tool !== 'caddy';

// Data-driven so a tool can point at another source. `version` is the upstream
// version, except for caddy where it is the Telinha release tag (v0.6.0).
// `member` is the file inside the archive (or the saved name for a raw binary).
export function assetSpec(tool: Tool, version: string, os: Os, arch: Arch): Spec {
  const exe = os === 'windows' ? '.exe' : '';
  const archive = os === 'windows' ? 'zip' : 'tar.gz';
  switch (tool) {
    case 'livekit': {
      const asset = `livekit_${version}_${os}_${arch}.${archive}`;
      return { url: `${GH}/livekit/livekit/releases/download/v${version}/${asset}`, asset, archive, member: `livekit-server${exe}`, hashKey: `${os}-${arch}`, verify: 'pinned' };
    }
    case 'caddy': {
      const asset = caddyAssetName(os, arch);
      return { url: releaseAssetUrl(version, asset), asset, archive, member: `caddy${exe}`, hashKey: `${os}-${arch}`, verify: 'release-sums' };
    }
    case 'cloudflared': {
      // No windows-arm64 build upstream; Windows 11 on ARM runs the x64 one emulated.
      const a = os === 'windows' && arch === 'arm64' ? 'amd64' : arch;
      const asset = `cloudflared-${os}-${a}${exe}`;
      return { url: `${GH}/cloudflare/cloudflared/releases/download/${version}/${asset}`, asset, archive: null, member: `cloudflared${exe}`, hashKey: `${os}-${a}`, verify: 'pinned' };
    }
  }
}

/** The pins bundled with this program (the repo file in dev, embedded in the compiled binary). */
export function loadVersions(): Versions {
  return versionsJson as unknown as Versions;
}

/** Compiled: this binary's own release. Source: the newest stable release (its Caddy is the same Caddy). */
export async function resolveCaddyRelease(fetchFn: FetchFn, compiled: boolean = isCompiled()): Promise<CaddyRelease> {
  const tag = compiled ? `v${version()}` : await latestReleaseTag(fetchFn, REPO, RELEASE_TIMEOUT_MS);
  if (!tag) throw new Error('no Telinha release found for caddy (offline?)');
  return caddyRelease(tag, fetchFn);
}

/** The release `tag`; its SHA256SUMS is fetched on the first sums() call and reused. */
export function caddyRelease(tag: string, fetchFn: FetchFn): CaddyRelease {
  let sums: Promise<Record<string, string>> | null = null;
  return {
    tag,
    sums: () => (sums ??= (async () => {
      const res = await fetchFn(releaseAssetUrl(tag, 'SHA256SUMS'), { signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`SHA256SUMS of ${tag}: HTTP ${res.status}`);
      return parseSums(await res.text());
    })()),
  };
}

export async function download(url: string, fetchFn: FetchFn = fetch): Promise<Uint8Array> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function sha256(data: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

export function hostOs(platform: string = process.platform): Os {
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  throw new Error(`no binaries for ${platform}`);
}

export function hostArch(arch: string = process.arch): Arch {
  if (arch === 'x64') return 'amd64';
  if (arch === 'arm64') return 'arm64';
  throw new Error(`no binaries for ${arch}`);
}

export type EnsureOptions = {
  os: Os;
  arch: Arch;
  outDir: string;
  versions?: Versions;
  /** Required when caddy is among the tools. */
  release?: CaddyRelease;
  log?: (msg: string) => void;
  fetch?: FetchFn;
};

export type EnsureResult = {
  /** Installed path per requested tool. */
  paths: Partial<Record<Tool, string>>;
  /** Tools (re)downloaded by this call. */
  changed: Tool[];
};

export async function ensureBinaries(names: Tool[], o: EnsureOptions): Promise<EnsureResult> {
  const versions = o.versions ?? loadVersions();
  const log = o.log ?? ((m: string) => console.log(m));
  const platform = `${o.os}-${o.arch}` as Platform;
  if (!PLATFORMS.includes(platform)) throw new Error(`no binaries for ${platform}`);
  await mkdir(o.outDir, { recursive: true });

  const paths: Partial<Record<Tool, string>> = {};
  const changed: Tool[] = [];
  for (const name of names) {
    // Caddy's "version" is the release tag: a telinha update re-fetches its Caddy.
    let version: string;
    if (isPinned(name)) version = versions[name].version;
    else if (o.release) version = o.release.tag;
    else throw new Error('caddy comes from a Telinha release: pass the release tag (bun scripts/bins.ts --release vX.Y.Z caddy)');
    const spec = assetSpec(name, version, o.os, o.arch);
    const bin = join(o.outDir, spec.member);
    // Sidecar records which version `bin` is, so a pin bump re-downloads.
    const sidecar = join(o.outDir, `${name}.version`);
    paths[name] = bin;
    if ((await Bun.file(bin).exists()) && (await Bun.file(sidecar).exists()) && (await Bun.file(sidecar).text()).trim() === version) {
      log(`[bins] ${name} ${version} already present`);
      continue;
    }

    if (spec.hashKey !== platform) log(`[bins] ${name} has no ${platform} build; using the x64 build (emulated)`);
    let expected: string | undefined;
    if (isPinned(name)) {
      expected = versions[name].sha256[spec.hashKey];
      if (!expected) throw new Error(`${name}: no sha256 for ${spec.hashKey} in versions.json (run: bun scripts/versions.ts refresh)`);
    } else {
      expected = (await o.release!.sums())[spec.asset];
      if (!expected) throw new Error(`SHA256SUMS of ${version} has no ${spec.asset}`);
    }
    log(`[bins] downloading ${spec.asset}`);
    const data = await download(spec.url, o.fetch);
    const actual = sha256(data);
    // Verify before touching the disk so a bad download never gets extracted.
    if (actual !== expected) throw new Error(`${spec.asset}: sha256 ${actual}, expected ${expected}`);

    let content = data;
    if (spec.archive !== null) {
      // Archives carry LICENSE/README we don't want in outDir: keep only the member.
      const entries = spec.archive === 'zip' ? readZip(data) : readTarGz(data);
      const found = entries.find((e) => e.path.replace(/\\/g, '/').replace(/^\.\//, '') === spec.member);
      if (!found) throw new Error(`${spec.asset} did not contain ${spec.member}`);
      content = found.data;
    }

    await rm(sidecar, { force: true });
    // Written beside the target, then renamed: a half-written binary is never run.
    const tmp = `${bin}.download`;
    await Bun.write(tmp, content);
    if (o.os === 'linux') await chmod(tmp, 0o755);
    await rm(bin, { force: true });
    await rename(tmp, bin);
    await Bun.write(sidecar, `${version}\n`); // last, so an interrupted run retries
    changed.push(name);
    log(`[bins] ${name} ${version} installed`);
  }
  return { paths, changed };
}

/** The child binaries a config runs: LiveKit for self-hosted media, Caddy for direct ingress, cloudflared for the tunnel. */
export function toolsFor(config: Pick<Config, 'media' | 'ingress'>): Tool[] {
  const names: Tool[] = [];
  if (config.media === 'self') names.push('livekit');
  if (config.ingress === 'direct') names.push('caddy');
  if (config.ingress === 'tunnel') names.push('cloudflared');
  return names;
}

/**
 * Makes sure `paths.bin` holds the binaries this config needs. Offline (or any
 * download failure, including no reachable release for caddy) with a binary
 * already present is a warning: start continues with what is there. A binary
 * that is missing and cannot be fetched is fatal. The release is looked up only
 * when caddy is needed, so tunnel and external starts never ask GitHub for it.
 */
export async function ensureBinariesForConfig(
  config: Pick<Config, 'media' | 'ingress'>,
  paths: Pick<Paths, 'bin'>,
  log: (msg: string) => void,
  o: {
    fetch?: FetchFn;
    versions?: Versions;
    release?: CaddyRelease;
    platform?: string;
    arch?: string;
    which?: (name: string) => string | null;
    compiled?: boolean;
  } = {},
): Promise<EnsureResult> {
  const os = hostOs(o.platform);
  const arch = hostArch(o.arch);
  const which = o.which ?? ((n: string) => Bun.which(n));
  const versions = o.versions ?? loadVersions();
  const fetchFn = o.fetch ?? fetch;
  const result: EnsureResult = { paths: {}, changed: [] };
  for (const name of toolsFor(config)) {
    try {
      const release = name === 'caddy' ? (o.release ?? (await resolveCaddyRelease(fetchFn, o.compiled))) : undefined;
      const r = await ensureBinaries([name], { os, arch, outDir: paths.bin, versions, release, log, fetch: fetchFn });
      Object.assign(result.paths, r.paths);
      result.changed.push(...r.changed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The member name does not depend on the version.
      const member = assetSpec(name, '', os, arch).member;
      const local = join(paths.bin, member);
      const present = existsSync(local) ? local : which(member.replace(/\.exe$/, ''));
      if (!present) throw new Error(`${member.replace(/\.exe$/, '')} not found: put it in ${paths.bin} or on PATH (download failed: ${msg})`);
      log(`[bins] could not update ${name} (${msg}); using ${present}`);
      result.paths[name] = present;
    }
  }
  return result;
}
