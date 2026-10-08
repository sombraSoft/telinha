// What an install puts on its machine for one media mode, ingress mode and
// TURN: the helpers it runs, the ports they and telinha bind, and the exposures
// the firewall and the router must let in. Pure data; children, bins, the
// firewall, the router mappings, the doctor and run read it instead of
// branching on MEDIA/INGRESS/TURN themselves, so a new mode changes this file.
// bins.ts imports it, so it imports types only (see bins.ts on the image).
import type { Helper } from './bins.ts';
import type { Config } from './config.ts';

/** publicUrl is optional so a telinha.env that does not load yet still has a footprint (service/firewall.ts). */
export type FootprintInput = Pick<
  Config,
  | 'media'
  | 'ingress'
  | 'turn'
  | 'port'
  | 'livekitPort'
  | 'mediaTcpPort'
  | 'mediaUdpPort'
  | 'httpsPort'
  | 'httpPort'
  | 'ipWatchSeconds'
  | 'livekitNodeIp'
> &
  Partial<Pick<Config, 'publicUrl'>>;

/** The ports an exposure can name; the firewall and router adapters key their names on these. */
export type ExposedKey = 'MEDIA_TCP_PORT' | 'MEDIA_UDP_PORT' | 'HTTPS_PORT' | 'HTTP_PORT';
/** The env key that sets each port, as loadConfig's errors name it. */
export type PortKey = ExposedKey | 'LISTEN' | 'LIVEKIT_PORT' | 'TURN_PORT';
export type Protocol = 'tcp' | 'udp';

export interface BoundPort {
  key: PortKey;
  protocol: Protocol;
  port: number;
}

export interface HelperRun {
  name: Helper;
  /** The program's file name, without .exe. */
  binary: string;
  ports: BoundPort[];
}

export interface Exposure {
  helper: Helper;
  key: ExposedKey;
  protocol: Protocol;
  /** The port the helper binds. */
  port: number;
  /** The port the outside dials when the router translates it; absent = port. */
  externalPort?: number;
}

export interface Footprint {
  /** In start order. */
  helpers: HelperRun[];
  /** Everything bound here, telinha's LISTEN included; no two may share a number. */
  ports: BoundPort[];
  exposures: Exposure[];
  /** Telinha runs the signaling proxy at /livekit (Cloud: browsers dial LiveKit Cloud). */
  signalingProxy: boolean;
  /** Watch the public IP: LiveKit, the router mappings and DuckDNS follow it. */
  ipWatch: boolean;
}

const BINARY: Record<Helper, string> = { livekit: 'livekit-server', caddy: 'caddy', cloudflared: 'cloudflared' };

/** The helpers alone, for callers that know only the modes (setup, the downloads). */
export function helpersOf(c: Pick<Config, 'media' | 'ingress'>): Helper[] {
  const out: Helper[] = [];
  if (c.media === 'self') out.push('livekit');
  if (c.ingress === 'direct') out.push('caddy');
  if (c.ingress === 'tunnel') out.push('cloudflared');
  return out;
}

export function footprintOf(c: FootprintInput): Footprint {
  const tcp = <K extends PortKey>(key: K, port: number) => ({ key, protocol: 'tcp' as const, port });
  const listen = tcp('LISTEN', c.port);
  const signaling = tcp('LIVEKIT_PORT', c.livekitPort);
  const mediaTcp = tcp('MEDIA_TCP_PORT', c.mediaTcpPort);
  const mediaUdp = { key: 'MEDIA_UDP_PORT' as const, protocol: 'udp' as const, port: c.mediaUdpPort };
  // LiveKit's TURN listens on loopback only; Caddy reaches it through 443.
  const turn = c.media === 'self' && c.turn ? [tcp('TURN_PORT', c.turn.port)] : [];
  const https = tcp('HTTPS_PORT', c.httpsPort);
  // 0 = no redirect listener.
  const http = c.httpPort !== 0 ? [tcp('HTTP_PORT', c.httpPort)] : [];

  const bound: Record<Helper, BoundPort[]> = {
    livekit: [signaling, mediaTcp, mediaUdp, ...turn],
    caddy: [https, ...http],
    cloudflared: [],
  };
  const exposed: Record<Helper, Exposure[]> = {
    livekit: [
      { helper: 'livekit', ...mediaTcp },
      { helper: 'livekit', ...mediaUdp },
    ],
    caddy: [
      // PUBLIC_URL's port reaches HTTPS_PORT (a router may translate 443 -> 8443).
      { helper: 'caddy', ...https, ...(c.publicUrl ? { externalPort: Number(new URL(c.publicUrl).port || 443) } : {}) },
      ...http.map((p) => ({ helper: 'caddy' as const, ...p, externalPort: 80 })),
    ],
    cloudflared: [],
  };
  const names = helpersOf(c);
  const runs = (h: Helper) => names.includes(h);
  return {
    helpers: names.map((name) => ({ name, binary: BINARY[name], ports: bound[name] })),
    // This order picks the pair loadConfig's "ports collide" error names.
    ports: [
      ...(runs('livekit') ? [mediaTcp, mediaUdp, signaling] : []),
      listen,
      ...(runs('caddy') ? bound.caddy : []),
      ...turn,
    ],
    exposures: names.flatMap((name) => exposed[name]),
    signalingProxy: runs('livekit'),
    // A static IP never changes.
    ipWatch: c.ipWatchSeconds > 0 && !c.livekitNodeIp,
  };
}
