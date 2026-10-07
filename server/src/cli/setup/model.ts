// The setup questions as data. One catalog in flow order; which questions show
// is a pure function of the answers (and of the machine), so going back is
// "the previous visible question" and answers on a branch the user left stay
// stored for when they come back. Shared by the setup screens and the
// non-interactive run (resolve.ts turns answers into telinha.env values).
import { IPV4_RE, turnAutoHost, turnIneligibility, type Ingress } from '../../config.ts';
import { firewallCommands } from '../../doctor/checks.ts';
import { isCgnatIpv4, isPrivateIpv4 } from '../../netinfo.ts';
import type { Locale } from '../strings.ts';
import { pickableRoles, SNOWFLAKE_RE, validCommand } from './discord.ts';
import {
  currentChoice, DEFAULT_HOME_HTTPS_PORT, extractTunnelToken, homeChoice, listenPort, parseDuckDomain, parseHost, sslipHost, takenPort, validTunnelToken,
  type AddressChoice,
} from './domain.ts';
import { guessHosting, routerLabel, SSLIP_RE, type HostInfo, type Hosting } from './host.ts';
import type { LookupCache, LookupId } from './lookups.ts';
import type { QKey } from './qstrings.ts';
import { hostPorts, publicPorts, type Values } from './steps.ts';
import type { TrayChoice } from './tray.ts';

export type { AddressChoice };

export type StepId = 'where' | 'address' | 'discord' | 'media' | 'ports' | 'updates' | 'tray' | 'review' | 'install';
export type QuestionId =
  | 'lang' | 'hosting'
  | 'homeCf' | 'homeAdvanced' | 'advancedAddress' | 'vpsAddress'
  | 'domain' | 'duckName' | 'duckToken' | 'httpsPort' | 'nodeIp' | 'tunnelToken' | 'tunnelHost' | 'externalUrl'
  | 'discordToken' | 'clientId' | 'clientSecret' | 'redirect' | 'guild' | 'role' | 'channels' | 'command' | 'group'
  | 'media' | 'cloudUrl' | 'cloudKey' | 'cloudSecret' | 'turn'
  | 'mediaPorts' | 'mediaTcp' | 'mediaUdp' | 'sysctl' | 'upnp'
  | 'autoUpdate'
  | 'tray' | 'trayAutostart';
/** Never asked on screen: filled from flags or kept from the file. turnSetting: TURN as the flags left it. */
export type HiddenId = 'publicUrl' | 'httpPort' | 'httpsPortDirect' | 'pinnedIp' | 'turnSetting';
export type AnswerId = QuestionId | HiddenId;
/**
 * Answers resolveValues always reads, whether or not they are in flowIds: the hidden ids
 * plus clientId, which is a visible question only offline; online it is filled by the
 * discordApp lookup (session) or by --client-id / the file (answersFromFlags, defaultAnswers).
 */
export const ALWAYS_COUNTED: readonly AnswerId[] = ['publicUrl', 'httpPort', 'httpsPortDirect', 'pinnedIp', 'turnSetting', 'clientId'];
export const HIDDEN_IDS: readonly HiddenId[] = ['publicUrl', 'httpPort', 'httpsPortDirect', 'pinnedIp', 'turnSetting'];
/** select/text/secret: string; multi (channels): string[]. Absent = unanswered. */
export type Answers = Partial<Record<AnswerId, string | string[]>>;
export type QuestionKind = 'select' | 'multi' | 'text' | 'secret';

/** What the model may look at besides the answers. */
export interface ModelEnv {
  platform: NodeJS.Platform; isRoot: boolean; docker: boolean; compiled: boolean;
  /** --no-discord-check: ids typed, nothing looked up. */
  offline: boolean;
  /** --lang given: no language question, LOCALE = the run's locale. */
  langFlag: boolean;
  flags: { noService: boolean; noUpnp: boolean; noFirewall: boolean; noDoctor: boolean };
  /** Managed keys of the existing file, env-merged (setup.ts currentValues()). */
  file: Values;
  /** null until detection finishes. */
  host: HostInfo | null;
  /** /proc/sys/net/ipv4/ip_unprivileged_port_start, read once; null when unknown or not Linux. */
  unprivilegedPortStart: number | null;
  lookups: LookupCache;
  /** The language the screens show; the language question's default. */
  locale?: Locale;
  /** Native Windows: the tray icon as this machine has it (read before the questions). */
  tray?: TrayState;
}

/** installed: bin	elinha-tray.exe; optedOut: only the copy an earlier "no" kept; autostart: the sign-in Run value. */
export interface TrayState { installed: boolean; optedOut: boolean; autostart: boolean }

/** A localizable text: a key of qstrings.ts with params, or verbatim (names from Discord, URLs). */
export type Text = { key: QKey; params?: Record<string, string | number> } | { raw: string };

export interface OptionDef { value: string; label: Text; desc?: Text; preview?: Text; subtle?: boolean }

export interface QuestionDef {
  id: QuestionId; step: StepId; kind: QuestionKind;
  visible(a: Answers, env: ModelEnv): boolean;
  title: Text; question: Text;
  /** Hint pane lines; select options carry their own preview. */
  hint?(a: Answers, env: ModelEnv): Text[];
  options?(a: Answers, env: ModelEnv): OptionDef[];
  placeholder?: Text;
  /** A placeholder that depends on the answers (the group name shows the server's). */
  placeholderFor?(a: Answers, env: ModelEnv): Text | undefined;
  default(a: Answers, env: ModelEnv): string | string[] | undefined;
  /** Sync check of a typed value; null = fine. */
  validate?(v: string | string[], a: Answers, env: ModelEnv): Text | null;
  /** The stored form of a valid value (a hostname from a pasted URL, the token from an install command). */
  normalize?(v: string, env: ModelEnv): string | string[];
  /** Read-only lookup run on submit (or on entering, for the Discord lists). */
  lookup?: LookupId;
  /** Empty answer allowed (group name). */
  optional?: boolean;
  /** min picks for multi. */
  min?: number;
  /** --no-discord-check: asked as a typed id instead of a list. */
  offlineText?: boolean;
  /** A re-run counts the default as answered only when it reproduces the file (not a guess). Absent = yes. */
  fromFile?(a: Answers, env: ModelEnv): boolean;
  /** A URL the card shows on its own line, never cut (the redirect to add). */
  link?(a: Answers, env: ModelEnv): string | null;
}

