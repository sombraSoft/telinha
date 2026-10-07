// The default gateway and the local IPv4 that reaches it: where PCP/NAT-PMP
// requests go and what UPnP is told as the mapping's internal client.
import { readFile } from 'node:fs/promises';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';

export interface DefaultRoute {
  gatewayIp: string;
  localIp: string;
}
type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ROUTE_PRINT_TIMEOUT_MS = 3000;

export function ipv4ToInt(ip: string): number | null {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/**
 * /proc/net/route: the up (flag 0x1) gateway (0x2) route with destination and
 * mask 0, lowest metric. Addresses are hex in host (little-endian) byte order:
 * 0100A8C0 = 192.168.0.1.
 */
export function parseProcNetRoute(text: string): { iface: string; gatewayIp: string } | null {
  let best: { iface: string; gatewayIp: string; metric: number } | null = null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [iface, dest, gw, flagsHex, , , metricStr, mask] = f as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (dest !== '00000000' || mask !== '00000000' || !/^[0-9A-Fa-f]{8}$/.test(gw)) continue;
    const flags = parseInt(flagsHex, 16);
    if ((flags & 0x3) !== 0x3) continue;
    const gatewayIp = [6, 4, 2, 0].map((i) => parseInt(gw.slice(i, i + 2), 16)).join('.');
    if (gatewayIp === '0.0.0.0') continue;
    const metric = Number(metricStr) || 0;
    if (!best || metric < best.metric) best = { iface, gatewayIp, metric };
  }
  return best && { iface: best.iface, gatewayIp: best.gatewayIp };
}

/**
 * `route print -4`: rows `0.0.0.0 0.0.0.0 <gateway> <interface IP> <metric>`.
 * Headers are localized ("Network Destination", "Destino de Rede", ...) but the
 * numeric rows are not, so only those are read. "Persistent Routes" rows end in
 * a word ("Default", "Padrão") and do not match.
 */
export function parseRoutePrint(text: string): DefaultRoute | null {
  const row = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s*$/gm;
  let best: (DefaultRoute & { metric: number }) | null = null;
  for (const m of text.matchAll(row)) {
    const metric = Number(m[3]);
    if (!best || metric < best.metric) best = { gatewayIp: m[1]!, localIp: m[2]!, metric };
  }
  return best && { gatewayIp: best.gatewayIp, localIp: best.localIp };
}

const isV4 = (a: NetworkInterfaceInfo) => (a.family === 'IPv4' || (a.family as unknown) === 4) && !a.internal;

/**
 * The local IPv4 that talks to `gatewayIp`: the named interface's address when
 * given, else the interface whose subnet contains the gateway, else the first
 * non-loopback IPv4.
 */
export function localIpFor(gatewayIp: string, ifaces: Interfaces = networkInterfaces(), iface?: string): string | null {
  const gw = ipv4ToInt(gatewayIp);
  const inSubnet = (a: NetworkInterfaceInfo) => {
    const ip = ipv4ToInt(a.address);
    const mask = ipv4ToInt(a.netmask);
    return gw !== null && ip !== null && mask !== null && (ip & mask) >>> 0 === (gw & mask) >>> 0;
  };
  if (iface) {
    const own = (ifaces[iface] ?? []).filter(isV4);
    const hit = own.find(inSubnet) ?? own[0];
    if (hit) return hit.address;
  }
  const all = Object.values(ifaces).flatMap((l) => (l ?? []).filter(isV4));
  return (all.find(inSubnet) ?? all[0])?.address ?? null;
}

async function routePrint(): Promise<string> {
  const proc = Bun.spawn(['route', 'print', '-4'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => proc.kill(), ROUTE_PRINT_TIMEOUT_MS);
  try {
    return await new Response(proc.stdout).text();
  } finally {
    clearTimeout(timer);
  }
}

/** Never throws: null when there is no default route or it cannot be read. */
export async function defaultRoute(
  o: {
    platform?: NodeJS.Platform;
    readProcRoute?: () => Promise<string>;
    routePrint?: () => Promise<string>;
    interfaces?: () => Interfaces;
  } = {},
): Promise<DefaultRoute | null> {
  const platform = o.platform ?? process.platform;
  const ifaces = () => {
    try {
      return (o.interfaces ?? networkInterfaces)();
    } catch {
      return {};
    }
  };
  try {
    if (platform === 'win32') {
      const r = parseRoutePrint(await (o.routePrint ?? routePrint)());
      if (!r || ipv4ToInt(r.gatewayIp) === null) return null;
      if (ipv4ToInt(r.localIp) !== null) return r;
      const localIp = localIpFor(r.gatewayIp, ifaces());
      return localIp ? { gatewayIp: r.gatewayIp, localIp } : null;
    }
    const r = parseProcNetRoute(await (o.readProcRoute ?? (() => readFile('/proc/net/route', 'utf8')))());
    if (!r) return null;
    const localIp = localIpFor(r.gatewayIp, ifaces(), r.iface);
    return localIp ? { gatewayIp: r.gatewayIp, localIp } : null;
  } catch {
    return null;
  }
}
