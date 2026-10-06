// The address: how people reach Telinha and how HTTPS gets there. The
// parsers and the re-run defaults the setup questions (model.ts) and the
// flags (resolve.ts) share: at home a Cloudflare Tunnel or a free DuckDNS name
// with HTTPS on a high port (the certificate through the DuckDNS API: nothing
// to open on 80/443), 80/443 or an own proxy only on request; on a VPS an own
// domain, DuckDNS or sslip.io on 80/443, a Cloudflare Tunnel or an own proxy.
import { IPV4_RE } from '../../config.ts';
import { SSLIP_RE } from './host.ts';
import type { Values } from './steps.ts';

export type AddressChoice = 'tunnel' | 'duckdns-home' | 'domain' | 'duckdns' | 'sslip' | 'external';
/** The VPS list (the advanced home list is its first two entries). */
export type IngressChoice = 'domain' | 'duckdns' | 'sslip' | 'tunnel' | 'external';

/** The home HTTPS port when nothing else is known. */
export const DEFAULT_HOME_HTTPS_PORT = '8443';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const DUCK_RE = /^[a-z0-9-]{1,63}$/;

/** "https://Host.example.com:443/x" or "host.example.com" -> "host.example.com"; null when not a hostname. */
export function parseHost(input: string): string | null {
  const bare = input.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
  return HOST_RE.test(bare) && !IPV4_RE.test(bare) ? bare : null;
}

/** The DuckDNS subdomain alone: "Name.duckdns.org" -> "name". */
export function parseDuckDomain(input: string): string | null {
  const bare = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.duckdns\.org\.?$/, '');
  return DUCK_RE.test(bare) ? bare : null;
}

export const sslipHost = (ip: string): string => `${ip.replace(/\./g, '-')}.sslip.io`;

/** A Cloudflare tunnel token: base64 of {"a": account, "t": tunnel id, "s": secret}. */
export function validTunnelToken(token: string): boolean {
  if (!/^eyJ[A-Za-z0-9+/_=-]+$/.test(token)) return false;
  try {
    const j = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Record<string, unknown>;
    return typeof j.a === 'string' && typeof j.t === 'string' && typeof j.s === 'string';
  } catch {
    return false;
  }
}

/**
 * The token alone from what was pasted: Cloudflare shows it only inside an
 * install command (`cloudflared service install eyJ...`), whose copy button
 * copies the whole line. Text without an eyJ... run comes back trimmed.
 */
export function extractTunnelToken(input: string): string {
  return /eyJ[A-Za-z0-9+/_=-]+/.exec(input)?.[0] ?? input.trim();
}

/** Which VPS answer the current file corresponds to (re-run defaults). */
export function currentChoice(values: Values): IngressChoice {
  if (values.INGRESS === 'tunnel') return 'tunnel';
  if (values.INGRESS === 'external') return 'external';
  if (values.DDNS_PROVIDER === 'duckdns') return 'duckdns';
  if (SSLIP_RE.test(values.PUBLIC_URL ?? '')) return 'sslip';
  return 'domain';
}

/** Advanced is only ever the default when this very file already is an advanced home setup. */
export function homeChoice(values: Values): 'yes' | 'no' | 'advanced' {
  if (values.INGRESS === 'tunnel') return 'yes';
  if (values.HOSTING !== 'home') return 'no'; // fresh install, or a VPS file re-run as home
  if (values.INGRESS === 'external') return 'advanced';
  if (values.INGRESS === 'direct' && values.ACME_DNS !== 'duckdns') return 'advanced';
  return 'no'; // DuckDNS high port, or INGRESS unset
}

/** The LISTEN port cloudflared or a proxy must forward to. */
export function listenPort(values: Values): number {
  const m = /:(\d+)$/.exec(values.LISTEN ?? '');
  return m ? Number(m[1]) : 8081;
}

/**
 * The key of Telinha's own port already on `port`, or null. LISTEN and
 * LIVEKIT_PORT are not setup keys, so this sees their defaults; a custom one
 * still trips loadConfig's collision check before the file is written. The
 * media ports are asked after the HTTPS port and only checked when changed,
 * so their current values (defaults 7881/7882) are refused here, not at the write.
 */
export function takenPort(values: Values, port: number): string | null {
  if (port === listenPort(values)) return 'LISTEN';
  if (port === Number(values.LIVEKIT_PORT || 7880)) return 'LIVEKIT_PORT';
  if (port === Number(values.MEDIA_TCP_PORT || 7881)) return 'MEDIA_TCP_PORT';
  if (port === Number(values.MEDIA_UDP_PORT || 7882)) return 'MEDIA_UDP_PORT';
  return null;
}