export const txt = (key: QKey, params?: Record<string, string | number>): Text => (params ? { key, params } : { key });
const raw = (s: string): Text => ({ raw: s });
const str = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '');

const hostOf = (url: string | undefined): string => {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
};

/** The hosting the file itself says (or its VPS-only keys imply); null for a fresh install. */
export function fileHosting(file: Values): Hosting | null {
  if (file.HOSTING === 'home' || file.HOSTING === 'vps') return file.HOSTING;
  if (file.LIVEKIT_NODE_IP || SSLIP_RE.test(file.PUBLIC_URL ?? '')) return 'vps';
  return null;
}

export function addressChoice(a: Answers): AddressChoice | null {
  if (a.hosting === 'home') {
    if (a.homeCf === 'yes') return 'tunnel';
    if (a.homeCf === 'no') return 'duckdns-home';
    if (a.homeCf !== 'advanced') return null;
    if (a.homeAdvanced === 'proxy') return 'external';
    if (a.homeAdvanced !== 'ports') return null;
    return a.advancedAddress === 'domain' || a.advancedAddress === 'duckdns' ? a.advancedAddress : null;
  }
  if (a.hosting === 'vps') {
    const v = a.vpsAddress;
    return v === 'domain' || v === 'duckdns' || v === 'sslip' || v === 'tunnel' || v === 'external' ? v : null;
  }
  return null;
}

/** Direct on 80/443 (or ports kept from the file): the modes custom HTTP ports belong to. */
export const directLow = (c: AddressChoice | null): boolean => c === 'domain' || c === 'duckdns' || c === 'sslip';

/** Every address column: each path writes all of them, so a mode switch leaves nothing of the old mode. */
export const ADDRESS_KEYS = ['INGRESS', 'PUBLIC_URL', 'HTTP_PORT', 'HTTPS_PORT', 'ACME_DNS', 'TUNNEL_TOKEN', 'DDNS_PROVIDER', 'DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN', 'LIVEKIT_NODE_IP'] as const;

/** The address columns these answers make ('' everywhere while the address is not chosen yet). */
export function addressValues(a: Answers, env: Pick<ModelEnv, 'host'>): Values {
  const out: Values = Object.fromEntries(ADDRESS_KEYS.map((k) => [k, '']));
  const choice = addressChoice(a);
  if (!choice) return out;
  const direct = choice !== 'tunnel' && choice !== 'external';
  const high = choice === 'duckdns-home';
  const https = str(a.httpsPort) || DEFAULT_HOME_HTTPS_PORT;
  const ip = env.host?.publicIp ?? str(a.nodeIp);
  const name = str(a.duckName);
  out.INGRESS = direct ? 'direct' : choice;
  out.HTTP_PORT = !direct ? '' : high ? '0' : a.httpPort !== undefined ? str(a.httpPort) : '80';
  out.HTTPS_PORT = !direct ? '' : high ? https : a.httpsPortDirect !== undefined ? str(a.httpsPortDirect) : '443';
  out.ACME_DNS = high ? 'duckdns' : '';
  out.TUNNEL_TOKEN = choice === 'tunnel' ? str(a.tunnelToken) : '';
  if (choice === 'duckdns' || high) {
    out.DDNS_PROVIDER = 'duckdns';
    out.DUCKDNS_DOMAIN = name;
    out.DUCKDNS_TOKEN = str(a.duckToken);
  }
  // Only sslip.io pins the IP by itself; a pinned one elsewhere is a hidden answer.
  out.LIVEKIT_NODE_IP = a.pinnedIp !== undefined ? str(a.pinnedIp) : choice === 'sslip' ? ip : '';
  const urls: Record<AddressChoice, string> = {
    domain: a.domain ? `https://${str(a.domain)}` : '',
    duckdns: name ? `https://${name}.duckdns.org` : '',
    'duckdns-home': name ? `https://${name}.duckdns.org:${https}` : '',
    sslip: ip ? `https://${sslipHost(ip)}` : '',
    tunnel: a.tunnelHost ? `https://${str(a.tunnelHost)}` : '',
    external: str(a.externalUrl).replace(/\/$/, ''),
  };
  out.PUBLIC_URL = a.publicUrl !== undefined ? str(a.publicUrl).replace(/\/$/, '') : urls[choice];
  return out;
}

/** The media ports these answers make (defaults included). */
export function mediaPorts(a: Answers, env: Pick<ModelEnv, 'file'>): { tcp: string; udp: string } {
  if (a.mediaPorts === 'change') return { tcp: str(a.mediaTcp) || '7881', udp: str(a.mediaUdp) || '7882' };
  return { tcp: env.file.MEDIA_TCP_PORT || '7881', udp: env.file.MEDIA_UDP_PORT || '7882' };
}

/** What publicPorts()/hostPorts() need: the address and the media (no media ports with LiveKit Cloud). */
export function portsValues(a: Answers, env: Pick<ModelEnv, 'file' | 'host'>): Values {
  const { tcp, udp } = mediaPorts(a, env);
  return { ...addressValues(a, env), HOSTING: str(a.hosting), MEDIA: a.media === 'cloud' ? 'cloud' : '', MEDIA_TCP_PORT: tcp, MEDIA_UDP_PORT: udp };
}

