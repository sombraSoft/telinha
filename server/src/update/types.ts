// Shared by the self-updater, the swap/rollback helpers and the `service run`
// loop: the file layer they all go through (so the Windows and Linux paths run
// in tests on either host), the GitHub release reader, and the two error kinds
// that tell "not available yet, try later" from "this build is bad".
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { UpdateApplied, UpdateFailed, UpdatePending, UpdateStaged } from '../cli/control.ts';

export type {
  UpdateAction,
  UpdateApplied,
  UpdateCheck,
  UpdateFailed,
  UpdateMode,
  UpdatePending,
  UpdateResult,
  UpdateStaged,
  UpdateStatus,
} from '../cli/control.ts';

export interface FileStat {
  size: number;
  mtimeMs: number;
}
export interface WriteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface UpdateFs {
  /** Names (not paths) in `dir`; [] when it does not exist. */
  readdir(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  /** No error when the path does not exist. */
  rm(path: string): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
  /** null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array, mode?: number): Promise<void>;
  mkdir(dir: string): Promise<void>;
  /** Streaming writer for a download: bounded memory, whatever the archive size. */
  openWrite(path: string): Promise<WriteSink>;
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/** The real file system. */
export function nodeFs(): UpdateFs {
  return {
    async readdir(dir) {
      try {
        return await readdir(dir);
      } catch (e) {
        if (isEnoent(e)) return [];
        throw e;
      }
    },
    rename: (from, to) => rename(from, to),
    rm: (path) => rm(path, { force: true }),
    async stat(path) {
      try {
        const s = await stat(path);
        return { size: s.size, mtimeMs: s.mtimeMs };
      } catch (e) {
        if (isEnoent(e)) return null;
        throw e;
      }
    },
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        if (isEnoent(e)) return null;
        throw e;
      }
    },
    writeText: (path, text) => writeFile(path, text),
    readBytes: async (path) => new Uint8Array(await readFile(path)),
    async writeBytes(path, data, mode) {
      await writeFile(path, data, mode === undefined ? {} : { mode });
      // writeFile's mode only applies to new files and goes through the umask.
      if (mode !== undefined && process.platform !== 'win32') await chmod(path, mode);
    },
    mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
    async openWrite(path) {
      const fh = await open(path, 'w');
      return {
        write: async (chunk) => void (await fh.write(chunk)),
        close: () => fh.close(),
      };
    },
  };
}

/** data/run/update.json. */
export interface UpdateState {
  staged?: UpdateStaged;
  /** The last staged update that started fine; kept until the next one replaces it. */
  applied?: UpdateApplied;
  failed?: UpdateFailed;
  pending?: UpdatePending;
  lastCheck?: number;
  /** Rooms were open when `deferredTag` was due: deferring since then. */
  deferredSince?: number;
  deferredTag?: string;
}

/** GitHub releases of the repo, as the updater reads them (no API, no token: plain release URLs). */
export interface GitHubReleases {
  /** The tag `releases/latest` redirects to (may be a prerelease), or null when there is none or we are offline. */
  latestTag(): Promise<string | null>;
  assetUrl(tag: string, asset: string): string;
  /** SHA256SUMS of a tag: asset file name -> sha256 hex. PendingError when not downloadable. */
  sums(tag: string): Promise<Record<string, string>>;
  /** The asset's response, status unchecked; PendingError on a network failure. */
  asset(tag: string, name: string): Promise<Response>;
}

/** Not downloadable right now (404 on a half-published release, network down): retried at the next check, never recorded as failed. */
export class PendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PendingError';
  }
}

/** Verified bad (sha mismatch, bad archive, missing executable): recorded as failed, skipped until a newer tag. */
export class FailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailedError';
  }
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
