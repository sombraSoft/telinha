// SSDP discovery of UPnP Internet Gateway Devices and the parts of their
// device description we need (the WAN connection service's control URL).
import { ipv4ToInt } from './gateway.ts';
import type { UdpFactory } from './index.ts';

export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;
export const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'upnp:rootdevice',
];
/** In preference order: the first one a device offers is the one we drive. */
export const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const RESEND_AFTER_MS = 300;
const DESCRIPTION_MAX_BYTES = 256 * 1024;
const DESCRIPTION_TIMEOUT_MS = 3000;

export interface SsdpReply {
  location: string;
  st: string;
  usn: string;
  address: string;
}

// --- a tiny XML reader: element names without namespace prefixes, text content.

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (all, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e] ?? all;
  });
}

export function escapeXml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' } as Record<string, string>)[c]};`,
  );
}

/** Lenient: unbalanced or stray close tags never throw, they just end the nearest open element of that name. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '', children: [], text: '' };
  const stack = [root];
  const src = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => escapeXml(t))
    .replace(/<[?!][^>]*>/g, '');
  const token = /<(\/?)([^\s>/]+)[^>]*?(\/?)>|([^<]+)/g;
  for (const m of src.matchAll(token)) {
    const top = stack[stack.length - 1]!;
    if (m[4] !== undefined) {
      top.text += decodeEntities(m[4]);
      continue;
    }
    const name = m[2]!.replace(/^.*:/, '');
    if (m[1]) {
      const at = stack.findLastIndex((n, i) => i > 0 && n.name.toLowerCase() === name.toLowerCase());
      if (at > 0) stack.length = at;
      continue;
    }
    const node: XmlNode = { name, children: [], text: '' };
    top.children.push(node);
    if (!m[3]) stack.push(node);
  }
  return root;
}

/** Descendants named `name` (case-insensitive), document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  const want = name.toLowerCase();
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (c.name.toLowerCase() === want) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

export function childText(node: XmlNode | undefined, name: string): string {
  const want = name.toLowerCase();
  return node?.children.find((c) => c.name.toLowerCase() === want)?.text.trim() ?? '';
}

// --- SSDP

export function searchMessage(st: string): string {
  return `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
}

export function parseSsdpReply(text: string): { location: string; st: string; usn: string } | null {
  const lines = text.split(/\r?\n/);
  if (!/^HTTP\/1\.[01]\s+200\b/i.test(lines[0] ?? '')) return null;
  const h: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  if (!h.location) return null;
  return { location: h.location, st: h.st ?? '', usn: h.usn ?? '' };
}

const isPrivate = (ip: string) => {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return n >>> 24 === 10 || n >>> 20 === 0xac1 || n >>> 16 === 0xc0a8 || n >>> 16 === 0xa9fe;
};

/**
 * Only plain LAN URLs are fetched: anyone on the LAN can answer an M-SEARCH,
 * and the location must not steer us at hosts outside it.
 */
export function acceptableLocation(location: string, from: string): boolean {
  try {
    const u = new URL(location);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === from || isPrivate(u.hostname);
  } catch {
    return false;
  }
}

/**
 * M-SEARCH for every target, sent twice 300 ms apart, collecting unicast
 * replies for `timeoutMs`. Replies are deduplicated by location; `onReply`
 * sees each new one as it arrives (description fetches can start early).
 */
export async function ssdpSearch(o: {
  udp: UdpFactory;
  sleep: (ms: number) => Promise<void>;
  localIp?: string | null;
  timeoutMs?: number;
  onReply?: (r: SsdpReply) => void;
}): Promise<SsdpReply[]> {
  const timeoutMs = o.timeoutMs ?? 2500;
  const found = new Map<string, SsdpReply>();
  const socket = await o.udp({
    multicastInterface: o.localIp ?? null,
    onMessage(data, _port, address) {
      const r = parseSsdpReply(new TextDecoder().decode(data));
      if (!r || found.has(r.location) || !acceptableLocation(r.location, address)) return;
      const reply = { ...r, address };
      found.set(r.location, reply);
      o.onReply?.(reply);
    },
  });
  try {
    const sendAll = () => {
      for (const st of SEARCH_TARGETS) {
        try {
          socket.send(searchMessage(st), SSDP_PORT, SSDP_ADDRESS);
        } catch {
          /* no route for multicast on this interface: nothing will answer */
        }
      }
    };
    sendAll();
    await o.sleep(Math.min(RESEND_AFTER_MS, timeoutMs));
    sendAll();
    await o.sleep(Math.max(0, timeoutMs - RESEND_AFTER_MS));
  } finally {
    socket.close();
  }
  return [...found.values()];
}

// --- device description

export interface IgdService {
  controlUrl: string;
  serviceType: string;
  version: 1 | 2;
  name?: string;
}

export function parseDeviceDescription(xml: string, location: string): IgdService | null {
  const tree = parseXml(xml);
  const services = findAll(tree, 'service').map((s) => ({
    type: childText(s, 'serviceType'),
    control: childText(s, 'controlURL'),
  }));
  let pick: { type: string; control: string } | undefined;
  for (const want of WAN_SERVICES) {
    pick = services.find((s) => s.type === want && s.control);
    if (pick) break;
  }
  if (!pick) return null;
  const base = findAll(tree, 'URLBase')[0]?.text.trim() || location;
  let controlUrl: string;
  try {
    controlUrl = new URL(pick.control, new URL(base, location)).href;
  } catch {
    return null;
  }
  const rootDevice = findAll(tree, 'device')[0];
  const igdVersion = /InternetGatewayDevice:(\d+)/.exec(childText(rootDevice, 'deviceType'))?.[1];
  const version = (igdVersion ?? pick.type.slice(-1)) === '2' ? 2 : 1;
  const name = childText(rootDevice, 'friendlyName') || undefined;
  return { controlUrl, serviceType: pick.type, version, ...(name ? { name } : {}) };
}

export async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (Number(res.headers.get('content-length')) > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Fetches and parses one device description; throws with a readable reason. */
export async function fetchIgdService(fetch: typeof globalThis.fetch, location: string): Promise<IgdService> {
  const res = await fetch(location, { signal: AbortSignal.timeout(DESCRIPTION_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const service = parseDeviceDescription(await readLimited(res, DESCRIPTION_MAX_BYTES), location);
  if (!service) throw new Error('no WANIPConnection/WANPPPConnection service');
  return service;
}
