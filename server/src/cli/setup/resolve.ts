// Answers <-> telinha.env values. resolveValues() is the one place that turns
// answers into the file's keys (the setup screens and the non-interactive run
// both end there); defaultAnswers() reads a re-run's answers back from the
// file; answersFromFlags() turns the command line (flags over environment over
// file) into answers with the non-interactive rules and messages.
import { inferHosting, SSLIP_RE, type HostInfo, type Hosting } from './host.ts';
import { SNOWFLAKE_RE, validCommand } from './discord.ts';
import { currentChoice, DEFAULT_HOME_HTTPS_PORT, extractTunnelToken, homeChoice, parseDuckDomain, parseHost, takenPort, validTunnelToken } from './domain.ts';
import {
  addressChoice, addressValues, ALWAYS_COUNTED, directLow, fileHosting, flowIds, mediaPorts, QUESTIONS, txt,
  type AddressChoice, type AnswerId, type Answers, type ModelEnv, type QuestionId, type Text,
} from './model.ts';
import { q } from './qstrings.ts';
import type { Values } from './steps.ts';
import type { Locale } from '../strings.ts';

export interface ResolveBase { file: Values; host: HostInfo | null; locale: Locale; langFlag: boolean; docker: boolean; compiled: boolean }

const str = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '');

/**
 * Pure. Counted answers = answers of questions in flowIds(a, env) plus ALWAYS_COUNTED
 * (hidden ids and clientId, online or offline); branch answers left behind are ignored.
 * Starts from the file's managed keys: what no question covers (the generated secrets) stays.
 */
export function resolveValues(a: Answers, env: ModelEnv, base: ResolveBase): Values {
  const c: Answers = {};
  for (const id of new Set<AnswerId>([...flowIds(a, env), ...ALWAYS_COUNTED])) if (a[id] !== undefined) c[id] = a[id];
  const v: Values = { ...base.file };
  v.LOCALE = c.lang !== undefined ? str(c.lang) : base.langFlag ? base.locale : base.file.LOCALE ?? '';
  v.HOSTING = str(c.hosting);
  Object.assign(v, addressValues(c, { host: env.host ?? base.host }));
  // A VPS has no router to ask: no "forward the ports by hand" at every start.
  v.UPNP = c.hosting === 'home' ? str(c.upnp) : 'off';
  const { tcp, udp } = mediaPorts(c, { file: base.file });
  // Defaults stay commented in the file.
  v.MEDIA_TCP_PORT = tcp === '7881' ? '' : tcp;
  v.MEDIA_UDP_PORT = udp === '7882' ? '' : udp;
  const set = (key: string, id: AnswerId) => {
    const x = c[id];
    if (x !== undefined) v[key] = Array.isArray(x) ? x.join(',') : x;
  };
  set('DISCORD_TOKEN', 'discordToken');
  set('DISCORD_CLIENT_ID', 'clientId');
  set('DISCORD_CLIENT_SECRET', 'clientSecret');
  set('GUILD_ID', 'guild');
  set('ROLE_ID', 'role');
  set('CHANNEL_IDS', 'channels');
  set('COMMAND_NAME', 'command');
  set('GROUP_NAME', 'group');
  v.AUTO_UPDATE = c.autoUpdate !== undefined ? str(c.autoUpdate) : base.file.AUTO_UPDATE ?? '';
  return v;
}

/** The address people open; '' while it is not known. */
export function webAddress(a: Answers, env: ModelEnv, base: ResolveBase): string {
  return resolveValues(a, env, base).PUBLIC_URL ?? '';
}

/** The leaf answers that make each address, compared before a hidden URL is reused. */
const LEAVES: Record<AddressChoice, QuestionId[]> = {
  domain: ['domain'], duckdns: ['duckName'], 'duckdns-home': ['duckName', 'httpsPort'], sslip: ['nodeIp'], tunnel: ['tunnelHost'], external: ['externalUrl'],
};
const same = (x: string | string[] | undefined, y: string | string[] | undefined) => JSON.stringify(x) === JSON.stringify(y);

/**
 * The hidden answers `source` (the file's defaults, or the flags) carries that still fit `a`:
 * custom direct ports while it stays a direct mode of the same hosting, a pinned node IP
 * while the address mode is the same, a verbatim URL while the address answers are too.
 */
