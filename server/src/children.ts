// The child process of each helper the footprint names, as data for the supervisor.
// Secrets reach a child only through its own env, never argv (world-readable in
// ps/tasklist and printed in the "spawning" log line) and never a rendered file.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KNOWN_KEYS, type Config } from './config.ts';
import { footprintOf } from './footprint.ts';
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
  // Every helper the footprint names; bins.ts downloads each under its name.
  return footprintOf(config).helpers.map((h): ChildSpec => {
    const found = findBinary(h.binary, paths);
    if (!found) throw new Error(`${h.binary} not found: put it in ${paths.bin} (bun scripts/bins.ts ${h.name}) or on PATH`);
    switch (h.name) {
      case 'livekit': {
        const file = join(paths.run, 'livekit.yaml');
        return {
          name: 'livekit',
          cmd: [found, '--config', file],
          env: { LIVEKIT_KEYS: `${config.livekitKey}: ${config.livekitSecret}` },
          // Rewritten on every (re)start, so a config reload is just restart().
          prepare: async () => {
            // Runs after our own previous livekit exited, so a listener here is someone
            // else's (an old tela stack, an orphan, a second telinha): it would answer
            // the ready probe while ours fails to bind, and telinha would use the wrong SFU.
            // A taken TURN_PORT means a second TURN would answer Caddy's forwarded streams.
            // A connect probes TCP only.
            for (const { key, port } of h.ports.filter((p) => p.protocol === 'tcp')) {
              if (await inUse(port)) throw new Error(`port ${port} (${key}) already in use (another LiveKit?)`);
            }
            await mkdir(paths.run, { recursive: true });
            await writeFile(file, renderLivekitYaml(config));
          },
          ready: { url: `http://127.0.0.1:${config.livekitPort}/`, timeoutMs: 30_000 },
        };
      }
      case 'caddy': {
        const file = join(paths.run, 'Caddyfile');
        const storage = join(paths.data, 'caddy');
        return {
          name: 'caddy',
          cmd: [found, 'run', '--config', file, '--adapter', 'caddyfile'],
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
        };
      }
      case 'cloudflared':
        return {
          name: 'cloudflared',
          // cloudflared reads TUNNEL_TOKEN itself; never --token (argv is public).
          cmd: [found, 'tunnel', '--no-autoupdate', 'run'],
          env: { TUNNEL_TOKEN: config.tunnelToken ?? '' },
        };
    }
  });
}
