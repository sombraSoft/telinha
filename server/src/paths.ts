// Where Telinha keeps its binaries, config and data. One tree per install, the same
// layout natively and on a Docker host (/opt/telinha/config/telinha.env).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

type Env = Record<string, string | undefined>;

export interface Paths {
  home: string;
  /** Child binaries (livekit-server, caddy, cloudflared), looked at before PATH. */
  bin: string;
  config: string;
  /** Registry, rendered files (run/), Caddy storage (caddy/). */
  data: string;
  /** Rendered livekit.yaml / Caddyfile, pidfiles, the control token, update and UPnP state. */
  run: string;
  /** The service log on Windows (Linux uses the journal). */
  logs: string;
  /** logs/telinha.log, rotated to .1 ... .5 */
  logFile: string;
}

export function resolvePaths(
  env: Env,
  platform: NodeJS.Platform = process.platform,
  isRoot = process.getuid?.() === 0,
): Paths {
  const set = (k: string) => (env[k] ? env[k] : undefined);
  // Joined with the target platform's rules so a linux layout reads right on a win32 test host.
  const p = platform === 'win32' ? win32 : posix;
  const home =
    set('TELINHA_HOME') ??
    (platform === 'win32'
      ? p.join(set('LOCALAPPDATA') ?? p.join(homedir(), 'AppData', 'Local'), 'Telinha')
      : isRoot
        ? '/opt/telinha'
        : p.join(set('XDG_DATA_HOME') ?? p.join(set('HOME') ?? homedir(), '.local', 'share'), 'telinha'));
  const data = set('DATA_DIR') ?? p.join(home, 'data');
  return {
    home,
    bin: set('BIN_DIR') ?? p.join(home, 'bin'),
    config: p.join(home, 'config'),
    data,
    run: p.join(data, 'run'),
    logs: p.join(home, 'logs'),
    logFile: p.join(home, 'logs', 'telinha.log'),
  };
}

/**
 * The home an installed binary lives in: <home>/bin/telinha[.exe] -> <home>,
 * when <home> is named telinha (the default homes, and any sensible custom
 * one) or already holds config/telinha.env. Anything else (a download folder,
 * ~/bin) is no home: null, and the defaults apply.
 */
export function homeOfExe(
  exe: string,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const p = platform === 'win32' ? win32 : posix;
  const dir = p.dirname(exe);
  if (p.basename(dir).toLowerCase() !== 'bin') return null;
  const home = p.dirname(dir);
  if (home === dir) return null;
  if (p.basename(home).toLowerCase() === 'telinha' || exists(p.join(home, 'config', 'telinha.env'))) return home;
  return null;
}

/** `<bin>/<name>[.exe]`, else the first `name` on PATH, else null. */
export function findBinary(name: string, paths: Pick<Paths, 'bin'>, PATH = process.env.PATH ?? ''): string | null {
  const local = join(paths.bin, process.platform === 'win32' ? `${name}.exe` : name);
  if (existsSync(local)) return local;
  return Bun.which(name, { PATH });
}