export function keepHidden(a: Answers, source: Answers): Answers {
  const out: Answers = {};
  const choice = addressChoice(a);
  const was = addressChoice(source);
  if (a.hosting === source.hosting && directLow(choice) && directLow(was)) {
    if (source.httpPort !== undefined) out.httpPort = source.httpPort;
    if (source.httpsPortDirect !== undefined) out.httpsPortDirect = source.httpsPortDirect;
  }
  const sameMode = choice !== null && choice === was && a.hosting === source.hosting;
  if (sameMode && source.pinnedIp !== undefined) out.pinnedIp = source.pinnedIp;
  if (sameMode && source.publicUrl !== undefined && LEAVES[choice].every((id) => same(a[id], source[id]))) out.publicUrl = source.publicUrl;
  return out;
}

/** Re-run defaults from the existing file (and the detected machine), hidden answers included. */
export function defaultAnswers(env: ModelEnv): Answers {
  const a: Answers = {};
  for (const qd of QUESTIONS) {
    const d = qd.default(a, env);
    if (d !== undefined) a[qd.id] = d;
  }
  const f = env.file;
  const choice = addressChoice(a);
  // Custom direct ports survive a re-run of the same mode (a VPS, or an advanced home).
  if (f.HOSTING === a.hosting && (f.INGRESS || 'direct') === 'direct' && f.ACME_DNS !== 'duckdns' && directLow(choice)) {
    if (f.HTTP_PORT && f.HTTP_PORT !== '80') a.httpPort = f.HTTP_PORT;
    if (f.HTTPS_PORT && f.HTTPS_PORT !== '443') a.httpsPortDirect = f.HTTPS_PORT;
  }
  // A pinned IP outside sslip.io stays while the mode does; DuckDNS follows the IP, so never there.
  if (f.LIVEKIT_NODE_IP && (choice === 'domain' || choice === 'tunnel' || choice === 'external')) a.pinnedIp = f.LIVEKIT_NODE_IP;
  // The file's own address when the answers cannot spell it (a port, a path): kept until it changes.
  if (f.PUBLIC_URL && (choice === 'domain' || choice === 'tunnel' || choice === 'external') && addressValues(a, env).PUBLIC_URL !== f.PUBLIC_URL) {
    a.publicUrl = f.PUBLIC_URL;
  }
  return a;
}

/** `ParsedArgs<typeof SETUP_SPEC>['flags']`, structurally: the flags the answers come from. */
export interface SetupFlagValues {
  host?: string; 'public-url'?: string; ingress?: string; advanced?: boolean;
  'http-port'?: string; 'https-port'?: string; 'duckdns-domain'?: string;
  'media-tcp'?: string; 'media-udp'?: string; 'node-ip'?: string;
  'client-id'?: string; guild?: string; role?: string; channels?: string; command?: string; group?: string;
  upnp?: string; 'auto-update'?: string; lang?: string;
  'no-discord-check'?: boolean;
}

type SecretKey = 'DISCORD_TOKEN' | 'DISCORD_CLIENT_SECRET' | 'TUNNEL_TOKEN' | 'DUCKDNS_TOKEN';
const SECRETS: readonly [SecretKey, string][] = [
  ['DISCORD_TOKEN', 'discord-token-file'], ['DISCORD_CLIENT_SECRET', 'client-secret-file'], ['TUNNEL_TOKEN', 'tunnel-token-file'], ['DUCKDNS_TOKEN', 'duckdns-token-file'],
];

export interface FlagOptions {
  /** Read by the caller with readSecretSource: the environment's value wins, then the -file flag. */
  secrets: Partial<Record<SecretKey, string>>;
  locale: Locale;
  /** The setup screens' pre-pass: never reports missing; the flags only become defaults. */
  lenient: boolean;
  advanced: boolean;
  /** The real environment: a UPNP set there is a choice, not a VPS file's leftover. */
  env?: Record<string, string | undefined>;
}

/** The hostname of a URL; '' when it does not parse. */
function urlHost(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
}