/** Why TURN over TLS on 443 cannot run with these values (loadConfig's rule), or null when it can. */
export function turnBlocked(v: Values): string | null {
  let publicHost: string;
  try {
    publicHost = new URL(v.PUBLIC_URL ?? '').hostname;
  } catch {
    return 'no address yet';
  }
  return turnIneligibility({
    media: v.MEDIA === 'cloud' ? 'cloud' : 'self',
    ingress: (v.INGRESS || 'direct') as Ingress,
    hosting: v.HOSTING === 'home' || v.HOSTING === 'vps' ? v.HOSTING : null,
    httpsPort: Number(v.HTTPS_PORT || '443'),
    publicUrl: v.PUBLIC_URL!,
    publicHost,
  });
}

/** TURN=auto already means on for these values (a DuckDNS or sslip.io name on a VPS). */
export const turnAuto = (v: Values): boolean => !turnBlocked(v) && turnAutoHost(hostOf(v.PUBLIC_URL));

/** The LiveKit Cloud project URL as loadConfig keeps it (wss://host), or null when it is not one. */
export function cloudUrl(v: string): string | null {
  try {
    const u = new URL(v.trim());
    return (u.protocol === 'wss:' || u.protocol === 'https:') && u.hostname ? `wss://${u.host}` : null;
  } catch {
    return null;
  }
}

/** Direct-mode ports below 1024 (a Linux user needs the sysctl for them). */
export function lowPorts(a: Answers, env: Pick<ModelEnv, 'host'>): number[] {
  const v = addressValues(a, env);
  if (v.INGRESS !== 'direct') return [];
  return [Number(v.HTTP_PORT || 80), Number(v.HTTPS_PORT || 443)].filter((p) => p > 0 && p < 1024);
}

/** The login redirect Discord must list; '' while the address is unknown. */
export function redirectUri(a: Answers, env: Pick<ModelEnv, 'host'>): string {
  const url = addressValues(a, env).PUBLIC_URL;
  return url ? `${url.replace(/\/$/, '')}/auth/callback` : '';
}

/** Secret questions and the telinha.env key each one fills. */
export const SECRET_ANSWERS: Partial<Record<QuestionId, string>> = {
  discordToken: 'DISCORD_TOKEN', clientSecret: 'DISCORD_CLIENT_SECRET', tunnelToken: 'TUNNEL_TOKEN', duckToken: 'DUCKDNS_TOKEN', cloudSecret: 'LIVEKIT_API_SECRET',
};

function hostLines(env: ModelEnv): Text[] {
  const h = env.host;
  if (!h) return [txt('hostChecking')];
  const os = h.docker ? `${h.osName} (Docker)` : h.osName;
  const lines = [h.publicIp ? txt('hostLineIp', { os, arch: h.arch, ip: h.publicIp }) : txt('hostLineNoIp', { os, arch: h.arch })];
  const router = h.nat && routerLabel(h.nat);
  if (router) lines.push(txt('hostRouter', { router }));
  return lines;
}

function upnpHint(a: Answers, env: ModelEnv): Text[] {
  const choice = addressChoice(a);
  const v = portsValues(a, env);
  // What must reach this machine follows the address: a tunnel or a proxy needs only the
  // media ports, the high HTTPS port joins them, and 80/443 are never asked of the router.
  const first = choice === 'duckdns-home' ? txt('upnpHelpHttps', { port: v.HTTPS_PORT! }) : directLow(choice) ? txt('advUpnpHelp') : txt('upnpHelp');
  const lan = env.host?.nat?.localIp;
  const out: Text[] = [first, raw(''), txt('upnpPorts'), ...publicPorts(v).map((p) => raw(`  ${p}${lan ? ` → ${lan}` : ''}`))];
  const nat = env.host?.nat;
  if (nat) {
    const router = routerLabel(nat);
    out.push(raw(''), router ? txt('hostRouter', { router }) : txt('routerNone'));
    const ext = nat.externalIp;
    // LiveKit Cloud takes the media ports off the router; the HTTPS port still needs it.
    if (ext && isCgnatIpv4(ext)) out.push(txt(isCloud(a) ? 'cgnatCloud' : 'cgnat'));
    else if (ext && isPrivateIpv4(ext)) out.push(txt('doubleNat'));
  }
  return out;
}

function mediaHint(a: Answers, env: ModelEnv): Text[] {
  const v = portsValues(a, env);
  const out: Text[] = [txt('mediaHelp')];
  if (a.hosting === 'vps') {
    // The provider's firewall and the machine's own are what block on a VPS (no ufw automation).
    out.push(raw(''), txt('vpsFirewall', { ports: publicPorts(v).join(', ') }));
    if (env.platform === 'linux') {
      const cmds = firewallCommands(hostPorts(v), () => 'x');
      if (cmds.ufw) out.push(txt('vpsFwUfw', { cmd: cmds.ufw }));
      if (cmds.firewalld) out.push(txt('vpsFwFirewalld', { cmd: cmds.firewalld }));
    }
  }
  if (env.platform === 'win32' && env.compiled && !env.docker && !env.flags.noService && !env.flags.noFirewall) out.push(raw(''), txt('winFirewall'));
  return out;
}

const portOk = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;
const snowflake = (v: string | string[]) => (SNOWFLAKE_RE.test(str(v)) ? null : txt('idBad'));
const hostname = (v: string | string[]) => (parseHost(str(v)) ? null : txt('hostBad'));
const splitIds = (v: string) => v.split(',').map((c) => c.trim()).filter(Boolean);

function mediaCheck(v: string | string[], a: Answers, env: ModelEnv): Text | null {
  const s = str(v);
  if (!portOk(s)) return txt('portBad');
  // The HTTPS port was just chosen (at home a high one, within reach of a typo here).
  const addr = addressValues(a, env);
  return addr.INGRESS === 'direct' && s === (addr.HTTPS_PORT || '443') ? txt('mediaPortIsHttps') : null;
}

