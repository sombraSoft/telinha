// Maintains versions.json: `check` validates structure and hashes (CI), `refresh`
// downloads every pinned asset and rewrites the sha256 values (run after a Renovate bump).
// caddy is a build recipe (we build it, each release's SHA256SUMS pins it): validated, never hashed here.
import { writeFile } from 'node:fs/promises';
import {
  type Arch,
  assetSpec,
  download,
  HELPERS,
  type Helper,
  isPinned,
  type Os,
  PLATFORMS,
  type Platform,
  sha256,
  VERSIONS_FILE,
  type Versions,
} from '../server/src/bins.ts';
import { parseSums } from '../server/src/release.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const TAG = /^v\d/;
// host/owner/repo[/subpath][/vN], as Go module paths are written.
const GO_MODULE = /^[a-z0-9.-]+\.[a-z]{2,}(\/[A-Za-z0-9._~-]+){2,}$/;

/** One per distinct pinned asset (platforms that fall back to another build share its key); none for a built helper. */
export function assets(helper: Helper, version: string): { key: Platform; spec: ReturnType<typeof assetSpec> }[] {
  const seen = new Map<Platform, ReturnType<typeof assetSpec>>();
  for (const p of PLATFORMS) {
    const [os, arch] = p.split('-') as [Os, Arch];
    const spec = assetSpec(helper, version, os, arch);
    if (spec.verify !== 'pinned') return [];
    if (!seen.has(spec.hashKey)) seen.set(spec.hashKey, spec);
  }
  return [...seen].map(([key, spec]) => ({ key, spec }));
}

export function validate(v: unknown): string[] {
  const errors: string[] = [];
  if (typeof v !== 'object' || v === null) return ['versions.json is not an object'];
  const rec = v as Record<string, any>;
  for (const helper of HELPERS) {
    const e = rec[helper];
    if (!e || typeof e.version !== 'string' || !e.version) {
      errors.push(`${helper}: missing version`);
      continue;
    }
    if (!isPinned(helper)) {
      errors.push(...validateBuild(helper, e));
      continue;
    }
    const keys = assets(helper, e.version).map((a) => a.key);
    for (const key of keys) {
      const h = e.sha256?.[key];
      if (typeof h !== 'string' || !HEX64.test(h))
        errors.push(`${helper}: sha256 for ${key} missing or not 64 hex chars`);
    }
    for (const key of Object.keys(e.sha256 ?? {})) {
      if (!keys.includes(key as Platform)) errors.push(`${helper}: sha256 for ${key} matches no asset`);
    }
  }
  return errors;
}

function validateBuild(helper: Helper, e: Record<string, any>): string[] {
  const errors: string[] = [];
  if (!SEMVER.test(e.version)) errors.push(`${helper}: version ${e.version} is not x.y.z`);
  if (typeof e.xcaddy !== 'string' || !TAG.test(e.xcaddy)) errors.push(`${helper}: xcaddy must be a tag like v0.4.7`);
  const mods = e.modules;
  if (typeof mods !== 'object' || mods === null || Array.isArray(mods) || !Object.keys(mods).length) {
    errors.push(`${helper}: modules must be a non-empty object of Go module path -> tag`);
  } else {
    for (const [path, tag] of Object.entries(mods)) {
      if (!GO_MODULE.test(path)) errors.push(`${helper}: ${path} is not a Go module path`);
      if (typeof tag !== 'string' || !TAG.test(tag)) errors.push(`${helper}: ${path} needs a tag like v1.2.3`);
    }
  }
  if ('sha256' in e)
    errors.push(`${helper}: caddy is built, not downloaded: remove its sha256 (each release's SHA256SUMS pins it)`);
  return errors;
}

// Upstream checksum files, in the sha256sum format our own SHA256SUMS uses (parseSums
// reads both); null when the helper publishes none (cloudflared) or is built by us (caddy).
export function checksumsUrl(helper: Helper, version: string): string | null {
  const spec = assetSpec(helper, version, 'linux', 'amd64');
  if (helper === 'livekit') return spec.url.replace(spec.asset, 'checksums.txt');
  return null;
}

/**
 * The independent check on the hashes the image and installers trust: a helper
 * that publishes checksums must be cross-checked, so any failure to get them
 * (network, 5xx, rate limit, a missing file) stops the refresh instead of
 * silently skipping the check.
 */
export async function upstreamChecksums(
  helper: Helper,
  version: string,
  get: (url: string) => Promise<Uint8Array> = download,
): Promise<Record<string, string> | null> {
  const url = checksumsUrl(helper, version);
  if (!url) return null;
  let text: string;
  try {
    text = new TextDecoder().decode(await get(url));
  } catch (e) {
    throw new Error(
      `${helper} ${version}: could not fetch upstream checksums, refusing to pin unchecked hashes (${e instanceof Error ? e.message : e})`,
    );
  }
  const sums = parseSums(text);
  if (!Object.keys(sums).length) throw new Error(`${helper} ${version}: upstream checksums at ${url} list nothing`);
  return sums;
}

async function refresh(): Promise<void> {
  const versions = (await Bun.file(VERSIONS_FILE).json()) as Versions & { $comment?: string };
  for (const helper of HELPERS) {
    if (!isPinned(helper)) {
      console.log(`[versions] ${helper} ${versions[helper].version}: built with xcaddy, nothing to refresh`);
      continue;
    }
    const entry = versions[helper];
    const upstream = await upstreamChecksums(helper, entry.version);
    const list = assets(helper, entry.version);
    const hashes = new Map<Platform, string>();
    await Promise.all(
      list.map(async ({ key, spec }) => {
        console.log(`[versions] ${spec.asset}`);
        const data = await download(spec.url);
        const listed = upstream?.[spec.asset];
        if (upstream && !listed) throw new Error(`${spec.asset} not listed in upstream checksums`);
        const computed = sha256(data);
        if (listed && computed !== listed)
          throw new Error(`${spec.asset}: computed sha256 ${computed}, upstream says ${listed}`);
        hashes.set(key, computed);
      }),
    );
    // Fixed platform order keeps the diff of versions.json stable.
    entry.sha256 = Object.fromEntries(list.map(({ key }) => [key, hashes.get(key)!]));
    console.log(
      `[versions] ${helper} ${entry.version}: ${upstream ? 'cross-checked against upstream' : 'upstream publishes no checksums, pinned as downloaded'}`,
    );
  }
  await writeFile(VERSIONS_FILE, `${JSON.stringify(versions, null, 2)}\n`);
}

if (import.meta.main) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'check') {
      const errors = validate(await Bun.file(VERSIONS_FILE).json());
      if (errors.length) {
        console.error(errors.join('\n'));
        process.exit(1);
      }
      console.log('versions.json ok');
    } else if (cmd === 'refresh') {
      await refresh();
    } else {
      console.error('usage: bun scripts/versions.ts check|refresh');
      process.exit(2);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
