// Timestamped log lines to stdout and/or a size-rotated file
// (telinha.log -> telinha.log.1 ... .keep). The file is for `service run` on
// Windows, where no journal collects stdout.
import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { format } from 'node:util';

export interface Logger {
  log(...a: unknown[]): void;
  close(): void;
}

export interface LoggerOptions {
  /** Default true. */
  stdout?: boolean;
  file?: string;
  /** Rotate before a line would push the file past this size. Default 10 MB. */
  maxBytes?: number;
  /** Rotated files kept (telinha.log.1 ... .keep). Default 5. */
  keep?: number;
  now?: () => Date;
}

export function createLogger(o: LoggerOptions = {}): Logger {
  const toStdout = o.stdout ?? true;
  const maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
  const keep = o.keep ?? 5;
  const now = o.now ?? (() => new Date());
  const file = o.file;
  let fd: number | null = null;
  let size = 0;
  let closed = false;
  let failed = false;

  const open = (path: string): number => {
    mkdirSync(dirname(path), { recursive: true });
    const opened = openSync(path, 'a');
    fd = opened;
    size = fstatSync(opened).size;
    return opened;
  };

  const rotate = (path: string, current: number): number => {
    closeSync(current);
    fd = null;
    // Best effort: on Windows a reader holding a rotated file open blocks the rename;
    // appending to the current file beats losing lines.
    try {
      rmSync(`${path}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        try {
          renameSync(`${path}.${i}`, `${path}.${i + 1}`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      if (keep > 0) renameSync(path, `${path}.1`);
      else rmSync(path, { force: true });
    } catch {
      // keep appending below
    }
    return open(path);
  };

  const toFile = (line: string) => {
    if (!file || closed) return;
    try {
      let out = fd ?? open(file);
      const bytes = Buffer.from(line, 'utf8');
      // A whole line per write, rotated before it would cross the limit: no split lines.
      if (size > 0 && size + bytes.length > maxBytes) out = rotate(file, out);
      writeSync(out, bytes);
      size += bytes.length;
    } catch (e) {
      // A full disk or a vanished directory must not take the service down; say it once.
      if (!failed)
        console.error(`${now().toISOString()} log: cannot write ${file}: ${e instanceof Error ? e.message : e}`);
      failed = true;
    }
  };

  return {
    log(...a: unknown[]) {
      const ts = now().toISOString();
      if (toStdout) console.log(ts, ...a);
      if (file) toFile(`${format(ts, ...a)}\n`);
    },
    close() {
      closed = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
        fd = null;
      }
    },
  };
}
