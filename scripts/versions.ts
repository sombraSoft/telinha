// Maintains versions.json: `check` validates structure and hashes (CI), `refresh`
// downloads every pinned asset and rewrites the sha256 values (run after a Renovate bump).
import { writeFile } from 'node:fs/promises';
import { PLATFORMS, TOOLS, VERSIONS_FILE, assetSpec, download, sha256, type Arch, type Os, type Platform, type Tool, type Versions } from './bins.ts';

const HEX64 = /^[0-9a-f]{64}$/;

export function validate(v: unknown): string[] {
  const errors: string[] = [];
  if (typeof v !== 'object' || v === null) return ['versions.json is not an object'];
  const rec = v as Record<string, any>;
  for (const tool of TOOLS) {
    const e = rec[tool];
    if (!e || typeof e.version !== 'string' || !e.version) {
      errors.push(`${tool}: missing version`);
      continue;
    }
    for (const p of PLATFORMS) {
      const h = e.sha256?.[p];
      if (typeof h !== 'string' || !HEX64.test(h)) errors.push(`${tool}: sha256 for ${p} missing or not 64 hex chars`);
    }
  }
  return errors;
}

// Upstream checksum files ("<hash>  <file>" lines); null when the tool publishes none (cloudflared).
export function checksumsUrl(tool: Tool, version: string): string | null {
  const spec = assetSpec(tool, version, 'linux', 'amd64');
  if (tool === 'livekit') return spec.url.replace(spec.asset, 'checksums.txt');
  if (tool === 'caddy') return spec.url.replace(spec.asset, `caddy_${version}_checksums.txt`);
  return null;
}

export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [hash, file] = line.trim().split(/\s+/);
    if (hash && file) map.set(file.replace(/^\*/, ''), hash.toLowerCase());
  }
  return map;
}

/**
 * The independent check on the hashes the image and installers trust: a tool
 * that publishes checksums must be cross-checked, so any failure to get them
 * (network, 5xx, rate limit, a missing file) stops the refresh instead of
 * silently skipping the check.
 */
export async function upstreamChecksums(
  tool: Tool, version: string, get: (url: string) => Promise<Uint8Array> = download,
): Promise<Map<string, string> | null> {
  const url = checksumsUrl(tool, version);
  if (!url) return null;
  let text: string;
  try {
    text = new TextDecoder().decode(await get(url));
  } catch (e) {
    throw new Error(`${tool} ${version}: could not fetch upstream checksums, refusing to pin unchecked hashes (${e instanceof Error ? e.message : e})`);
  }
  const map = parseChecksums(text);
  if (!map.size) throw new Error(`${tool} ${version}: upstream checksums at ${url} list nothing`);
  return map;
}

async function refresh(): Promise<void> {
  const versions = (await Bun.file(VERSIONS_FILE).json()) as Versions & { $comment?: string };
  for (const tool of TOOLS) {
    const entry = versions[tool];
    const upstream = await upstreamChecksums(tool, entry.version);
    const hashes = {} as Record<Platform, string>;
    await Promise.all(
      PLATFORMS.map(async (p) => {
        const [os, arch] = p.split('-') as [Os, Arch];
        const spec = assetSpec(tool, entry.version, os, arch);
        console.log(`[versions] ${spec.asset}`);
        const data = await download(spec.url);
        const actual = sha256(data);
        const listed = upstream?.get(spec.asset);
        if (upstream && !listed) throw new Error(`${spec.asset} not listed in upstream checksums`);
        if (listed) {
          // Caddy publishes sha512, LiveKit sha256: pick the digest by length.
          const algo = listed.length === 128 ? 'sha512' : 'sha256';
          const computed = new Bun.CryptoHasher(algo).update(data).digest('hex');
          if (computed !== listed) throw new Error(`${spec.asset}: computed ${algo} ${computed}, upstream says ${listed}`);
        }
        hashes[p] = actual;
      }),
    );
    // Fixed platform order keeps the diff of versions.json stable.
    entry.sha256 = Object.fromEntries(PLATFORMS.map((p) => [p, hashes[p]])) as Record<Platform, string>;
    console.log(`[versions] ${tool} ${entry.version}: ${upstream ? 'cross-checked against upstream' : 'upstream publishes no checksums, pinned as downloaded'}`);
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
