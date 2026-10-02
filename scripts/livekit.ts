// Downloads the LiveKit server binary used by `bun run dev` and the E2E stack
// into .cache/livekit/<version>/, verified against the release checksums.
// Production runs the livekit/livekit-server image pinned in deploy/compose.yml.
import { $ } from 'bun';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Renovate tracks this line (customManagers in renovate.json); keep the format.
export const LIVEKIT_VERSION = '1.13.7';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELEASES = 'https://github.com/livekit/livekit/releases/download';

function asset(version: string): string {
  const arch = process.arch === 'x64' ? 'amd64' : null;
  if (arch && process.platform === 'win32') return `livekit_${version}_windows_${arch}.zip`;
  if (arch && process.platform === 'linux') return `livekit_${version}_linux_${arch}.tar.gz`;
  throw new Error(`no LiveKit binary for ${process.platform}/${process.arch}; install livekit-server ${version} yourself`);
}

async function download(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}

export async function ensureLivekit(version = LIVEKIT_VERSION): Promise<string> {
  const dir = join(ROOT, '.cache', 'livekit', version);
  const bin = join(dir, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
  if (await Bun.file(bin).exists()) return bin;

  const name = asset(version);
  console.log(`[livekit] downloading ${name}`);
  const sums = new TextDecoder().decode(await download(`${RELEASES}/v${version}/checksums.txt`));
  const expected = sums
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, file]) => file === name)?.[0];
  if (!expected) throw new Error(`${name} not listed in checksums.txt`);

  const data = await download(`${RELEASES}/v${version}/${name}`);
  const actual = new Bun.CryptoHasher('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`${name}: sha256 ${actual}, expected ${expected}`);

  await mkdir(dir, { recursive: true });
  const archive = join(dir, name);
  await Bun.write(archive, data);
  // Windows ships bsdtar, which reads .zip too. Call it by full path: Git for
  // Windows puts a GNU tar first on PATH that handles neither zip nor C:\ paths.
  const tar = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  await $`${tar} -xf ${name}`.cwd(dir);
  await rm(archive);
  if (!(await Bun.file(bin).exists())) throw new Error(`${name} did not contain ${bin}`);
  if (process.platform !== 'win32') await $`chmod +x ${bin}`;
  return bin;
}

if (import.meta.main) console.log(await ensureLivekit());
