// What kind of machine setup runs on: OS, privileges, Docker, the public IP
// and whether a router answers UPnP/NAT-PMP/PCP. Shown once, then used to
// pick defaults (home vs VPS) and which steps apply.
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import type { NatProbe } from '../../nat/index.ts';

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

/**
 * A good first guess for "where does Telinha run" (the user confirms it): a
 * router that answers means home; the public IP on the interface means a VPS.
 * With a private address and no router answering, 192.168.x is the home
 * routers' range, while clouds with 1:1 NAT (AWS 172.31.x, GCP 10.128.x,
 * Oracle and Azure 10.0.x) hand out 10.x and 172.16-31.x.
 */
export function guessTarget(h: HostInfo): 'home' | 'vps' {
  if (h.nat?.gateway) return 'home';
  const local = h.nat?.localIp;
  if (!local) return 'home';
  if (local === h.publicIp) return 'vps';
  return /^192\.168\./.test(local) ? 'home' : 'vps';
}
