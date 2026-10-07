import { describe, expect, test } from 'bun:test';
import type { NatProbe } from '../src/nat/index.ts';
import type { HostInfo } from '../src/cli/setup/host.ts';
import {
  addressChoice, addressValues, ALWAYS_COUNTED, answered, flowIds, kindOf, lowPorts, question, QUESTIONS, redirectUri, stepsFor, trayChoice,
  type Answers, type ModelEnv, type QuestionId,
} from '../src/cli/setup/model.ts';
import { q } from '../src/cli/setup/qstrings.ts';

const NAT: NatProbe = {
  gateway: { kind: 'igd', version: 2, location: 'http://192.168.0.1:49152/d.xml', controlUrl: 'http://192.168.0.1/c', serviceType: 'x', localIp: '192.168.0.10', gatewayIp: '192.168.0.1', name: 'Fritz!Box' },
  externalIp: '203.0.113.9', localIp: '192.168.0.10', errors: [],
};
const HOME: HostInfo = { kind: 'linux-root', platform: 'linux', arch: 'x64', isRoot: true, docker: false, osName: 'Debian GNU/Linux 12 (bookworm)', publicIp: '203.0.113.9', nat: NAT };
const VPS: HostInfo = { ...HOME, nat: { gateway: null, externalIp: null, localIp: '203.0.113.9', errors: [] } };

function envOf(o: Partial<ModelEnv> = {}): ModelEnv {
  return {
    platform: 'linux', isRoot: true, docker: false, compiled: false, offline: false, langFlag: false,
    flags: { noService: false, noUpnp: false, noFirewall: false, noDoctor: false },
    file: {}, host: HOME, unprivilegedPortStart: null, lookups: {}, locale: 'en', ...o,
  };
}

const DISCORD = ['discordToken', 'clientSecret', 'guild', 'command', 'group'] as const;
const flowOf = (a: Answers, env = envOf()) => flowIds(a, env);

