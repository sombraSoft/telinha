// Fetch, verify and unpack one release: the archive streams to
// bin/.telinha-<tag>.download, its sha256 must match the tag's SHA256SUMS line,
// and the single executable inside lands as bin/telinha.new[.exe]. Anything
// that smells like "not published yet" is a PendingError; anything verified
// wrong is a FailedError.
import { basename, join } from 'node:path';
import { readTarGz, readZip, type Entry } from '../archive.ts';
import { sha256 } from '../bins.ts';
import type { Target } from '../version.ts';
import { assetName } from './github.ts';
import { FailedError, PendingError, errorMessage, type GitHubReleases, type UpdateFs } from './types.ts';

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

export const newExeName = (target: Target): string => (target.startsWith('windows') ? 'telinha.new.exe' : 'telinha.new');
const exeInArchive = (target: Target) => (target.startsWith('windows') ? 'telinha.exe' : 'telinha');

export interface DownloadOptions {
  github: GitHubReleases;
  fs: UpdateFs;
  bin: string;
  tag: string;
  target: Target;
  log?: (...a: unknown[]) => void;
  maxBytes?: number;
}

/** Streams `res.body` into `path`; the cap aborts a runaway download before it fills the disk. */
async function streamTo(fs: UpdateFs, res: Response, path: string, maxBytes: number): Promise<number> {
  const sink = await fs.openWrite(path);
  let total = 0;
  try {
    if (!res.body) throw new PendingError('empty response body');
    const reader = res.body.getReader();
    const read = () => reader.read().catch((e: unknown) => {
      throw new PendingError(`download interrupted: ${errorMessage(e)}`);
    });
    for (let step = await read(); !step.done; step = await read()) {
      total += step.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FailedError(`archive larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      await sink.write(step.value);
    }
  } finally {
    await sink.close();
  }
  return total;
}

function findExecutable(entries: Entry[], name: string): Entry {
  const hits = entries.filter((e) => basename(e.path.replace(/\\/g, '/')) === name);
  if (hits.length !== 1) throw new FailedError(hits.length ? `archive has ${hits.length} entries named ${name}` : `archive has no ${name}`);
  return hits[0]!;
}

/** Downloads and verifies `tag`; returns the path of the extracted telinha.new[.exe]. */
export async function downloadRelease(o: DownloadOptions): Promise<string> {
  const log = o.log ?? (() => {});
  const maxBytes = o.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const name = assetName(o.target);
  const sums = await o.github.sums(o.tag);
  const expected = sums[name];
  // The sums file is uploaded with every asset, so a missing line is a bad release, not a race.
  if (!expected) throw new FailedError(`SHA256SUMS of ${o.tag} has no line for ${name}`);

  const res = await o.github.asset(o.tag, name);
  if (!res.ok) throw new PendingError(`${name} of ${o.tag}: HTTP ${res.status}`);

  await o.fs.mkdir(o.bin);
  const download = join(o.bin, `.telinha-${o.tag}.download`);
  const output = join(o.bin, newExeName(o.target));
  try {
    const bytes = await streamTo(o.fs, res, download, maxBytes);
    log(`update: downloaded ${name} (${Math.round(bytes / 1024 / 1024)} MB)`);
    const data = await o.fs.readBytes(download);
    const actual = sha256(data);
    if (actual !== expected) throw new FailedError(`sha256 mismatch for ${name}: expected ${expected}, got ${actual}`);
    let entries: Entry[];
    try {
      entries = name.endsWith('.zip') ? readZip(data) : readTarGz(data);
    } catch (e) {
      throw new FailedError(`bad archive ${name}: ${errorMessage(e)}`);
    }
    const exe = findExecutable(entries, exeInArchive(o.target));
    await o.fs.writeBytes(output, exe.data, 0o755);
    return output;
  } finally {
    await o.fs.rm(download).catch(() => {});
  }
}
