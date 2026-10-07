// The address: how people reach Telinha and how HTTPS gets there. At home a
// Cloudflare Tunnel when there is a domain on Cloudflare, else a free DuckDNS
// name with HTTPS on a high port (the certificate comes through the DuckDNS
// API: nothing to open on 80/443); 80/443 or an own proxy only on request.
// On a VPS: own domain, DuckDNS (validated live) or sslip.io on 80/443, a
// Cloudflare Tunnel or the user's own proxy.
import { IPV4_RE } from '../../config.ts';
import { SSLIP_RE, type Hosting } from './host.ts';
import { askSecret, type Values, type Wizard } from './steps.ts';

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

/**
 * The key of Telinha's own port already on `port`, or null. LISTEN and
 * LIVEKIT_PORT are not wizard keys, so this sees their defaults; a custom one
 * still trips loadConfig's collision check before the file is written. The
 * media ports are asked after the HTTPS port and only checked when changed,
 * so their current values (defaults 7881/7882) are refused here, not in save().
 */
export function takenPort(values: Values, port: number): string | null {
  if (port === listenPort(values)) return 'LISTEN';
  if (port === Number(values.LIVEKIT_PORT || 7880)) return 'LIVEKIT_PORT';
  if (port === Number(values.MEDIA_TCP_PORT || 7881)) return 'MEDIA_TCP_PORT';
  if (port === Number(values.MEDIA_UDP_PORT || 7882)) return 'MEDIA_UDP_PORT';
  return null;
}

const lines = (w: Wizard, text: string, kind: 'info' | 'warn' = 'info') => {
  for (const l of text.split('\n')) w.term[kind](l);
};

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