/** host:port of a URL for comparing; '' when it does not parse. */
function urlOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '443'}`;
  } catch {
    return '';
  }
}

interface Collected { values: Values; errors: { text: Text; blame: string[] }[]; missing: string[]; hosting: Hosting | null }

/**
 * The non-interactive rules on a copy of the file's values: flags over environment over
 * file, what is missing and what is wrong (each error names the flags it is about, so
 * the lenient pre-pass can leave those out of the defaults).
 */
function collect(flags: SetupFlagValues, env: ModelEnv, o: FlagOptions): Collected {
  const s = (key: Parameters<typeof q>[1], params?: Record<string, string | number>) => q(o.locale, key, params);
  const values: Values = { ...env.file };
  const errors: Collected['errors'] = [];
  const err = (text: Text, ...blame: string[]) => errors.push({ text, blame });
  const advancedFlag = !!(flags.advanced || o.advanced);
  // The file as loaded, before any flag lands: a re-run on the same path keeps
  // its ports and an advanced home file counts as confirmed; a switch starts
  // from the new path's defaults.
  const before: Values = { ...values };
  const was = {
    advanced: homeChoice(before) === 'advanced',
    highPort: before.ACME_DNS === 'duckdns',
    vps: before.HOSTING === 'vps',
    vpsDirect: before.HOSTING === 'vps' && (before.INGRESS || 'direct') === 'direct',
    ingress: before.INGRESS || 'direct',
  };
  const set = (key: string, v: string | undefined) => {
    if (v !== undefined) values[key] = v.trim();
  };
  const oneOf = (flag: string, v: string | undefined, allowed: string[]) => {
    if (v !== undefined && !allowed.includes(v)) err(txt('badFlagValue', { flag: `--${flag}`, value: v, allowed: allowed.join(' | ') }), flag);
    return v;
  };
  const port = (flag: string, key: string, v: string | undefined) => {
    if (v === undefined) return;
    if (!/^\d+$/.test(v) || Number(v) > 65535) err(txt('badFlagValue', { flag: `--${flag}`, value: v, allowed: '0-65535' }), flag);
    values[key] = v;
  };

  set('HOSTING', oneOf('host', flags.host, ['home', 'vps']));
  set('PUBLIC_URL', flags['public-url']?.replace(/\/$/, ''));
  set('INGRESS', oneOf('ingress', flags.ingress, ['direct', 'tunnel', 'external']));
  port('http-port', 'HTTP_PORT', flags['http-port']);
  port('https-port', 'HTTPS_PORT', flags['https-port']);
  port('media-tcp', 'MEDIA_TCP_PORT', flags['media-tcp']);
  port('media-udp', 'MEDIA_UDP_PORT', flags['media-udp']);
  set('LIVEKIT_NODE_IP', flags['node-ip']);
  set('DISCORD_CLIENT_ID', flags['client-id']);
  set('GUILD_ID', flags.guild);
  set('ROLE_ID', flags.role);
  set('CHANNEL_IDS', flags.channels?.split(',').map((c) => c.trim()).filter(Boolean).join(','));
  set('COMMAND_NAME', flags.command);
  set('GROUP_NAME', flags.group);
  set('UPNP', oneOf('upnp', flags.upnp, ['auto', 'off']));
  set('AUTO_UPDATE', oneOf('auto-update', flags['auto-update'], ['on', 'off']));
  if (flags.lang) values.LOCALE = o.locale;
  if (flags['duckdns-domain'] !== undefined) {
    const d = parseDuckDomain(flags['duckdns-domain']);
    if (!d) err(txt('badFlagValue', { flag: '--duckdns-domain', value: flags['duckdns-domain'], allowed: 'a-z 0-9 -' }), 'duckdns-domain');
    else {
      values.DDNS_PROVIDER = 'duckdns';
      values.DUCKDNS_DOMAIN = d;
      if (!flags['public-url']) values.PUBLIC_URL = `https://${d}.duckdns.org`;
      // DuckDNS lives in direct mode only: a tunnel or proxy file switching to it becomes direct.
      if (flags.ingress === undefined) values.INGRESS = 'direct';
      else if (flags.ingress === 'tunnel' || flags.ingress === 'external') {
        err(txt('badFlagValue', { flag: '--ingress', value: flags.ingress, allowed: 'direct (with --duckdns-domain)' }), 'ingress');
      }
      // At home the name means the high port unless --advanced says 80/443.
      if (!advancedFlag) values.ACME_DNS = 'duckdns';
    }
  }

  for (const [key] of SECRETS) {
    const v = o.secrets[key];
    if (v) values[key] = v;
  }
  // The dashboard's install command, pasted whole into the file, still works.
  if (values.TUNNEL_TOKEN) values.TUNNEL_TOKEN = extractTunnelToken(values.TUNNEL_TOKEN);
  // A --public-url on another host leaves DuckDNS: its keys go, or the updater
  // keeps writing the old name and the rules below take the file's name as given.
  if (flags['public-url'] !== undefined && flags['duckdns-domain'] === undefined && values.DUCKDNS_DOMAIN && urlHost(values.PUBLIC_URL) !== `${values.DUCKDNS_DOMAIN}.duckdns.org`) {
    values.DDNS_PROVIDER = values.DUCKDNS_DOMAIN = values.DUCKDNS_TOKEN = values.ACME_DNS = '';
  }
  // A switch to a tunnel or a proxy needs that path's own address: the old one
  // (a DuckDNS name, an IP) is not what Cloudflare or the proxy serves.
  if ((values.INGRESS === 'tunnel' || values.INGRESS === 'external') && values.INGRESS !== was.ingress && flags['public-url'] === undefined) values.PUBLIC_URL = '';
  // Where it runs: --host or HOSTING, else the VPS-only keys (read before the node IP
  // below may go), else the machine. The pre-pass enforces the home rules only when
  // the hosting is stated: otherwise the hosting question decides.
  const stated = values.HOSTING === 'home' || values.HOSTING === 'vps' ? values.HOSTING : null;
  const hosting: Hosting | null = o.lenient ? stated : env.host ? inferHosting(values, env.host) : fileHosting(values) ?? 'home';
  // A pinned IP belongs to sslip.io: switching away (or to DuckDNS, which follows
  // the IP) without --node-ip drops it, or DuckDNS and LiveKit keep a stale one.
  const modeChanged = flags.ingress !== undefined || flags['duckdns-domain'] !== undefined || flags['public-url'] !== undefined;
  if (flags['node-ip'] === undefined && (modeChanged || values.DDNS_PROVIDER === 'duckdns') && !SSLIP_RE.test(values.PUBLIC_URL ?? '')) {
    values.LIVEKIT_NODE_IP = '';
  }

  const ingress = values.INGRESS || 'direct';
  const given = (...names: (keyof SetupFlagValues)[]) => names.filter((n) => flags[n] !== undefined);
  if (hosting) {
    values.HOSTING = hosting;
    values.INGRESS = ingress;
    if (hosting === 'home') {
      // A plain re-run of an advanced home file (--guild, a new token) is already
      // confirmed; a run that changes the address or the ports must say so again.
      const advanced = advancedFlag || (was.advanced && !modeChanged && flags['https-port'] === undefined && flags['http-port'] === undefined);
      if (ingress === 'direct' && values.DUCKDNS_DOMAIN && !advanced) {
        // Home connections block 80/443: HTTPS on a high port that the URL carries, the certificate through the DuckDNS API.
        const https = flags['https-port'] ?? (was.highPort ? before.HTTPS_PORT || undefined : undefined) ?? DEFAULT_HOME_HTTPS_PORT;
        const taken = takenPort(values, Number(https));
        if (Number(https) < 1024 || (flags['http-port'] !== undefined && flags['http-port'] !== '0')) {
          err(txt('homeNeedsAdvanced'), ...(given('https-port', 'http-port').length ? given('https-port', 'http-port') : ['host']));
        } else if (taken) err(txt('badFlagValue', { flag: '--https-port', value: https, allowed: `1024-65535, != ${taken}` }), 'https-port');
        const url = `https://${values.DUCKDNS_DOMAIN}.duckdns.org:${https}`;
        if (flags['public-url'] !== undefined && urlOrigin(values.PUBLIC_URL ?? '') !== urlOrigin(url)) {
          err(txt('badFlagValue', { flag: '--public-url', value: flags['public-url'], allowed: url }), 'public-url');
        }
        values.HTTPS_PORT = https;
        values.HTTP_PORT = '0';
        values.ACME_DNS = 'duckdns';
        values.DDNS_PROVIDER = 'duckdns';
        values.PUBLIC_URL = url;
      } else if (ingress !== 'tunnel' && !advanced) {
        // Direct without DuckDNS or an own proxy: both lean on 80/443 or on the user's own setup.
        const address = given('public-url', 'ingress', 'http-port', 'https-port', 'node-ip');
        err(txt('homeNeedsAdvanced'), ...(address.length ? address : ['host']));
      } else if (ingress === 'direct') {
        // Confirmed: the certificate comes over 80/443 (or the ports given), as on a VPS.
        values.HTTPS_PORT = flags['https-port'] ?? ((was.advanced && values.HTTPS_PORT) || '443');
        values.HTTP_PORT = flags['http-port'] ?? ((was.advanced && values.HTTP_PORT) || '80');
        values.ACME_DNS = '';
        if (values.DUCKDNS_DOMAIN && flags['public-url'] === undefined) values.PUBLIC_URL = `https://${values.DUCKDNS_DOMAIN}.duckdns.org`;
      }
    } else if (ingress === 'direct') {
      // A VPS has 80/443: the certificate comes over them, DuckDNS included.
      values.HTTPS_PORT = flags['https-port'] ?? ((was.vpsDirect && values.HTTPS_PORT) || '443');
      values.HTTP_PORT = flags['http-port'] ?? ((was.vpsDirect && values.HTTP_PORT) || '80');
      values.ACME_DNS = '';
      if (values.DUCKDNS_DOMAIN && flags['public-url'] === undefined) values.PUBLIC_URL = `https://${values.DUCKDNS_DOMAIN}.duckdns.org`;
    }
  }
  if (flags.upnp === undefined) {
    // A VPS has no router to ask; at home the media ports (and the HTTPS port) need it.
    // The VPS path wrote off by itself, so a VPS file moving home starts from auto again.
    const leftVps = was.vps && (hosting ?? values.HOSTING) === 'home' && o.env?.UPNP === undefined;
    if (hosting === 'vps') values.UPNP = 'off';
    else if (leftVps) values.UPNP = 'auto';
    else if (hosting) values.UPNP = values.UPNP || 'auto';
  }

  // Keys the chosen mode does not use go away (a re-run may switch modes).
  if (ingress !== 'tunnel') values.TUNNEL_TOKEN = '';
  if (ingress !== 'direct') values.DDNS_PROVIDER = values.DUCKDNS_DOMAIN = values.DUCKDNS_TOKEN = values.HTTP_PORT = values.HTTPS_PORT = values.ACME_DNS = '';
  if (values.ACME_DNS !== 'duckdns') values.ACME_DNS = '';
  if (values.COMMAND_NAME && !validCommand(values.COMMAND_NAME)) err(txt('commandBad'), 'command');
  if (values.TUNNEL_TOKEN && !validTunnelToken(values.TUNNEL_TOKEN)) err(txt('tunnelTokenBad'), 'TUNNEL_TOKEN');
  for (const [key, flag] of [['DISCORD_CLIENT_ID', 'client-id'], ['GUILD_ID', 'guild'], ['ROLE_ID', 'role']] as const) {
    if (values[key] && !SNOWFLAKE_RE.test(values[key]!)) err(txt('badFlagValue', { flag: `--${flag}`, value: values[key]!, allowed: s('idAllowed') }), flag);
  }
  if (values.CHANNEL_IDS && !values.CHANNEL_IDS.split(',').every((c) => SNOWFLAKE_RE.test(c))) {
    err(txt('badFlagValue', { flag: '--channels', value: values.CHANNEL_IDS, allowed: s('idAllowed') }), 'channels');
  }

  const missing: string[] = [];
  const need = (key: string, what: string) => {
    if (!values[key]) missing.push(what);
  };
  const secret = (key: SecretKey) => s('missingSecret', { env: key, flag: `--${SECRETS.find(([k]) => k === key)![1]}` });
  need('PUBLIC_URL', '--public-url');
  need('DISCORD_TOKEN', secret('DISCORD_TOKEN'));
  need('DISCORD_CLIENT_SECRET', secret('DISCORD_CLIENT_SECRET'));
  if (flags['no-discord-check']) need('DISCORD_CLIENT_ID', '--client-id');
  need('GUILD_ID', '--guild');
  need('ROLE_ID', '--role');
  need('CHANNEL_IDS', '--channels');
  if (ingress === 'tunnel') need('TUNNEL_TOKEN', secret('TUNNEL_TOKEN'));
  // The same token serves the DNS record and the certificate.
  if (values.DDNS_PROVIDER === 'duckdns' || values.ACME_DNS === 'duckdns') need('DUCKDNS_TOKEN', secret('DUCKDNS_TOKEN'));
  return { values, errors, missing, hosting };
}

