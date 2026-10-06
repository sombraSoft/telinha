// "How will people reach Telinha?": the ingress mode, the public hostname and
// the HTTP ports. Own domain, DuckDNS (validated live), sslip.io on a VPS with
// a static IP, a Cloudflare Tunnel (any machine) or the user's own proxy.
import { IPV4_RE } from '../../config.ts';
import { askSecret, type Values, type Wizard } from './steps.ts';

export type Target = 'home' | 'vps' | 'cloudflare';
export type IngressChoice = 'domain' | 'duckdns' | 'sslip' | 'tunnel' | 'external';
type Ports = 'both' | 'other' | 'neither';

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

/** Which answer the current file corresponds to (re-run defaults). */
export function currentChoice(values: Values): IngressChoice {
  if (values.INGRESS === 'tunnel') return 'tunnel';
  if (values.INGRESS === 'external') return 'external';
  if (values.DDNS_PROVIDER === 'duckdns') return 'duckdns';
  if (/\.sslip\.io(:\d+)?\/?$/.test(values.PUBLIC_URL ?? '')) return 'sslip';
  return 'domain';
}

const hostOf = (url: string | undefined): string => {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};

/** The LISTEN port cloudflared or a proxy must forward to. */
export function listenPort(values: Values): number {
  const m = /:(\d+)$/.exec(values.LISTEN ?? '');
  return m ? Number(m[1]) : 8081;
}

async function askPorts(w: Wizard, values: Values): Promise<Ports> {
  const { term, s } = w;
  for (const l of s('portsHelp').split('\n')) term.info(l);
  // Not knowing UPnP, "no" would push a home user to a Cloudflare Tunnel (and a domain there).
  if (w.host.nat?.gateway) term.info(s('portsRouterHint'));
  const translated = values.HTTPS_PORT && values.HTTPS_PORT !== '443';
  const ports = await term.select<Ports>(s('portsQ'), [
    { value: 'both', label: s('portsBoth') },
    { value: 'other', label: s('portsOther') },
    { value: 'neither', label: s('portsNeither') },
  ], translated ? 1 : 0, { id: 'ports' });
  if (ports === 'both') {
    values.HTTP_PORT = '80';
    values.HTTPS_PORT = '443';
  } else if (ports === 'other') {
    for (const l of s('portsOtherHelp').split('\n')) term.info(l);
    values.HTTPS_PORT = await term.text(s('portsInternalQ'), {
      default: translated ? values.HTTPS_PORT : '8443',
      id: 'https-port',
      validate: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : s('portBad')),
    });
    values.HTTP_PORT = '0';
  }
  return ports;
}

async function askOwnDomain(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  const previous = currentChoice(values) === 'domain' ? hostOf(values.PUBLIC_URL) : '';
  const host = parseHost(await term.text(s('domainQ'), {
    default: previous || undefined,
    required: true,
    id: 'public-url',
    validate: (v) => (parseHost(v) ? null : s('hostBad')),
  }))!;
  values.PUBLIC_URL = `https://${host}`;
  const ip = w.host.publicIp;
  const spin = term.spinner(s('dnsChecking', { host }));
  let ips: string[] = [];
  try {
    ips = await w.deps.resolveA(host);
  } catch {
    // NXDOMAIN or no resolver: same advice as a wrong record
  }
  if (ip && ips.includes(ip)) spin.stop(s('dnsOk', { host, ip }));
  else if (ip) spin.fail(s('dnsWrong', { host, ip, now: ips.join(', ') || s('dnsNothing') }));
  else spin.stop(s('dnsUnknown', { host, now: ips.join(', ') || s('dnsNothing') }));
}

async function askDuckDns(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  for (const l of s('duckHelp').split('\n')) term.info(l);
  const domain = parseDuckDomain(await term.text(s('duckDomainQ'), {
    default: values.DUCKDNS_DOMAIN || undefined,
    required: true,
    id: 'duckdns-domain',
    validate: (v) => (parseDuckDomain(v) ? null : s('duckDomainBad')),
  }))!;
  let current: string | undefined = values.DUCKDNS_DOMAIN === domain ? values.DUCKDNS_TOKEN || undefined : undefined;
  for (;;) {
    const token = await askSecret(w, { id: 'DUCKDNS_TOKEN', question: s('duckTokenQ'), current });
    const spin = term.spinner(s('duckChecking', { name: `${domain}.duckdns.org` }));
    const ddns = w.deps.ddns({ domain, token });
    // An empty ip lets DuckDNS take the caller's address.
    await ddns.update(w.host.publicIp ?? '');
    const last = ddns.last();
    if (last?.ok) {
      spin.stop(s('duckOk', { name: `${domain}.duckdns.org`, ip: w.host.publicIp ?? '?' }));
      values.DUCKDNS_TOKEN = token;
      break;
    }
    spin.fail(s('duckFailed', { error: last?.error ?? '?' }));
    const next = await term.select(s('duckRetryQ'), [
      { value: 'retry', label: s('duckRetry') },
      { value: 'keep', label: s('duckKeepAnyway') },
    ], 0, { id: 'duckdns-retry' });
    if (next === 'keep') {
      values.DUCKDNS_TOKEN = token;
      break;
    }
    current = undefined;
  }
  values.DDNS_PROVIDER = 'duckdns';
  values.DUCKDNS_DOMAIN = domain;
  values.PUBLIC_URL = `https://${domain}.duckdns.org`;
}