/** The file's role and channels belong to its server: another one is asked again. */
const sameGuild = (a: Answers, env: ModelEnv) => !env.file.GUILD_ID || a.guild === env.file.GUILD_ID;

const select = (value: string, label: Text, more: Omit<OptionDef, 'value' | 'label'> = {}): OptionDef => ({ value, label, ...more });
const isHome = (a: Answers) => a.hosting === 'home';
const isCloud = (a: Answers) => a.media === 'cloud';
/** At home behind carrier-grade NAT nothing reaches this machine: LiveKit Cloud is the way out for the video. */
const behindCgnat = (a: Answers, env: ModelEnv) => isHome(a) && isCgnatIpv4(env.host?.nat?.externalIp ?? '');
/** The file's LiveKit Cloud answers (a self file's generated pair is not a Cloud project's). */
const cloudFile = (env: ModelEnv, key: string) => (env.file.MEDIA === 'cloud' && env.file[key]) || undefined;
/** The tray icon exists for the native Windows binary only. */
export const trayHere = (env: Pick<ModelEnv, 'platform' | 'compiled' | 'docker'>): boolean => env.platform === 'win32' && env.compiled && !env.docker;
/** An earlier setup decided about the icon: its file (or the kept copy) is there. */
const trayKnown = (env: ModelEnv) => !!env.tray && (env.tray.installed || env.tray.optedOut);
const choiceIs = (...c: AddressChoice[]) => (a: Answers) => c.includes(addressChoice(a)!);

