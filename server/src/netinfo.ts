// Network facts for setup, doctor and the DDNS loop: the public IP as the
// internet sees it, A records, the certificate a host serves, open TCP ports.
import { promises as dns } from 'node:dns';
import { connect as netConnect } from 'node:net';
import { checkServerIdentity, type PeerCertificate, connect as tlsConnect } from 'node:tls';
import { IPV4_RE } from './config.ts';

const SOURCES: { url: string; parse: (body: string) => string }[] = [
  { url: 'https://1.1.1.1/cdn-cgi/trace', parse: (b) => /^ip=(.*)$/m.exec(b)?.[1]?.trim() ?? '' },
  { url: 'https://api.ipify.org', parse: (b) => b.trim() },
];

/** First source that answers with an IPv4 address; throws with every source's error. */
export async function lookupPublicIp(fetch: typeof globalThis.fetch, timeoutMs = 10_000): Promise<string> {
  const errors: string[] = [];
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const found = s.parse(await res.text());
      if (!IPV4_RE.test(found)) throw new Error(`not an IPv4 address: ${found.slice(0, 40)}`);
      return found;
    } catch (e) {
      errors.push(`${new URL(s.url).host}: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.join('; '));
}

/**
 * A records via public resolvers first: the system resolver may be a router
 * that caches a stale record or answers a split-horizon LAN address.
 */
export async function resolveA(host: string, servers: string[] = ['1.1.1.1', '8.8.8.8']): Promise<string[]> {
  if (IPV4_RE.test(host)) return [host];
  if (servers.length) {
    try {
      const r = new dns.Resolver({ timeout: 3000, tries: 2 });
      r.setServers(servers);
      const ips = await r.resolve4(host);
      if (ips.length) return ips;
    } catch {
      // UDP 53 to the internet may be blocked; the system resolver still works.
    }
  }
  const found = await dns.lookup(host, { family: 4, all: true });
  return found.map((a) => a.address);
}

export interface TlsInfo {
  /** ms since the epoch; 0 when no certificate was received. */
  validTo: number;
  issuer: string;
  subjectAltNames: string[];
  /** Chain trusted by the system store and the name matches host. */
  authorized: boolean;
  error?: string;
}

/** Never throws: a failed handshake comes back as authorized false with the error. */
/** `connectTo`: the address to dial instead of `host` (setup asks the local Caddy for `host`'s certificate). */
export function tlsInfo(host: string, port: number, timeoutMs = 10_000, connectTo?: string): Promise<TlsInfo> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (info: TlsInfo) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(info);
    };
    const fail = (error: string): TlsInfo => ({
      validTo: 0,
      issuer: '',
      subjectAltNames: [],
      authorized: false,
      error,
    });
    // rejectUnauthorized off so an untrusted chain is still described, not just refused.
    const socket = tlsConnect({
      host: connectTo ?? host,
      port,
      servername: IPV4_RE.test(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => finish(fail(`timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate() as PeerCertificate | undefined;
      if (!cert || !cert.valid_to) return finish(fail('no certificate'));
      const nameError = checkServerIdentity(host, cert);
      const chainError = socket.authorized ? undefined : String(socket.authorizationError ?? 'untrusted certificate');
      const error = chainError ?? nameError?.message;
      finish({
        validTo: Date.parse(cert.valid_to),
        issuer: first(cert.issuer?.O) ?? first(cert.issuer?.CN) ?? '',
        subjectAltNames: parseAltNames(cert.subjectaltname),
        authorized: !error,
        ...(error ? { error } : {}),
      });
    });
    socket.once('error', (e) => finish(fail(e.message)));
  });
}

// Certificate subject fields are arrays when the attribute repeats.
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** "DNS:a.example, DNS:b.example, IP Address:1.2.3.4" -> ['a.example', 'b.example', '1.2.3.4'] */
export function parseAltNames(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(',')
    .map((p) => p.trim().replace(/^(DNS|IP Address):/, ''))
    .filter(Boolean);
}

function octets(ip: string): number[] | null {
  return IPV4_RE.test(ip) ? ip.split('.').map(Number) : null;
}

/** RFC 1918 (10/8, 172.16/12, 192.168/16): an address behind another NAT. */
export function isPrivateIpv4(ip: string): boolean {
  const o = octets(ip);
  if (!o) return false;
  const [a, b] = o as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 100.64.0.0/10, the shared space carriers use for CGNAT (RFC 6598). */
export function isCgnatIpv4(ip: string): boolean {
  const o = octets(ip);
  if (!o) return false;
  const [a, b] = o as [number, number];
  return a === 100 && b >= 64 && b <= 127;
}

/** true when something accepts a TCP connection on host:port within timeoutMs. */
export function tcpOpen(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const finish = (open: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