/** Name and token, validated live; PUBLIC_URL without a port (the home caller adds it). */
async function askDuckDns(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  lines(w, s('duckHelp'));
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

/** Home without a domain on Cloudflare: DuckDNS name, HTTPS on a high port that the URL carries, certificate through the DuckDNS API. */
async function askDuckDnsHome(w: Wizard, values: Values, ports: (string | undefined)[]): Promise<void> {
  const { term, s } = w;
  // The first usable of --https-port and the previous high port; 80/443 would only be refused.
  const def = ports.find((p) => p && /^\d+$/.test(p) && Number(p) >= 1024 && Number(p) <= 65535) || DEFAULT_HOME_HTTPS_PORT;
  lines(w, s('homeDuckHelp', { name: values.DUCKDNS_DOMAIN || (w.locale === 'pt-BR' ? 'nome' : 'name'), port: def }));
  await askDuckDns(w, values);
  const port = await term.text(s('httpsPortQ'), {
    default: def,
    id: 'https-port',
    validate: (v) => {
      if (!/^\d+$/.test(v) || Number(v) > 65535) return s('portBad');
      if (Number(v) < 1024) return s('httpsPortLow');
      const taken = takenPort(values, Number(v));
      return taken ? s('httpsPortTaken', { what: taken }) : null;
    },
  });
  values.HTTPS_PORT = port;
  values.PUBLIC_URL = `https://${values.DUCKDNS_DOMAIN}.duckdns.org:${port}`;
  term.ok(s('homeDuckOk', { url: values.PUBLIC_URL }));
}

async function askSslip(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  lines(w, s('sslipHelp'), 'warn');
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
  lines(w, s('tunnelHelp', { port: listenPort(values) }));
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

/** The home questions: a domain on Cloudflare, else DuckDNS on a high port; 80/443 or an own proxy only when asked for. */
async function askHomeChoice(w: Wizard, values: Values): Promise<AddressChoice> {
  const { term, s } = w;
  term.info(s('homeIntro'));
  const cf = await term.select(s('cfDomainQ'), [
    { value: 'yes', label: s('cfYes'), hint: s('cfYesHint') },
    { value: 'no', label: s('cfNo'), hint: s('cfNoHint') },
    { value: 'advanced', label: s('cfAdvanced'), hint: s('cfAdvancedHint') },
  ], ['yes', 'no', 'advanced'].indexOf(homeChoice(values)), { id: 'cf-domain' });
  if (cf === 'yes') return 'tunnel';
  if (cf === 'no') return 'duckdns-home';
  const kind = await term.select(s('advancedQ'), [
    { value: 'ports', label: s('advancedPorts'), hint: s('advancedPortsHint') },
    { value: 'proxy', label: s('advancedProxy'), hint: s('advancedProxyHint') },
  ], values.INGRESS === 'external' ? 1 : 0, { id: 'advanced' });
  if (kind === 'proxy') return 'external';
  const choice = await term.select<AddressChoice>(s('ingressQ'), [
    { value: 'domain', label: s('choiceDomain'), hint: s('choiceDomainHint') },
    { value: 'duckdns', label: s('choiceDuck'), hint: s('choiceDuckHint') },
  ], currentChoice(values) === 'duckdns' ? 1 : 0, { id: 'ingress' });
  term.info(s('advancedPortsNote'));
  return choice;
}

async function askVpsChoice(w: Wizard, values: Values): Promise<AddressChoice> {
  const { term, s } = w;
  const items: { value: IngressChoice; label: string; hint?: string }[] = [
    { value: 'domain', label: s('choiceDomain'), hint: s('choiceDomainHint') },
    { value: 'duckdns', label: s('choiceDuck'), hint: s('choiceDuckHint') },
    { value: 'sslip', label: s('choiceSslip'), hint: s('choiceSslipHint') },
    { value: 'tunnel', label: s('choiceTunnel'), hint: s('choiceTunnelHint') },
    { value: 'external', label: s('choiceExternal'), hint: s('choiceExternalHint') },
  ];
  const def = currentChoice(values);
  return term.select(s('ingressQ'), items, items.findIndex((i) => i.value === def), { id: 'ingress' });
}

/**
 * Fills HOSTING, INGRESS, PUBLIC_URL, the HTTP ports, ACME_DNS, the
 * tunnel/DuckDNS keys, LIVEKIT_NODE_IP and UPNP: every path writes every one
 * of them, so a re-run that switches modes leaves nothing of the old mode.
 */
export async function askAddress(w: Wizard, values: Values, hosting: Hosting, o: { httpsPort?: string } = {}): Promise<AddressChoice> {
  const { term, s } = w;
  term.step(s('ingressTitle'));
  // Read before the columns are rewritten: the port a re-run offers again, and
  // whether the file comes from a VPS (whose path turned UPnP off by itself).
  const previousPort = values.ACME_DNS === 'duckdns' ? values.HTTPS_PORT || '' : '';
  const leftVps = values.HOSTING === 'vps' && hosting === 'home';
  const choice = hosting === 'home' ? await askHomeChoice(w, values) : await askVpsChoice(w, values);

  const direct = choice !== 'tunnel' && choice !== 'external';
  const highPort = choice === 'duckdns-home';
  values.HOSTING = hosting;
  values.INGRESS = direct ? 'direct' : choice;
  values.HTTP_PORT = direct ? (highPort ? '0' : '80') : '';
  values.HTTPS_PORT = direct && !highPort ? '443' : '';
  values.ACME_DNS = highPort ? 'duckdns' : '';
  if (choice !== 'tunnel') values.TUNNEL_TOKEN = '';
  if (choice !== 'duckdns' && !highPort) values.DDNS_PROVIDER = values.DUCKDNS_DOMAIN = values.DUCKDNS_TOKEN = '';
  // Only sslip.io pins the IP. A pinned IP left over from it would freeze the
  // DuckDNS record and LiveKit's advertised address at a stale value.
  if (choice !== 'sslip') values.LIVEKIT_NODE_IP = '';
  if (choice === 'domain') await askOwnDomain(w, values);
  else if (choice === 'duckdns') await askDuckDns(w, values);
  else if (choice === 'duckdns-home') await askDuckDnsHome(w, values, [o.httpsPort, previousPort]);
  else if (choice === 'sslip') await askSslip(w, values);
  else if (choice === 'tunnel') await askTunnel(w, values);
  else await askExternal(w, values);

  // Media ports (and the home high HTTPS port) need forwarding; a VPS has no router
  // to ask (UPnP off: no "forward the ports by hand" at every start).
  if (hosting === 'home') {
    // What must reach this machine follows the outcome: a tunnel or a proxy needs only the
    // media ports, the high port joins them, and 80/443 are never asked of the router.
    if (highPort) lines(w, s('upnpHelpHttps', { port: values.HTTPS_PORT! }));
    else if (direct) lines(w, s('upnpHelpAdvanced'));
    else lines(w, s('upnpHelp'));
    values.UPNP = (await term.confirm(s('upnpQ'), leftVps || values.UPNP !== 'off', { id: 'upnp' })) ? 'auto' : 'off';
  } else {
    values.UPNP = 'off';
  }
  return choice;
}