export const QUESTIONS: readonly QuestionDef[] = [
  // --- where
  {
    id: 'lang', step: 'where', kind: 'select',
    visible: (_a, env) => !env.langFlag && !env.file.LOCALE,
    title: txt('langTitle'), question: txt('langQ'),
    options: () => [select('en', txt('langEn')), select('pt-BR', txt('langPt'))],
    default: (_a, env) => env.locale ?? 'en',
    fromFile: () => false,
  },
  {
    id: 'hosting', step: 'where', kind: 'select', visible: () => true,
    title: txt('hostingTitle'), question: txt('hostingQ'),
    hint: (_a, env) => hostLines(env),
    options: () => [
      select('home', txt('hostingHome'), { desc: txt('hostingHomeDesc'), preview: txt('hostingHomePreview') }),
      select('vps', txt('vpsHosting'), { desc: txt('vpsHostingDesc'), preview: txt('vpsHostingPreview') }),
    ],
    // The file's answer wins; the machine only suggests (home until it is known).
    default: (_a, env) => fileHosting(env.file) ?? (env.host ? guessHosting(env.host) : 'home'),
    fromFile: (_a, env) => fileHosting(env.file) !== null,
  },

  // --- address
  {
    id: 'homeCf', step: 'address', kind: 'select', visible: isHome,
    title: txt('homeCfTitle'), question: txt('homeCfQ'),
    options: () => [
      select('yes', txt('homeCfYes'), { desc: txt('homeCfYesDesc'), preview: txt('homeCfYesPreview') }),
      select('no', txt('homeCfNo'), { desc: txt('homeCfNoDesc'), preview: txt('homeCfNoPreview') }),
      select('advanced', txt('advHomeCf'), { desc: txt('advHomeCfDesc'), preview: txt('advHomeCfPreview'), subtle: true }),
    ],
    // Advanced is only ever the default when this very file already is an advanced home setup.
    default: (_a, env) => homeChoice(env.file),
    fromFile: (_a, env) => fileHosting(env.file) === 'home' && !!env.file.PUBLIC_URL,
  },
  {
    id: 'homeAdvanced', step: 'address', kind: 'select', visible: (a) => isHome(a) && a.homeCf === 'advanced',
    title: txt('advTitle'), question: txt('advQ'),
    options: (_a, env) => [
      select('ports', txt('advPorts'), { desc: txt('advPortsDesc'), preview: txt('advPortsPreview') }),
      select('proxy', txt('advProxy'), { desc: txt('advProxyDesc'), preview: txt('advProxyPreview', { port: listenPort(env.file) }) }),
    ],
    default: (_a, env) => (env.file.INGRESS === 'external' ? 'proxy' : 'ports'),
    fromFile: (_a, env) => fileHosting(env.file) === 'home' && homeChoice(env.file) === 'advanced',
  },
  {
    id: 'advancedAddress', step: 'address', kind: 'select',
    visible: (a) => isHome(a) && a.homeCf === 'advanced' && a.homeAdvanced === 'ports',
    title: txt('advAddressTitle'), question: txt('advAddressQ'),
    hint: () => [txt('advAddressNote')],
    options: (_a, env) => [
      select('domain', txt('choiceDomain'), { desc: txt('choiceDomainDesc'), preview: domainPreview(env) }),
      select('duckdns', txt('choiceDuck'), { desc: txt('choiceDuckDesc'), preview: txt('choiceDuckPreview') }),
    ],
    default: (_a, env) => (currentChoice(env.file) === 'duckdns' ? 'duckdns' : 'domain'),
    fromFile: (_a, env) => fileHosting(env.file) === 'home' && homeChoice(env.file) === 'advanced',
  },
  {
    id: 'vpsAddress', step: 'address', kind: 'select', visible: (a) => a.hosting === 'vps',
    title: txt('vpsAddressTitle'), question: txt('vpsAddressQ'),
    options: (_a, env) => {
      const ip = env.host?.publicIp;
      return [
        select('domain', txt('choiceDomain'), { desc: txt('choiceDomainDesc'), preview: domainPreview(env) }),
        select('duckdns', txt('choiceDuck'), { desc: txt('choiceDuckDesc'), preview: txt('choiceDuckPreview') }),
        select('sslip', txt('vpsSslip'), { desc: txt('vpsSslipDesc'), preview: ip ? txt('vpsSslipPreviewUrl', { url: `https://${sslipHost(ip)}` }) : txt('vpsSslipPreview') }),
        select('tunnel', txt('vpsTunnel'), { desc: txt('vpsTunnelDesc'), preview: txt('vpsTunnelPreview') }),
        select('external', txt('vpsExternal'), { desc: txt('vpsExternalDesc'), preview: txt('advProxyPreview', { port: listenPort(env.file) }), subtle: true }),
      ];
    },
    default: (_a, env) => currentChoice(env.file),
    fromFile: (_a, env) => fileHosting(env.file) === 'vps' && !!env.file.PUBLIC_URL,
  },
  {
    id: 'domain', step: 'address', kind: 'text', visible: choiceIs('domain'),
    title: txt('domainTitle'), question: txt('domainQ'), placeholder: txt('domainPlaceholder'),
    hint: (_a, env) => [env.host?.publicIp ? txt('domainHint', { ip: env.host.publicIp }) : txt('domainHintNoIp')],
    default: (_a, env) => (currentChoice(env.file) === 'domain' && hostOf(env.file.PUBLIC_URL)) || undefined,
    validate: hostname,
    normalize: (v) => parseHost(v) ?? v,
    lookup: 'dns',
  },
  {
    id: 'duckName', step: 'address', kind: 'text', visible: choiceIs('duckdns', 'duckdns-home'),
    title: txt('duckNameTitle'), question: txt('duckNameQ'), placeholder: txt('duckNamePlaceholder'),
    hint: () => [txt('duckHelp')],
    default: (_a, env) => env.file.DUCKDNS_DOMAIN || undefined,
    validate: (v) => (parseDuckDomain(str(v)) ? null : txt('duckDomainBad')),
    normalize: (v) => parseDuckDomain(v) ?? v,
  },
  {
    id: 'duckToken', step: 'address', kind: 'secret', visible: choiceIs('duckdns', 'duckdns-home'),
    title: txt('duckTokenTitle'), question: txt('duckTokenQ'),
    hint: (a) => [txt('duckHelp'), raw(''), txt('duckTokenHint', { name: str(a.duckName) || 'name' })],
    // A token belongs to its name: another name starts empty.
    default: (a, env) => (env.file.DUCKDNS_DOMAIN && env.file.DUCKDNS_DOMAIN === a.duckName ? env.file.DUCKDNS_TOKEN || undefined : undefined),
    lookup: 'duckdns',
  },
  {
    id: 'httpsPort', step: 'address', kind: 'text', visible: choiceIs('duckdns-home'),
    title: txt('httpsPortTitle'), question: txt('httpsPortQ'), placeholder: raw(DEFAULT_HOME_HTTPS_PORT),
    hint: (a) => {
      const port = str(a.httpsPort) || DEFAULT_HOME_HTTPS_PORT;
      return [txt('httpsPortHint', { port }), raw(''), txt('httpsPortUrl', { name: str(a.duckName) || 'name', port })];
    },
    // The previous high port when the file has one; 80/443 would only be refused.
    default: (_a, env) => (env.file.ACME_DNS === 'duckdns' && highPortOk(env.file.HTTPS_PORT) ? env.file.HTTPS_PORT! : DEFAULT_HOME_HTTPS_PORT),
    validate: (v, _a, env) => {
      const s = str(v);
      if (!/^\d+$/.test(s) || Number(s) > 65535) return txt('portBad');
      if (Number(s) < 1024) return txt('httpsPortLow');
      const taken = takenPort(env.file, Number(s));
      return taken ? txt('httpsPortTaken', { what: taken }) : null;
    },
    fromFile: (_a, env) => env.file.ACME_DNS === 'duckdns',
  },
  {
    id: 'nodeIp', step: 'address', kind: 'text', visible: (a, env) => addressChoice(a) === 'sslip' && !env.host?.publicIp,
    title: txt('vpsNodeIpTitle'), question: txt('vpsNodeIpQ'), placeholder: txt('vpsNodeIpPlaceholder'),
    hint: () => [txt('vpsSslipPreview')],
    default: (_a, env) => env.file.LIVEKIT_NODE_IP || undefined,
    validate: (v) => (IPV4_RE.test(str(v)) ? null : txt('ipBad')),
  },
  {
    id: 'tunnelToken', step: 'address', kind: 'secret', visible: choiceIs('tunnel'),
    title: txt('tunnelTokenTitle'), question: txt('tunnelTokenQ'),
    hint: (_a, env) => [txt('tunnelHelp', { port: listenPort(env.file) })],
    default: (_a, env) => env.file.TUNNEL_TOKEN || undefined,
    // Cloudflare shows the token only inside an install command; pasting the whole line is fine.
    validate: (v) => (validTunnelToken(extractTunnelToken(str(v))) ? null : txt('tunnelTokenBad')),
    normalize: (v) => extractTunnelToken(v),
  },
  {
    id: 'tunnelHost', step: 'address', kind: 'text', visible: choiceIs('tunnel'),
    title: txt('tunnelHostTitle'), question: txt('tunnelHostQ'), placeholder: txt('domainPlaceholder'),
    hint: (_a, env) => [txt('tunnelHelp', { port: listenPort(env.file) })],
    default: (_a, env) => (env.file.INGRESS === 'tunnel' && hostOf(env.file.PUBLIC_URL)) || undefined,
    validate: hostname,
    normalize: (v) => parseHost(v) ?? v,
  },
  {
    id: 'externalUrl', step: 'address', kind: 'text', visible: choiceIs('external'),
    title: txt('externalTitle'), question: txt('externalQ'), placeholder: txt('externalPlaceholder'),
    hint: (_a, env) => [txt('advProxyPreview', { port: listenPort(env.file) })],
    default: (_a, env) => (env.file.INGRESS === 'external' && env.file.PUBLIC_URL) || undefined,
    validate: (v) => {
      try {
        const u = new URL(str(v));
        return (u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/' ? null : txt('urlBad');
      } catch {
        return txt('urlBad');
      }
    },
    normalize: (v) => v.replace(/\/$/, ''),
  },

  // --- discord
  {
    id: 'discordToken', step: 'discord', kind: 'secret', visible: () => true,
    title: txt('discordTokenTitle'), question: txt('discordTokenQ'),
    hint: (_a, env) => [txt('discordTokenHelp'), ...(env.offline ? [raw(''), txt('discordOffline')] : [])],
    default: (_a, env) => env.file.DISCORD_TOKEN || undefined,
    lookup: 'discordApp',
  },
  {
    id: 'clientId', step: 'discord', kind: 'text', visible: (_a, env) => env.offline,
    title: txt('clientIdTitle'), question: txt('clientIdQ'),
    default: (_a, env) => env.file.DISCORD_CLIENT_ID || undefined,
    validate: snowflake,
  },
  {
    id: 'clientSecret', step: 'discord', kind: 'secret', visible: () => true,
    title: txt('clientSecretTitle'), question: txt('clientSecretQ'),
    hint: () => [txt('secretHelp')],
    default: (_a, env) => env.file.DISCORD_CLIENT_SECRET || undefined,
    lookup: 'clientSecret',
  },
  {
    id: 'redirect', step: 'discord', kind: 'select',
    // Asked only when the app was read and lacks it: the API cannot add it.
    visible: (a, env) => {
      const uri = redirectUri(a, env);
      return !env.offline && !!env.lookups.app && !!uri && !env.lookups.app.redirectUris.includes(uri);
    },
    title: txt('redirectTitle'), question: txt('redirectQ'),
    hint: () => [txt('redirectHelp')],
    link: (a, env) => redirectUri(a, env) || null,
    options: () => [select('check', txt('redirectCheck')), select('skip', txt('redirectSkip'))],
    default: () => undefined,
    lookup: 'redirect',
    fromFile: () => false,
  },
  {
    id: 'guild', step: 'discord', kind: 'select', visible: () => true, offlineText: true,
    title: txt('guildTitle'), question: txt('guildQ'),
    hint: (_a, env) => (env.offline ? [txt('guildIdQ')] : []),
    options: (_a, env) => {
      const guilds = env.lookups.guilds;
      if (env.offline || !guilds?.length) return [];
      return [...guilds.map((g) => select(g.id, raw(g.name))), select('+invite', txt('guildOther'), { subtle: true })];
    },
    default: (_a, env) => env.file.GUILD_ID || undefined,
    validate: (v, _a, env) => (env.offline ? snowflake(v) : null),
    lookup: 'guilds',
  },
  {
    id: 'role', step: 'discord', kind: 'select', visible: (a) => !!str(a.guild) && a.guild !== '+invite', offlineText: true,
    title: txt('roleTitle'), question: txt('roleQ'),
    hint: () => [txt('roleHelp')],
    options: (a, env) => {
      const guild = str(a.guild);
      const roles = env.lookups.roles?.[guild];
      if (env.offline || !roles) return [];
      return [...pickableRoles(roles, guild).map((r) => select(r.id, raw(`@${r.name}`))), select(guild, txt('roleEveryone'))];
    },
    default: (_a, env) => env.file.ROLE_ID || undefined,
    fromFile: sameGuild,
    validate: (v, _a, env) => (env.offline ? snowflake(v) : null),
    lookup: 'roles',
  },
  {
    id: 'channels', step: 'discord', kind: 'multi', visible: (a) => !!str(a.guild) && a.guild !== '+invite', offlineText: true, min: 1,
    title: txt('channelsTitle'), question: txt('channelsQ'),
    hint: () => [txt('channelsHelp')],
    options: (a, env) => {
      const list = env.lookups.channels?.[str(a.guild)];
      if (env.offline || !list) return [];
      return list.map(({ channel, category }) => select(channel.id, raw(category ? `${category} › #${channel.name}` : `#${channel.name}`)));
    },
    default: (_a, env) => (env.file.CHANNEL_IDS ? splitIds(env.file.CHANNEL_IDS) : undefined),
    fromFile: sameGuild,
    validate: (v, _a, env) => {
      const ids = Array.isArray(v) ? v : splitIds(v);
      if (!ids.length) return env.offline ? txt('required') : txt('channelsMin');
      return ids.every((c) => SNOWFLAKE_RE.test(c)) ? null : txt('idBad');
    },
    normalize: (v) => splitIds(v),
    lookup: 'channels',
  },
  {
    id: 'command', step: 'discord', kind: 'text', visible: () => true,
    title: txt('commandTitle'), question: txt('commandQ'), placeholder: raw('telinha'),
    hint: (a) => [txt('commandHint', { name: str(a.command) || 'telinha' })],
    default: (_a, env) => env.file.COMMAND_NAME || 'telinha',
    validate: (v) => (validCommand(str(v)) ? null : txt('commandBad')),
  },
  {
    id: 'group', step: 'discord', kind: 'text', visible: () => true, optional: true,
    title: txt('groupTitle'), question: txt('groupQ'),
    hint: (a, env) => [txt('groupHint', { name: guildName(a, env) || '-' })],
    placeholderFor: (a, env) => {
      const name = guildName(a, env);
      return name ? raw(name) : undefined;
    },
    default: (_a, env) => env.file.GROUP_NAME ?? '',
  },

  // --- media
  {
    id: 'media', step: 'media', kind: 'select', visible: () => true,
    title: txt('mediaChoiceTitle'), question: txt('mediaChoiceQ'),
    hint: (a, env) => [txt('mediaChoiceHelp'), ...(behindCgnat(a, env) ? [raw(''), txt('mediaCgnat')] : [])],
    options: () => [
      select('self', txt('mediaSelf'), { desc: txt('mediaSelfDesc'), preview: txt('mediaSelfPreview') }),
      select('cloud', txt('mediaCloud'), { desc: txt('mediaCloudDesc'), preview: txt('mediaCloudPreview') }),
    ],
    default: (a, env) => (env.file.MEDIA === 'cloud' || behindCgnat(a, env) ? 'cloud' : 'self'),
    // Behind CGNAT a self file is asked again: its media ports never worked.
    fromFile: (a, env) => !!env.file.PUBLIC_URL && (env.file.MEDIA === 'cloud' || !behindCgnat(a, env)),
  },
  {
    id: 'cloudUrl', step: 'media', kind: 'text', visible: isCloud,
    title: txt('cloudUrlTitle'), question: txt('cloudUrlQ'), placeholder: raw('wss://my-project.livekit.cloud'),
    hint: () => [txt('cloudUrlHelp'), raw(''), txt('cloudAutoCreate')],
    default: (_a, env) => cloudFile(env, 'LIVEKIT_CLOUD_URL'),
    validate: (v) => (cloudUrl(str(v)) ? null : txt('cloudUrlBad')),
    normalize: (v) => cloudUrl(v) ?? v,
  },
  {
    id: 'cloudKey', step: 'media', kind: 'text', visible: isCloud,
    title: txt('cloudKeyTitle'), question: txt('cloudKeyQ'), placeholder: raw('APIxxxxxxxxxxxx'),
    hint: () => [txt('cloudKeyHelp')],
    default: (_a, env) => cloudFile(env, 'LIVEKIT_API_KEY'),
    validate: (v) => (/^\S+$/.test(str(v)) ? null : txt('required')),
    normalize: (v) => v.trim(),
  },
  {
    id: 'cloudSecret', step: 'media', kind: 'secret', visible: isCloud,
    title: txt('cloudSecretTitle'), question: txt('cloudSecretQ'),
    hint: () => [txt('cloudKeyHelp'), raw(''), txt('cloudAutoCreate')],
    default: (_a, env) => cloudFile(env, 'LIVEKIT_API_SECRET'),
  },
  {
    id: 'turn', step: 'media', kind: 'select',
    // A VPS in direct mode on 443 with a name, and LiveKit on this machine: loadConfig's own rule.
    visible: (a, env) => !isCloud(a) && !turnBlocked(portsValues(a, env)),
    title: txt('turnTitle'), question: txt('turnQ'),
    hint: (a, env) => {
      const host = hostOf(addressValues(a, env).PUBLIC_URL);
      // An own domain needs the record first; DuckDNS and sslip.io names resolve by themselves.
      const dns = addressChoice(a) === 'domain'
        ? (env.host?.publicIp ? txt('turnDnsHint', { host: `turn.${host}`, ip: env.host.publicIp }) : txt('turnDnsHintNoIp', { host: `turn.${host}` }))
        : txt('turnAutoHint', { host: `turn.${host}` });
      return [txt('turnHelp'), raw(''), dns];
    },
    options: () => [select('on', txt('turnOn'), { desc: txt('turnOnDesc') }), select('off', txt('turnOff'), { desc: txt('turnOffDesc') })],
    // A fresh install says yes; a re-run says what the file does (auto is off where the name needs a record).
    default: (a, env) => {
      if (env.file.TURN === 'on' || env.file.TURN === 'off') return env.file.TURN;
      return env.file.PUBLIC_URL && !turnAuto(portsValues(a, env)) ? 'off' : 'on';
    },
    fromFile: (_a, env) => !!env.file.PUBLIC_URL,
  },

  // --- ports
  {
    id: 'mediaPorts', step: 'ports', kind: 'select', visible: (a) => !isCloud(a),
    title: txt('mediaTitle'), question: txt('mediaQ'),
    hint: mediaHint,
    options: (_a, env) => {
      const tcp = env.file.MEDIA_TCP_PORT || '7881';
      const udp = env.file.MEDIA_UDP_PORT || '7882';
      return [select('keep', txt('mediaKeep', { tcp, udp }), { desc: txt('mediaKeepDesc') }), select('change', txt('mediaChange'), { desc: txt('mediaChangeDesc') })];
    },
    default: () => 'keep',
  },
  {
    id: 'mediaTcp', step: 'ports', kind: 'text', visible: (a) => !isCloud(a) && a.mediaPorts === 'change',
    title: txt('mediaTcpTitle'), question: txt('mediaTcpQ'), placeholder: raw('7881'),
    hint: mediaHint,
    default: (_a, env) => env.file.MEDIA_TCP_PORT || '7881',
    validate: mediaCheck,
    lookup: 'ports',
  },
  {
    id: 'mediaUdp', step: 'ports', kind: 'text', visible: (a) => !isCloud(a) && a.mediaPorts === 'change',
    title: txt('mediaUdpTitle'), question: txt('mediaUdpQ'), placeholder: raw('7882'),
    hint: mediaHint,
    default: (_a, env) => env.file.MEDIA_UDP_PORT || '7882',
    validate: mediaCheck,
    lookup: 'ports',
  },
  {
    id: 'sysctl', step: 'ports', kind: 'select',
    // A Linux user binding 80/443 (a VPS, or a home that opened them itself) needs one sysctl, once.
    visible: (a, env) => {
      if (env.platform !== 'linux' || env.isRoot || !env.compiled || env.docker || env.flags.noService) return false;
      const low = lowPorts(a, env);
      return low.length > 0 && (env.unprivilegedPortStart === null || env.unprivilegedPortStart > Math.min(...low));
    },
    title: txt('sysctlTitle'), question: txt('sysctlQ'),
    hint: (a, env) => [txt('sysctlExplain', { ports: lowPorts(a, env).join(', ') })],
    options: () => [select('sudo', txt('sysctlSudo'), { desc: txt('sysctlSudoDesc') }), select('manual', txt('sysctlManual'), { desc: txt('sysctlManualDesc') })],
    default: () => 'sudo',
    fromFile: () => false,
  },
  {
    // Asked when something must reach this machine (LiveKit Cloud behind a tunnel needs nothing).
    id: 'upnp', step: 'ports', kind: 'select', visible: (a, env) => isHome(a) && publicPorts(portsValues(a, env)).length > 0,
    title: txt('upnpTitle'), question: txt('upnpQ'),
    hint: upnpHint,
    options: () => [select('auto', txt('upnpAuto'), { desc: txt('upnpAutoDesc') }), select('off', txt('upnpOff'), { desc: txt('upnpOffDesc') })],
    // A VPS file wrote off by itself (no router there): moving home starts from auto again.
    default: (_a, env) => (env.file.HOSTING === 'vps' || env.file.UPNP !== 'off' ? 'auto' : 'off'),
    fromFile: (_a, env) => env.file.HOSTING === 'home',
  },

  // --- updates
  {
    id: 'autoUpdate', step: 'updates', kind: 'select', visible: (_a, env) => env.compiled && !env.docker,
    title: txt('updatesTitle'), question: txt('updatesQ'),
    hint: () => [txt('updatesHelp')],
    options: () => [select('on', txt('updatesOn'), { desc: txt('updatesOnDesc') }), select('off', txt('updatesOff'), { desc: txt('updatesOffDesc') })],
    default: (_a, env) => (env.file.AUTO_UPDATE !== 'off' ? 'on' : 'off'),
  },

  // --- tray
  {
    id: 'tray', step: 'tray', kind: 'select', visible: (_a, env) => trayHere(env),
    title: txt('trayTitle'), question: txt('trayQ'),
    hint: () => [txt('trayHelp')],
    options: () => [select('yes', txt('trayYes'), { desc: txt('trayYesDesc') }), select('no', txt('trayNo'), { desc: txt('trayNoDesc') })],
    default: (_a, env) => (env.tray?.optedOut && !env.tray.installed ? 'no' : 'yes'),
    fromFile: (_a, env) => trayKnown(env),
  },
  {
    id: 'trayAutostart', step: 'tray', kind: 'select', visible: (a, env) => trayHere(env) && a.tray === 'yes',
    title: txt('trayAutoTitle'), question: txt('trayAutoQ'),
    hint: () => [txt('trayAutoHelp')],
    options: () => [select('no', txt('trayAutoNo'), { desc: txt('trayAutoNoDesc') }), select('yes', txt('trayAutoYes'), { desc: txt('trayAutoYesDesc') })],
    default: (_a, env) => (env.tray?.autostart ? 'yes' : 'no'),
    fromFile: (_a, env) => trayKnown(env),
  },
];

/** What the install does with the tray icon; null where there is none. */
export function trayChoice(a: Answers, env: Pick<ModelEnv, 'platform' | 'compiled' | 'docker'>): TrayChoice | null {
  if (!trayHere(env)) return null;
  const install = a.tray !== 'no';
  return { install, autostart: install && a.trayAutostart === 'yes' };
}

function domainPreview(env: ModelEnv): Text {
  const ip = env.host?.publicIp;
  return ip ? txt('choiceDomainPreview', { ip }) : txt('choiceDomainPreviewNoIp');
}

function highPortOk(p: string | undefined): boolean {
  return !!p && /^\d+$/.test(p) && Number(p) >= 1024 && Number(p) <= 65535;
}

/** The chosen server's name as Discord lists it; '' when not loaded (or offline). */
export function guildName(a: Answers, env: Pick<ModelEnv, 'lookups'>): string {
  return env.lookups.guilds?.find((g) => g.id === a.guild)?.name ?? '';
}

const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));
const INDEX = new Map(QUESTIONS.map((q, i) => [q.id, i]));