/** The answers that reproduce `values` (a finished non-interactive run) through resolveValues. */
function answersOf(values: Values, hosting: Hosting, env: ModelEnv): Answers {
  const a: Answers = { hosting };
  const ingress = values.INGRESS || 'direct';
  if (hosting === 'home') {
    if (ingress === 'tunnel') a.homeCf = 'yes';
    else if (ingress === 'external') Object.assign(a, { homeCf: 'advanced', homeAdvanced: 'proxy' });
    else if (values.ACME_DNS === 'duckdns') a.homeCf = 'no';
    else Object.assign(a, { homeCf: 'advanced', homeAdvanced: 'ports', advancedAddress: values.DDNS_PROVIDER === 'duckdns' ? 'duckdns' : 'domain' });
  } else {
    a.vpsAddress = currentChoice(values);
  }
  const choice = addressChoice(a);
  const url = values.PUBLIC_URL ?? '';
  const put = (id: AnswerId, v: string | undefined) => {
    if (v) a[id] = v;
  };
  if (choice === 'domain') put('domain', parseHost(url) ?? urlHost(url));
  if (choice === 'duckdns' || choice === 'duckdns-home') {
    put('duckName', values.DUCKDNS_DOMAIN);
    put('duckToken', values.DUCKDNS_TOKEN);
  }
  if (choice === 'duckdns-home') put('httpsPort', values.HTTPS_PORT);
  if (choice === 'sslip') put('nodeIp', values.LIVEKIT_NODE_IP);
  if (choice === 'tunnel') {
    put('tunnelToken', values.TUNNEL_TOKEN);
    put('tunnelHost', parseHost(url) ?? urlHost(url));
  }
  if (choice === 'external') put('externalUrl', url);
  if (directLow(choice)) {
    if (values.HTTP_PORT && values.HTTP_PORT !== '80') a.httpPort = values.HTTP_PORT;
    if (values.HTTPS_PORT && values.HTTPS_PORT !== '443') a.httpsPortDirect = values.HTTPS_PORT;
  }
  // What the answers cannot spell (a port or a path in the URL, a pinned IP) rides along hidden.
  const got = addressValues(a, env);
  if (got.PUBLIC_URL !== url) a.publicUrl = url;
  if (got.LIVEKIT_NODE_IP !== (values.LIVEKIT_NODE_IP ?? '')) a.pinnedIp = values.LIVEKIT_NODE_IP ?? '';

  if (hosting === 'home') put('upnp', values.UPNP);
  put('autoUpdate', values.AUTO_UPDATE);
  put('discordToken', values.DISCORD_TOKEN);
  put('clientId', values.DISCORD_CLIENT_ID);
  put('clientSecret', values.DISCORD_CLIENT_SECRET);
  put('guild', values.GUILD_ID);
  put('role', values.ROLE_ID);
  if (values.CHANNEL_IDS) a.channels = values.CHANNEL_IDS.split(',');
  put('command', values.COMMAND_NAME);
  if (values.GROUP_NAME !== undefined) a.group = values.GROUP_NAME;
  const tcp = values.MEDIA_TCP_PORT || '7881';
  const udp = values.MEDIA_UDP_PORT || '7882';
  const changed = tcp !== (env.file.MEDIA_TCP_PORT || '7881') || udp !== (env.file.MEDIA_UDP_PORT || '7882');
  Object.assign(a, changed ? { mediaPorts: 'change', mediaTcp: tcp, mediaUdp: udp } : { mediaPorts: 'keep' });
  return a;
}