async function askSslip(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  for (const l of s('sslipHelp').split('\n')) term.warn(l);
  const ip = w.host.publicIp ?? await term.text(s('sslipIpQ'), {
    default: values.LIVEKIT_NODE_IP || undefined,
    required: true,
    id: 'node-ip',
    validate: (v) => (IPV4_RE.test(v) ? null : s('ipBad')),
  });
  values.PUBLIC_URL = `https://${sslipHost(ip)}`;
  values.LIVEKIT_NODE_IP = ip;
  term.ok(s('sslipOk', { url: values.PUBLIC_URL }));
}

async function askTunnel(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  for (const l of s('tunnelHelp', { port: listenPort(values) }).split('\n')) term.info(l);
  values.TUNNEL_TOKEN = extractTunnelToken(await askSecret(w, {
    id: 'TUNNEL_TOKEN',
    question: s('tunnelTokenQ'),
    current: values.TUNNEL_TOKEN || undefined,
    validate: (v) => (validTunnelToken(extractTunnelToken(v)) ? null : s('tunnelTokenBad')),
  }));
  const previous = values.INGRESS === 'tunnel' ? hostOf(values.PUBLIC_URL) : '';
  const host = parseHost(await term.text(s('tunnelHostQ'), {
    default: previous || undefined,
    required: true,
    id: 'public-url',
    validate: (v) => (parseHost(v) ? null : s('hostBad')),
  }))!;
  values.PUBLIC_URL = `https://${host}`;
}

async function askExternal(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  term.info(s('externalHelp', { port: listenPort(values) }));
  values.PUBLIC_URL = await term.text(s('externalUrlQ'), {
    default: values.INGRESS === 'external' ? values.PUBLIC_URL || undefined : undefined,
    required: true,
    id: 'public-url',
    validate: (v) => {
      try {
        const u = new URL(v);
        return (u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/' ? null : s('urlBad');
      } catch {
        return s('urlBad');
      }
    },
  });
  values.PUBLIC_URL = values.PUBLIC_URL.replace(/\/$/, '');
}

/**
 * Fills INGRESS, PUBLIC_URL, the HTTP ports, the tunnel/DuckDNS keys and
 * UPNP; clears the keys the chosen mode does not use.
 */
export async function askIngress(w: Wizard, values: Values, target: Target): Promise<IngressChoice> {
  const { term, s } = w;
  term.step(s('ingressTitle'));
  let def: IngressChoice = target === 'cloudflare' ? 'tunnel' : currentChoice(values);
  if (def === 'sslip' && target !== 'vps') def = 'domain';
  let choice: IngressChoice;
  for (;;) {
    const items: { value: IngressChoice; label: string; hint?: string }[] = [
      { value: 'domain', label: s('choiceDomain'), hint: s('choiceDomainHint') },
      { value: 'duckdns', label: s('choiceDuck'), hint: s('choiceDuckHint') },
    ];
    if (target === 'vps') items.push({ value: 'sslip', label: s('choiceSslip'), hint: s('choiceSslipHint') });
    items.push(
      { value: 'tunnel', label: s('choiceTunnel'), hint: s('choiceTunnelHint') },
      { value: 'external', label: s('choiceExternal'), hint: s('choiceExternalHint') },
    );
    choice = await term.select(s('ingressQ'), items, Math.max(0, items.findIndex((i) => i.value === def)), { id: 'ingress' });
    if (choice === 'tunnel' || choice === 'external') break;
    if ((await askPorts(w, values)) !== 'neither') break;
    for (const l of s('portsNeitherAdvice').split('\n')) term.warn(l);
    def = 'tunnel';
  }

  const direct = choice === 'domain' || choice === 'duckdns' || choice === 'sslip';
  values.INGRESS = direct ? 'direct' : choice;
  if (!direct) values.HTTP_PORT = values.HTTPS_PORT = '';
  if (choice !== 'tunnel') values.TUNNEL_TOKEN = '';
  if (choice !== 'duckdns') values.DDNS_PROVIDER = values.DUCKDNS_DOMAIN = values.DUCKDNS_TOKEN = '';
  // Only sslip.io pins the IP. A pinned IP left over from it would freeze the
  // DuckDNS record and LiveKit's advertised address at a stale value.
  if (choice !== 'sslip') values.LIVEKIT_NODE_IP = '';
  if (choice === 'domain') await askOwnDomain(w, values);
  else if (choice === 'duckdns') await askDuckDns(w, values);
  else if (choice === 'sslip') await askSslip(w, values);
  else if (choice === 'tunnel') await askTunnel(w, values);
  else await askExternal(w, values);

  // Media ports need forwarding in every mode; a VPS has no router to ask
  // (UPnP off: no "forward the ports by hand" at every start).
  if (target !== 'vps') {
    for (const l of s('upnpHelp').split('\n')) term.info(l);
    values.UPNP = (await term.confirm(s('upnpQ'), values.UPNP !== 'off', { id: 'upnp' })) ? 'auto' : 'off';
  } else {
    values.UPNP = 'off';
  }
  return choice;
}