export function question(id: QuestionId): QuestionDef {
  const q = BY_ID.get(id);
  if (!q) throw new Error(`unknown question ${id}`);
  return q;
}

/** Catalog position: flow order. */
export const catalogIndex = (id: QuestionId): number => INDEX.get(id) ?? -1;

/** The kind shown: the Discord lists become typed ids offline. */
export const kindOf = (q: QuestionDef, env: Pick<ModelEnv, 'offline'>): QuestionKind => (env.offline && q.offlineText ? 'text' : q.kind);

/** 'updates' only for the native binary outside Docker (Docker has telinha-update); 'tray' only on Windows there. */
export function stepsFor(env: Pick<ModelEnv, 'compiled' | 'docker'> & Partial<Pick<ModelEnv, 'platform'>>): StepId[] {
  const native = env.compiled && !env.docker;
  return [
    'where', 'address', 'discord', 'media', 'ports',
    ...(native ? (['updates'] as const) : []),
    ...(native && env.platform === 'win32' ? (['tray'] as const) : []),
    'review', 'install',
  ];
}

/** Visible questions in catalog order. */
export function flowIds(a: Answers, env: ModelEnv): QuestionId[] {
  return QUESTIONS.filter((q) => q.visible(a, env)).map((q) => q.id);
}

/** Non-empty string / non-empty array; optional questions and hidden answers count when present. */
export function answered(a: Answers, id: AnswerId): boolean {
  const v = a[id];
  if (v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if ((HIDDEN_IDS as readonly string[]).includes(id) || BY_ID.get(id as QuestionId)?.optional) return true;
  return v !== '';
}
