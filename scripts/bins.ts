// `bun run bins`: downloads the child binaries into a directory. Used by dev/E2E
// and the Docker build (which copies server/src/bins.ts, archive.ts,
// footprint.ts, version.ts, release.ts and versions.json next to this file,
// so nothing else of server/ is needed). caddy is Telinha's own build, taken
// from a release: --release picks which one, the latest by default.
import { join } from 'node:path';
import {
  type Arch,
  caddyRelease,
  ensureBinaries,
  HELPERS,
  type Helper,
  hostArch,
  hostOs,
  type Os,
  ROOT,
} from '../server/src/bins.ts';
import { latestReleaseTag } from '../server/src/release.ts';

const USAGE = `usage: bun scripts/bins.ts [--os linux|windows] [--arch amd64|arm64] [--out DIR] [--release vX.Y.Z] [${HELPERS.join(' ')}]
  --release  the Telinha release whose caddy to fetch (default: the latest one; only read when caddy is asked for)`;

function parseArgs(argv: string[]) {
  let os: Os | undefined;
  let arch: Arch | undefined;
  let outDir = process.env.BIN_DIR || join(ROOT, '.cache', 'telinha', 'bin');
  let release: string | undefined;
  const names: Helper[] = [];
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
    } else if (a === '--release') {
      release = value();
    } else if ((HELPERS as readonly string[]).includes(a)) {
      names.push(a as Helper);
    } else {
      throw new Error(`unknown argument ${a}\n${USAGE}`);
    }
  }
  // Host defaults only when not given: the image build passes both for another platform.
  try {
    os ??= hostOs();
    arch ??= hostArch();
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : e}; pass --os and --arch`);
  }
  return { os, arch, outDir, release, names: names.length ? names : [...HELPERS], explicit: names.length > 0 };
}

if (import.meta.main) {
  try {
    const { names, explicit, release: given, ...o } = parseArgs(process.argv.slice(2));
    // The pinned helpers first: caddy depends on a release that has its asset,
    // and its failure must not cost the others.
    const pinned = names.filter((n) => n !== 'caddy');
    if (pinned.length) {
      const { paths } = await ensureBinaries(pinned, o);
      for (const p of Object.values(paths)) console.log(p);
    }
    // Only caddy needs a release, so the Docker build (no caddy) never asks GitHub for one.
    if (names.includes('caddy')) {
      try {
        const tag = given ?? (await latestReleaseTag(fetch));
        if (!tag) throw new Error('no Telinha release found for caddy (offline?): pass --release vX.Y.Z');
        const { paths } = await ensureBinaries(['caddy'], { ...o, release: caddyRelease(tag, fetch) });
        for (const p of Object.values(paths)) console.log(p);
      } catch (e) {
        // Asked for by name: a hard failure. Part of "everything": releases cut
        // before Telinha shipped its Caddy have no asset, so say how to get one.
        if (explicit) throw e;
        console.warn(
          `caddy: ${e instanceof Error ? e.message : e}; build it with bun run caddy, or pass --release vX.Y.Z caddy`,
        );
      }
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
