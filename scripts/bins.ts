// `bun run bins`: downloads the pinned child binaries into a directory. Used by
// dev/E2E and the Docker build (which copies server/src/bins.ts + archive.ts and
// versions.json next to this file, so nothing else of server/ is needed).
import { join } from 'node:path';
import { ROOT, TOOLS, ensureBinaries, hostArch, hostOs, type Arch, type Os, type Tool } from '../server/src/bins.ts';

function parseArgs(argv: string[]) {
  let os: Os | undefined;
  let arch: Arch | undefined;
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
  // Host defaults only when not given: the image build passes both for another platform.
  try {
    os ??= hostOs();
    arch ??= hostArch();
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : e}; pass --os and --arch`);
  }
  return { os, arch, outDir, names: names.length ? names : [...TOOLS] };
}

if (import.meta.main) {
  try {
    const { names, ...o } = parseArgs(process.argv.slice(2));
    const { paths } = await ensureBinaries(names, o);
    for (const p of Object.values(paths)) console.log(p);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
