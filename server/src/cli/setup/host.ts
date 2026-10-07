// What kind of machine setup runs on: OS, privileges, Docker, the public IP
// and whether a router answers UPnP/NAT-PMP/PCP. Shown once, then used to
// pick defaults (home vs VPS) and which steps apply.
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import type { Hosting } from '../../config.ts';
import type { NatProbe } from '../../nat/index.ts';
import type { Values } from './steps.ts';

export type { Hosting };
export type HostKind = 'windows' | 'linux-root' | 'linux-user' | 'docker';

export interface HostInfo {
  kind: HostKind;
  platform: NodeJS.Platform;
  arch: string;
  isRoot: boolean;
  docker: boolean;
  /** "Windows 11", "Debian GNU/Linux 12 (bookworm)" */
  osName: string;
  publicIp: string | null;
  /** null inside Docker (the bridge's gateway is not the router) or when not probed. */
  nat: NatProbe | null;
}

export interface HostDeps {
  platform: NodeJS.Platform;
  arch: string;
  isRoot: boolean;
  env: Record<string, string | undefined>;
  /** --docker given. */
  dockerFlag: boolean;
  exists: (path: string) => boolean;
  osName: () => string;
  lookupPublicIp: () => Promise<string>;
  probe: () => Promise<NatProbe>;
}

export function isDocker(o: Pick<HostDeps, 'platform' | 'env' | 'dockerFlag' | 'exists'>): boolean {
  return o.dockerFlag || o.env.TELINHA_HOME === '/telinha' || (o.platform === 'linux' && o.exists('/.dockerenv'));
}

export async function detectHost(d: HostDeps): Promise<HostInfo> {
  const docker = isDocker(d);
  const kind: HostKind = docker ? 'docker' : d.platform === 'win32' ? 'windows' : d.isRoot ? 'linux-root' : 'linux-user';
  // Both lookups at once: each may take its whole budget offline.
  const [publicIp, nat] = await Promise.all([
    d.lookupPublicIp().catch(() => null),
    docker ? Promise.resolve(null) : d.probe().catch(() => null),
  ]);
  return { kind, platform: d.platform, arch: d.arch, isRoot: d.isRoot, docker, osName: d.osName(), publicIp, nat };
}

/** Windows 11 still reports "10.0" as its version; the build number tells them apart. */
export function defaultOsName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const build = Number(release().split('.')[2] ?? 0);
    return build >= 22000 ? 'Windows 11' : 'Windows 10';
  }
  if (platform === 'linux') {
    try {
      const m = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'));
      if (m?.[1]) return m[1];
    } catch {
      // no os-release (minimal image)
    }
    return 'Linux';
  }
  return platform;
}

/** The router's name for display: friendlyName, else the protocol. */
export function routerLabel(nat: NatProbe): string | null {
  const g = nat.gateway;
  if (!g) return null;
  if (g.kind === 'igd') return `${g.name ? `${g.name} ` : ''}(UPnP IGD v${g.version}, ${g.gatewayIp})`;
  return `${g.kind === 'pcp' ? 'PCP' : 'NAT-PMP'} (${g.gatewayIp})`;
}

/** A PUBLIC_URL on sslip.io: the name is made from a VPS's own IP. */
export const SSLIP_RE = /\.sslip\.io(:\d+)?\/?$/;

/**
 * A first guess for "where will Telinha run" (the user confirms it): home,
 * unless the public IP sits on this machine's own interface, which only a
 * server with an address of its own has. A router answering, a private
 * address of any range (a cloud behind 1:1 NAT included), Docker or no probe
 * at all all mean home: someone at home who presses Enter must never land on
 * the server list, while a server behind 1:1 NAT just picks the second option.
 */
export function guessHosting(h: HostInfo): Hosting {
  const local = h.nat?.localIp;
  return local && local === h.publicIp ? 'vps' : 'home';
}

/** Where Telinha runs as a re-run (or a scripted run) sees it: the file's answer, else its VPS-only keys, else the machine. */
export function inferHosting(values: Values, host: HostInfo): Hosting {
  if (values.HOSTING === 'home' || values.HOSTING === 'vps') return values.HOSTING;
  // A pinned node IP or an sslip.io name only ever come from the VPS list.
  if (values.LIVEKIT_NODE_IP || SSLIP_RE.test(values.PUBLIC_URL ?? '')) return 'vps';
  return guessHosting(host);
}