describe('the catalog', () => {
  test('ids are unique, every step is a known one, flow order is catalog order', () => {
    const ids = QUESTIONS.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 2)).toEqual(['lang', 'hosting']);
    const steps = QUESTIONS.map((x) => x.step);
    // Steps never interleave: Where, Address, Discord, Ports, Updates, Tray icon.
    expect([...new Set(steps)]).toEqual(['where', 'address', 'discord', 'ports', 'updates', 'tray']);
    for (const id of ids) expect(question(id).id).toBe(id);
    expect(() => question('nope' as QuestionId)).toThrow();
  });

  test('ALWAYS_COUNTED: the hidden answers and the client id', () => {
    expect([...ALWAYS_COUNTED].sort()).toEqual(['clientId', 'httpPort', 'httpsPortDirect', 'pinnedIp', 'publicUrl']);
  });

  test('the first question is only home vs a rented server; the home branch never defaults to advanced', () => {
    const env = envOf();
    expect(question('hosting').options!({}, env).map((o) => o.value)).toEqual(['home', 'vps']);
    const cf = question('homeCf').options!({}, env);
    expect(cf.map((o) => [o.value, !!o.subtle])).toEqual([['yes', false], ['no', false], ['advanced', true]]);
    const home = (file: Record<string, string>) => question('homeCf').default({ hosting: 'home' }, envOf({ file }));
    expect(home({})).toBe('no');
    expect(home({ HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: 'https://t.example.com' })).toBe('no');
    expect(home({ HOSTING: 'home', INGRESS: 'direct', ACME_DNS: 'duckdns', PUBLIC_URL: 'https://x.duckdns.org:8443' })).toBe('no');
    expect(home({ HOSTING: 'home', INGRESS: 'tunnel', PUBLIC_URL: 'https://t.example.com' })).toBe('yes');
    // Only a file that already is an advanced home setup.
    expect(home({ HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://t.example.com' })).toBe('advanced');
    expect(home({ HOSTING: 'home', INGRESS: 'external', PUBLIC_URL: 'https://t.example.com' })).toBe('advanced');
    // The VPS list keeps its own proxy last and quiet too.
    expect(question('vpsAddress').options!({}, env).map((o) => [o.value, !!o.subtle])).toEqual([['domain', false], ['duckdns', false], ['sslip', false], ['tunnel', false], ['external', true]]);
  });

  test('home questions outside the advanced branch never mention opening 80/443 (EN and pt-BR)', () => {
    const env = envOf();
    const open = /\b(open|forward)\s+(the\s+)?(web\s+)?(ports?\s+)?(80|443)\b|\b(abra|abrir|redirecione|libere)\s+(as\s+|a\s+)?(portas?\s+)?(80|443)\b/i;
    for (const a of [{ hosting: 'home', homeCf: 'yes' }, { hosting: 'home', homeCf: 'no' }] as Answers[]) {
      for (const id of flowOf(a, env)) {
        const qd = question(id);
        const texts = [qd.title, qd.question, ...(qd.hint?.(a, env) ?? []), ...(qd.options?.(a, env) ?? []).filter((o) => !o.subtle).flatMap((o) => [o.label, o.desc, o.preview])];
        for (const t of texts) {
          if (!t || 'raw' in t) continue;
          for (const l of ['en', 'pt-BR'] as const) expect(`${id}: ${q(l, t.key, t.params)}`).not.toMatch(open);
        }
      }
    }
  });
});

describe('flowIds', () => {
  test('nothing answered: hosting, then the Discord and port questions; the address waits for its branch', () => {
    expect(flowOf({})).toEqual(['lang', 'hosting', ...DISCORD, 'mediaPorts']);
    expect(flowOf({}, envOf({ langFlag: true }))[0]).toBe('hosting');
    expect(flowOf({}, envOf({ file: { LOCALE: 'pt-BR' } }))[0]).toBe('hosting');
  });

  test('home: tunnel, DuckDNS on the high port, and the advanced choices', () => {
    const home = (a: Answers) => flowOf({ hosting: 'home', ...a }).filter((id) => question(id).step === 'address' || id === 'upnp');
    expect(home({})).toEqual(['homeCf', 'upnp']);
    expect(home({ homeCf: 'yes' })).toEqual(['homeCf', 'tunnelToken', 'tunnelHost', 'upnp']);
    expect(home({ homeCf: 'no' })).toEqual(['homeCf', 'duckName', 'duckToken', 'httpsPort', 'upnp']);
    expect(home({ homeCf: 'advanced' })).toEqual(['homeCf', 'homeAdvanced', 'upnp']);
    expect(home({ homeCf: 'advanced', homeAdvanced: 'ports' })).toEqual(['homeCf', 'homeAdvanced', 'advancedAddress', 'upnp']);
    expect(home({ homeCf: 'advanced', homeAdvanced: 'ports', advancedAddress: 'domain' })).toEqual(['homeCf', 'homeAdvanced', 'advancedAddress', 'domain', 'upnp']);
    expect(home({ homeCf: 'advanced', homeAdvanced: 'ports', advancedAddress: 'duckdns' })).toEqual(['homeCf', 'homeAdvanced', 'advancedAddress', 'duckName', 'duckToken', 'upnp']);
    expect(home({ homeCf: 'advanced', homeAdvanced: 'proxy' })).toEqual(['homeCf', 'homeAdvanced', 'externalUrl', 'upnp']);
    // Answers on the VPS branch do not leak into a home flow.
    expect(home({ homeCf: 'yes', vpsAddress: 'sslip', domain: 'x.example.com' })).toEqual(['homeCf', 'tunnelToken', 'tunnelHost', 'upnp']);
  });

  test('VPS: every address choice; no UPnP question; the IP only when it is not known', () => {
    const vps = (a: Answers, env = envOf({ host: VPS })) => flowOf({ hosting: 'vps', ...a }, env).filter((id) => question(id).step === 'address' || id === 'upnp');
    expect(vps({})).toEqual(['vpsAddress']);
    expect(vps({ vpsAddress: 'domain' })).toEqual(['vpsAddress', 'domain']);
    expect(vps({ vpsAddress: 'duckdns' })).toEqual(['vpsAddress', 'duckName', 'duckToken']);
    expect(vps({ vpsAddress: 'sslip' })).toEqual(['vpsAddress']);
    expect(vps({ vpsAddress: 'sslip' }, envOf({ host: { ...VPS, publicIp: null } }))).toEqual(['vpsAddress', 'nodeIp']);
    expect(vps({ vpsAddress: 'sslip' }, envOf({ host: null }))).toEqual(['vpsAddress', 'nodeIp']);
    expect(vps({ vpsAddress: 'tunnel' })).toEqual(['vpsAddress', 'tunnelToken', 'tunnelHost']);
    expect(vps({ vpsAddress: 'external' })).toEqual(['vpsAddress', 'externalUrl']);
  });

  test('the Discord step: role and channels after a server; offline asks the client id and types the ids', () => {
    expect(flowOf({ guild: '222222222222222222' }).filter((id) => question(id).step === 'discord')).toEqual(['discordToken', 'clientSecret', 'guild', 'role', 'channels', 'command', 'group']);
    const offline = envOf({ offline: true });
    expect(flowOf({ guild: '222222222222222222' }, offline).filter((id) => question(id).step === 'discord')).toEqual(['discordToken', 'clientId', 'clientSecret', 'guild', 'role', 'channels', 'command', 'group']);
    expect(['guild', 'role', 'channels'].map((id) => kindOf(question(id as QuestionId), offline))).toEqual(['text', 'text', 'text']);
    expect(kindOf(question('channels'), envOf())).toBe('multi');
  });

  test('the redirect question shows only when the app was read and lacks this address', () => {
    const app = { id: '1', name: 'b', flags: 0, botPublic: false, redirectUris: ['https://t.example.com/auth/callback'] };
    const a: Answers = { hosting: 'vps', vpsAddress: 'domain', domain: 't.example.com' };
    expect(flowOf(a)).not.toContain('redirect');
    expect(flowOf(a, envOf({ lookups: { app } }))).not.toContain('redirect');
    expect(flowOf({ ...a, domain: 'u.example.com' }, envOf({ lookups: { app } }))).toContain('redirect');
    expect(flowOf({ ...a, domain: 'u.example.com' }, envOf({ lookups: { app }, offline: true }))).not.toContain('redirect');
    expect(question('redirect').link!({ ...a, domain: 'u.example.com' }, envOf())).toBe('https://u.example.com/auth/callback');
  });

  test('ports: the media ports only when changing them; the sysctl for a Linux user on ports below 1024', () => {
    expect(flowOf({ mediaPorts: 'change' })).toContain('mediaTcp');
    const user = envOf({ isRoot: false, compiled: true, unprivilegedPortStart: 1024 });
    const vpsDomain: Answers = { hosting: 'vps', vpsAddress: 'domain' };
    expect(flowOf(vpsDomain, user)).toContain('sysctl');
    expect(lowPorts(vpsDomain, user)).toEqual([80, 443]);
    expect(flowOf(vpsDomain, { ...user, unprivilegedPortStart: 80 })).not.toContain('sysctl');
    expect(flowOf(vpsDomain, { ...user, unprivilegedPortStart: null })).toContain('sysctl');
    expect(flowOf({ hosting: 'home', homeCf: 'no' }, user)).not.toContain('sysctl');
    expect(flowOf({ hosting: 'vps', vpsAddress: 'tunnel' }, user)).not.toContain('sysctl');
    expect(flowOf(vpsDomain, { ...user, isRoot: true })).not.toContain('sysctl');
    expect(flowOf(vpsDomain, { ...user, compiled: false })).not.toContain('sysctl');
    expect(flowOf(vpsDomain, { ...user, docker: true })).not.toContain('sysctl');
    expect(flowOf(vpsDomain, { ...user, flags: { ...user.flags, noService: true } })).not.toContain('sysctl');
    expect(flowOf(vpsDomain, { ...user, platform: 'win32' })).not.toContain('sysctl');
  });
});

describe('steps', () => {
  test('Updates only for the native binary outside Docker', () => {
    expect(stepsFor({ compiled: true, docker: false })).toEqual(['where', 'address', 'discord', 'ports', 'updates', 'review', 'install']);
    expect(stepsFor({ compiled: false, docker: false })).toEqual(['where', 'address', 'discord', 'ports', 'review', 'install']);
    expect(stepsFor({ compiled: true, docker: true })).toEqual(['where', 'address', 'discord', 'ports', 'review', 'install']);
    expect(flowOf({}, envOf({ compiled: true }))).toContain('autoUpdate');
    expect(flowOf({}, envOf({ compiled: true, docker: true }))).not.toContain('autoUpdate');
    expect(flowOf({}, envOf({ compiled: false }))).not.toContain('autoUpdate');
  });

  test('Tray icon only for the native Windows binary outside Docker', () => {
    expect(stepsFor({ compiled: true, docker: false, platform: 'win32' })).toEqual(['where', 'address', 'discord', 'ports', 'updates', 'tray', 'review', 'install']);
    expect(stepsFor({ compiled: true, docker: false, platform: 'linux' })).not.toContain('tray');
    expect(stepsFor({ compiled: false, docker: false, platform: 'win32' })).not.toContain('tray');
    expect(stepsFor({ compiled: true, docker: true, platform: 'win32' })).not.toContain('tray');
  });
});

describe('the tray icon', () => {
  const win = (o: Partial<ModelEnv> = {}) => envOf({ platform: 'win32', compiled: true, isRoot: false, ...o });

  test('asked on native Windows only; sign-in only after a yes', () => {
    expect(flowOf({}, win())).toContain('tray');
    expect(flowOf({ tray: 'yes' }, win())).toContain('trayAutostart');
    expect(flowOf({ tray: 'no' }, win())).not.toContain('trayAutostart');
    expect(flowOf({}, win({ docker: true }))).not.toContain('tray');
    expect(flowOf({}, win({ compiled: false }))).not.toContain('tray');
    expect(flowOf({}, envOf({ compiled: true }))).not.toContain('tray');
  });

  test('defaults: the icon, not at sign-in; a re-run starts from what the machine has', () => {
    expect(question('tray').default({}, win())).toBe('yes');
    expect(question('trayAutostart').default({}, win())).toBe('no');
    expect(question('tray').fromFile!({}, win())).toBe(false);
    const optedOut = win({ tray: { installed: false, optedOut: true, autostart: false } });
    expect(question('tray').default({}, optedOut)).toBe('no');
    expect(question('tray').fromFile!({}, optedOut)).toBe(true);
    const auto = win({ tray: { installed: true, optedOut: false, autostart: true } });
    expect(question('tray').default({}, auto)).toBe('yes');
    expect(question('trayAutostart').default({}, auto)).toBe('yes');
  });

  test('trayChoice: what the install does', () => {
    expect(trayChoice({ tray: 'yes', trayAutostart: 'yes' }, win())).toEqual({ install: true, autostart: true });
    expect(trayChoice({ tray: 'yes', trayAutostart: 'no' }, win())).toEqual({ install: true, autostart: false });
    // No icon takes its sign-in value with it, whatever was answered before.
    expect(trayChoice({ tray: 'no', trayAutostart: 'yes' }, win())).toEqual({ install: false, autostart: false });
    expect(trayChoice({ tray: 'yes' }, envOf({ compiled: true }))).toBeNull();
  });
});

describe('the address', () => {
  test('addressChoice: null until the branch is answered', () => {
    expect(addressChoice({})).toBeNull();
    expect(addressChoice({ hosting: 'home' })).toBeNull();
    expect(addressChoice({ hosting: 'home', homeCf: 'advanced', homeAdvanced: 'ports' })).toBeNull();
    expect(addressChoice({ hosting: 'home', homeCf: 'yes', vpsAddress: 'domain' })).toBe('tunnel');
    expect(addressChoice({ hosting: 'vps', homeCf: 'yes', vpsAddress: 'sslip' })).toBe('sslip');
  });

  test('every choice writes every column', () => {
    const v = (a: Answers, host: HostInfo | null = HOME) => addressValues(a, { host });
    const blank = { INGRESS: '', PUBLIC_URL: '', HTTP_PORT: '', HTTPS_PORT: '', ACME_DNS: '', TUNNEL_TOKEN: '', DDNS_PROVIDER: '', DUCKDNS_DOMAIN: '', DUCKDNS_TOKEN: '', LIVEKIT_NODE_IP: '' };
    expect(v({})).toEqual(blank);
    expect(v({ hosting: 'home', homeCf: 'no', duckName: 'my-group', duckToken: 'k', httpsPort: '9443' })).toEqual({
      ...blank, INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org:9443', HTTP_PORT: '0', HTTPS_PORT: '9443', ACME_DNS: 'duckdns', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'k',
    });
    expect(v({ hosting: 'vps', vpsAddress: 'sslip', nodeIp: '198.51.100.7' }).PUBLIC_URL).toBe('https://203-0-113-9.sslip.io');
    expect(v({ hosting: 'vps', vpsAddress: 'sslip', nodeIp: '198.51.100.7' }, null)).toMatchObject({ PUBLIC_URL: 'https://198-51-100-7.sslip.io', LIVEKIT_NODE_IP: '198.51.100.7' });
    expect(v({ hosting: 'vps', vpsAddress: 'external', externalUrl: 'https://x.example.com:8443/' })).toEqual({ ...blank, INGRESS: 'external', PUBLIC_URL: 'https://x.example.com:8443' });
    expect(v({ hosting: 'vps', vpsAddress: 'domain', domain: 't.example.com', httpPort: '8080', httpsPortDirect: '8443', pinnedIp: '198.51.100.7', publicUrl: 'https://t.example.com:8443/' })).toEqual({
      ...blank, INGRESS: 'direct', PUBLIC_URL: 'https://t.example.com:8443', HTTP_PORT: '8080', HTTPS_PORT: '8443', LIVEKIT_NODE_IP: '198.51.100.7',
    });
    expect(redirectUri({ hosting: 'home', homeCf: 'yes', tunnelHost: 't.example.com' }, { host: HOME })).toBe('https://t.example.com/auth/callback');
    expect(redirectUri({}, { host: HOME })).toBe('');
  });

  test('validation and the stored form of typed answers', () => {
    const env = envOf({ file: { MEDIA_TCP_PORT: '50000' } });
    const check = (id: QuestionId, v: string, a: Answers = {}) => question(id).validate!(v, a, env);
    expect(check('domain', 'https://Telinha.Example.com/x')).toBeNull();
    expect(question('domain').normalize!('https://Telinha.Example.com/x', env)).toBe('telinha.example.com');
    expect(check('domain', '203.0.113.9')).toEqual({ key: 'hostBad' });
    expect(check('httpsPort', '443')).toEqual({ key: 'httpsPortLow' });
    expect(check('httpsPort', '70000')).toEqual({ key: 'portBad' });
    expect(check('httpsPort', '8081')).toEqual({ key: 'httpsPortTaken', params: { what: 'LISTEN' } });
    expect(check('httpsPort', '50000')).toEqual({ key: 'httpsPortTaken', params: { what: 'MEDIA_TCP_PORT' } });
    expect(check('httpsPort', '9443')).toBeNull();
    expect(check('mediaTcp', '9443', { hosting: 'home', homeCf: 'no', httpsPort: '9443' })).toEqual({ key: 'mediaPortIsHttps' });
    expect(check('mediaTcp', '0')).toEqual({ key: 'portBad' });
    expect(check('externalUrl', 'https://x.example.com/app')).toEqual({ key: 'urlBad' });
    expect(check('command', 'Sala')).toEqual({ key: 'commandBad' });
    expect(check('channels', '444444444444444441, 12')).toEqual({ key: 'idBad' });
    expect(question('channels').normalize!(' 444444444444444441, 444444444444444442 ,', env)).toEqual(['444444444444444441', '444444444444444442']);
    const tunnel = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel-id', s: 'c2VjcmV0' })).toString('base64');
    expect(check('tunnelToken', `cloudflared service install ${tunnel}`)).toBeNull();
    expect(question('tunnelToken').normalize!(`cloudflared service install ${tunnel}`, env)).toBe(tunnel);
  });

  test('answered: empty is unanswered, an optional or hidden answer counts when present', () => {
    expect(answered({ domain: '' }, 'domain')).toBe(false);
    expect(answered({ channels: [] }, 'channels')).toBe(false);
    expect(answered({ group: '' }, 'group')).toBe(true);
    expect(answered({ pinnedIp: '' }, 'pinnedIp')).toBe(true);
    expect(answered({}, 'group')).toBe(false);
  });
});

describe('question strings', () => {
  test('pt-BR keeps every key and placeholder of en; nothing says "phase"', () => {
    const en = q.en as Record<string, string>;
    const pt = q.ptBR as Record<string, string>;
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(en)) {
      const want = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const got = [...pt[k]!.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(`${k}: ${got.join(',')}`).toBe(`${k}: ${want.join(',')}`);
    }
    for (const d of [en, pt]) for (const v of Object.values(d)) expect(v.toLowerCase()).not.toMatch(/\bphase\b|\bfase\b|\bstack\b|prototype|protótipo|telinha\.toml|\.config\/telinha|\bfake\b/);
  });

  test('the hosting title is pinned (the terminal smokes look for it)', () => {
    expect(q.en.hostingTitle).toBe('Where will Telinha run?');
    expect(q.ptBR.hostingTitle).toBe('Onde a Telinha vai rodar?');
  });

  test('only the VPS and advanced texts talk about letting 80/443 in', () => {
    const open = /\b(open|forward)\s+(the\s+)?(web\s+)?(ports?\s+)?(80|443)\b|\b(abra|abrir|redirecione|libere)\s+(as\s+|a\s+)?(portas?\s+)?(80|443)\b/i;
    const homeSafe = (k: string) => !/^(vps|adv)/.test(k);
    for (const d of [q.en, q.ptBR] as Record<string, string>[]) {
      for (const [k, v] of Object.entries(d)) if (homeSafe(k)) expect(`${k}: ${v}`).not.toMatch(open);
    }
    // The home texts say why: providers usually block them.
    expect(q.en.homeCfQ).toContain('usually');
    expect(q.ptBR.homeCfQ).toContain('em geral');
  });

  test('no ufw automation is offered, and the flag errors match the non-interactive ones', () => {
    for (const d of [q.en, q.ptBR] as Record<string, string>[]) expect(Object.values(d).join('\n')).not.toMatch(/open them in ufw|abrir no ufw/i);
    expect(q.en.homeNeedsAdvanced).toEndWith('; on a rented server pass --host vps');
    expect(q.ptBR.homeNeedsAdvanced).toEndWith('; num servidor alugado passe --host vps');
    expect(q('en', 'badFlagValue', { flag: '--x', value: 'y', allowed: 'z' })).toBe('--x: y is not valid (want z)');
  });
});