/**
 * Flags next to a terminal: each one the default of its question (both branches of the
 * address, as the hosting question may still go either way). Hidden overrides stay out:
 * the questions decide the address there.
 */
function presetOf(flags: SetupFlagValues, o: FlagOptions, blamed: Set<string>): Answers {
  const a: Answers = {};
  const ok = (f: keyof SetupFlagValues) => flags[f] !== undefined && flags[f] !== '' && !blamed.has(f);
  const put = (id: AnswerId, v: string | string[] | undefined | null) => {
    if (v !== undefined && v !== null && v !== '') a[id] = v;
  };
  if (ok('host')) put('hosting', flags.host);
  const advanced = !!(flags.advanced || o.advanced);
  const ingress = ok('ingress') ? flags.ingress : undefined;
  const duck = ok('duckdns-domain') ? parseDuckDomain(flags['duckdns-domain']!) : null;
  const url = ok('public-url') ? flags['public-url']!.trim().replace(/\/$/, '') : '';
  if (ingress === 'tunnel') {
    Object.assign(a, { homeCf: 'yes', vpsAddress: 'tunnel' });
    put('tunnelHost', url && parseHost(url));
  } else if (ingress === 'external') {
    a.vpsAddress = 'external';
    if (advanced) Object.assign(a, { homeCf: 'advanced', homeAdvanced: 'proxy' });
    put('externalUrl', url);
  } else if (duck) {
    Object.assign(a, { duckName: duck, vpsAddress: 'duckdns' });
    Object.assign(a, advanced ? { homeCf: 'advanced', homeAdvanced: 'ports', advancedAddress: 'duckdns' } : { homeCf: 'no' });
  } else if (url && SSLIP_RE.test(url)) {
    a.vpsAddress = 'sslip';
  } else if (url && parseHost(url)) {
    Object.assign(a, { domain: parseHost(url)!, vpsAddress: 'domain' });
    if (advanced) Object.assign(a, { homeCf: 'advanced', homeAdvanced: 'ports', advancedAddress: 'domain' });
  }
  const https = flags['https-port'];
  if (ok('https-port') && /^\d+$/.test(https!) && Number(https) >= 1024 && Number(https) <= 65535) a.httpsPort = https;
  if (ok('node-ip')) put('nodeIp', flags['node-ip']!.trim());
  if (ok('media-tcp') || ok('media-udp')) {
    a.mediaPorts = 'change';
    if (ok('media-tcp')) a.mediaTcp = flags['media-tcp'];
    if (ok('media-udp')) a.mediaUdp = flags['media-udp'];
  }
  if (ok('upnp')) put('upnp', flags.upnp);
  if (ok('auto-update')) put('autoUpdate', flags['auto-update']);
  if (ok('command')) put('command', flags.command!.trim());
  if (flags.group !== undefined) a.group = flags.group.trim();
  if (ok('client-id')) put('clientId', flags['client-id']!.trim());
  if (ok('guild')) put('guild', flags.guild!.trim());
  if (ok('role')) put('role', flags.role!.trim());
  if (ok('channels')) put('channels', flags.channels!.split(',').map((c) => c.trim()).filter(Boolean));
  put('discordToken', o.secrets.DISCORD_TOKEN);
  put('clientSecret', o.secrets.DISCORD_CLIENT_SECRET);
  put('duckToken', o.secrets.DUCKDNS_TOKEN);
  if (o.secrets.TUNNEL_TOKEN && !blamed.has('TUNNEL_TOKEN')) a.tunnelToken = extractTunnelToken(o.secrets.TUNNEL_TOKEN);
  return a;
}

/**
 * Flags over environment over file, as answers. lenient=false is the non-interactive run:
 * resolveValues of the answers is the file it writes, `missing` lists what is not given.
 * lenient=true is the setup screens' pre-pass: the flags become the questions' defaults,
 * nothing is missing, and an error leaves its flags out of those defaults.
 */
export function answersFromFlags(flags: SetupFlagValues, env: ModelEnv, o: FlagOptions): { answers: Answers; errors: Text[]; missing: string[] } {
  const r = collect(flags, env, o);
  const errors = r.errors.map((e) => e.text);
  if (o.lenient) return { answers: presetOf(flags, o, new Set(r.errors.flatMap((e) => e.blame))), errors, missing: [] };
  return { answers: answersOf(r.values, r.hosting!, env), errors, missing: r.missing };
}
