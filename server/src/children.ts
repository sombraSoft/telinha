// Which child processes a mode needs, as data for the supervisor.
// Secrets reach a child only through its own env, never argv (world-readable in
// ps/tasklist and printed in the "spawning" log line) and never a rendered file.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWN_KEYS, type Config } from './config.ts';
import { findBinary as defaultFindBinary, type Paths } from './paths.ts';
import { renderCaddyfile, renderLivekitYaml } from './render.ts';
import type { ChildSpec } from './supervisor.ts';

export type FindBinary = (name: string, paths: Pick<Paths, 'bin'>) => string | null;
/** Does something already accept TCP connections on 127.0.0.1:<port>? */
export type PortInUse = (port: number) => Promise<boolean>;

const PROBE_TIMEOUT_MS = 1000;

/**
 * A connect, not a test bind: on Windows (Bun 1.4.2, verified) binding
 * 127.0.0.1:<p> succeeds next to a 0.0.0.0:<p> listener and the reverse too,
 * so only a connect tells. A refused loopback connect fails in a few ms there.
 */
export const portInUse: PortInUse = async (port) => {
  const connecting = Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } });
  const timeout = Bun.sleep(PROBE_TIMEOUT_MS).then(() => null);
  try {
    const socket = await Promise.race([connecting, timeout]);
    if (!socket) {
      // No answer at all (filtered): nobody we could be confused with. Close it if it lands late.
      connecting.then((s) => s.end(), () => {});
      return false;
    }
    socket.end();
    return true;
  } catch {
    return false; // refused: free
  }
};

// Go binaries read LIVEKIT_*/TUNNEL_* as flags; the others are telinha's own secrets.
const PRIVATE_PREFIX = /^(LIVEKIT_|TUNNEL_|DISCORD_|TELINHA_)/;

/**
 * The environment every child starts from: process.env minus telinha's keys.
 * Compared upper-cased because Windows (and Go's os.Getenv there) ignores case.
 */
export function childBaseEnv(processEnv: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(processEnv)) {
    const key = k.toUpperCase();
    if (v === undefined || KNOWN_KEYS.has(key) || PRIVATE_PREFIX.test(key)) continue;
    out[k] = v;
  }
  return out;
}

export function childSpecs(
  config: Config, paths: Paths, findBinary: FindBinary = defaultFindBinary, inUse: PortInUse = portInUse,
): ChildSpec[] {
  // tool = the bins.ts name that downloads it
  const bin = (name: string, tool: string) => {
    const found = findBinary(name, paths);
    if (!found) throw new Error(`${name} not found: put it in ${paths.bin} (bun scripts/bins.ts ${tool}) or on PATH`);
    return found;
  };
  const specs: ChildSpec[] = [];

  if (config.media === 'self') {
    const file = join(paths.run, 'livekit.yaml');
    specs.push({
      name: 'livekit',
      cmd: [bin('livekit-server', 'livekit'), '--config', file],
      env: { LIVEKIT_KEYS: `${config.livekitKey}: ${config.livekitSecret}` },
      // Rewritten on every (re)start, so a config reload is just restart().
      prepare: async () => {
        // Runs after our own previous livekit exited, so a listener here is someone
        // else's (an old tela stack, an orphan, a second telinha): it would answer
        // the ready probe while ours fails to bind, and telinha would use the wrong SFU.
        for (const [key, port] of [['LIVEKIT_PORT', config.livekitPort], ['MEDIA_TCP_PORT', config.mediaTcpPort]] as const) {
          if (await inUse(port)) throw new Error(`port ${port} (${key}) already in use (another LiveKit?)`);
        }
        await mkdir(paths.run, { recursive: true });
        await writeFile(file, renderLivekitYaml(config));
      },
      ready: { url: `http://127.0.0.1:${config.livekitPort}/`, timeoutMs: 30_000 },
    });
  }

  if (config.ingress === 'direct') {
    const file = join(paths.run, 'Caddyfile');
    const storage = join(paths.data, 'caddy');
    specs.push({
      name: 'caddy',
      cmd: [bin('caddy', 'caddy'), 'run', '--config', file, '--adapter', 'caddyfile'],
      // Certificates must survive restarts and live on the data volume.
      env: {
        XDG_DATA_HOME: storage, XDG_CONFIG_HOME: storage, HOME: storage,
        ...(config.acmeDns ? { DUCKDNS_TOKEN: config.acmeDns.token } : {}),
      },
      // Caddy's failed DNS challenges log the DuckDNS URL, token included.
      ...(config.acmeDns ? { redact: [config.acmeDns.token] } : {}),
      prepare: async () => {
        await mkdir(paths.run, { recursive: true });
        await mkdir(storage, { recursive: true });
        await writeFile(file, renderCaddyfile(config));
      },
    });
  } else if (config.ingress === 'tunnel') {
    specs.push({
      name: 'cloudflared',
      // cloudflared reads TUNNEL_TOKEN itself; never --token (argv is public).
      cmd: [bin('cloudflared', 'cloudflared'), 'tunnel', '--no-autoupdate', 'run'],
      env: { TUNNEL_TOKEN: config.tunnelToken ?? '' },
    });
  }

  return specs;
}
