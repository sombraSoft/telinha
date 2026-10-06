import { describe, expect, test } from 'bun:test';
import type { Ddns } from '../src/ddns.ts';
import { resolvePaths } from '../src/paths.ts';
import type { CliContext } from '../src/cli/args.ts';
import type { Choice, Spinner, Term } from '../src/cli/term.ts';
import { askAddress, currentChoice, extractTunnelToken, homeChoice, parseDuckDomain, parseHost, sslipHost, validTunnelToken } from '../src/cli/setup/domain.ts';
import { guessHosting, inferHosting, type HostInfo } from '../src/cli/setup/host.ts';
import type { NatProbe } from '../src/nat/index.ts';
import type { SetupDeps, Values, Wizard } from '../src/cli/setup/steps.ts';
import { t } from '../src/cli/setup/strings.ts';

/** Scripted answers by "<kind>:<id>"; a prompt without one takes its default. */
class FakeTerm implements Term {
  out: string[] = [];
  asked: string[] = [];
  colors = false;
  style = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s };
  constructor(private answers: Record<string, unknown[]> = {}) {}
  private take<T>(key: string, fallback?: () => T): T {
    this.asked.push(key);
    const q = this.answers[key];
    if (q?.length) return q.shift() as T;
    if (fallback) return fallback();
    throw new Error(`no answer for ${key}`);
  }
  info = (m: string) => void this.out.push(m);
  ok = (m: string) => void this.out.push(`ok ${m}`);
  warn = (m: string) => void this.out.push(`warn ${m}`);
  fail = (m: string) => void this.out.push(`fail ${m}`);
  step = (m: string) => void this.out.push(`step ${m}`);
  line = (m = '') => void this.out.push(m);
  async text(q: string, o: { default?: string; validate?: (v: string) => string | null; required?: boolean; id?: string } = {}) {
    for (;;) {
      const v = this.take<string>(`text:${o.id ?? q}`, o.default !== undefined ? () => o.default! : undefined);
      const err = (!v && o.required ? 'required' : null) ?? o.validate?.(v) ?? null;
      if (!err) return v;
      this.out.push(`fail ${err}`);
    }
  }
  async secret(q: string, o: { validate?: (v: string) => string | null; id?: string } = {}) {
    for (;;) {
      const v = this.take<string>(`secret:${o.id ?? q}`);
      const err = o.validate?.(v) ?? (v ? null : 'required');
      if (!err) return v;
      this.out.push(`fail ${err}`);
    }
  }
  async confirm(q: string, def?: boolean, o: { id?: string } = {}) {
    return this.take<boolean>(`confirm:${o.id ?? q}`, def !== undefined ? () => def : undefined);
  }
  async select<T>(q: string, items: Choice<T>[], def?: number, o: { id?: string } = {}) {
    this.out.push(`select ${o.id}: ${items.map((i) => i.label).join(' | ')}`);
    const v = this.take<T>(`select:${o.id ?? q}`, () => items[def ?? 0]!.value);
    if (!items.some((i) => i.value === v)) throw new Error(`select ${o.id}: ${String(v)} is not offered`);
    return v;
  }
  async multiselect<T>(q: string, items: Choice<T>[], o: { min?: number; preselected?: T[]; id?: string } = {}) {
    return this.take<T[]>(`multiselect:${o.id ?? q}`, o.preselected && o.preselected.length >= (o.min ?? 0) ? () => o.preselected! : undefined);
  }
  spinner(label: string): Spinner {
    this.out.push(`spin ${label}`);
    return { update: (l) => void this.out.push(`spin ${l}`), stop: (l) => void this.out.push(`ok ${l ?? label}`), fail: (l) => void this.out.push(`fail ${l ?? label}`) };
  }
  table = (rows: string[][]) => void this.out.push(...rows.map((r) => r.join(' ')));
  link = (u: string) => u;
  text_(): string {
    return this.out.join('\n');
  }
}

const TUNNEL = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel-id', s: 'c2VjcmV0' })).toString('base64');

function wizard(term: FakeTerm, o: { publicIp?: string | null; resolve?: string[]; duck?: (token: string) => boolean; nat?: NatProbe | null } = {}) {
  const env = { TELINHA_HOME: '/srv/telinha' };
  const ctx = { argv: ['setup'], env, paths: resolvePaths(env, 'linux'), envFile: '/srv/telinha/config/telinha.env', locale: 'en', tty: true, yes: false, stdout: () => {}, stderr: () => {}, compiled: false, version: '0.7.0' } satisfies CliContext;
  const ddnsCalls: { domain: string; token: string; ip: string }[] = [];
  const deps = {
    resolveA: async () => o.resolve ?? [],
    ddns: ({ domain, token }: { domain: string; token: string }): Ddns => {
      let last: ReturnType<Ddns['last']> = null;
      return {
        async update(ip) {
          ddnsCalls.push({ domain, token, ip });
          const ok = (o.duck ?? (() => true))(token);
          last = ok ? { ip, at: 1, ok } : { ip, at: 1, ok, error: 'DuckDNS rejected the domain/token' };
        },
        last: () => last,
      };
    },
  } as unknown as SetupDeps;
  const publicIp = o.publicIp === undefined ? '203.0.113.9' : o.publicIp;
  const w: Wizard = {
    ctx, deps, term, locale: 'en', s: (k, p) => t('en', k, p), keepCurrent: '(keep current)', interactive: true, docker: false,
    host: { kind: 'linux-root', platform: 'linux', arch: 'x64', isRoot: true, docker: false, osName: 'Linux', publicIp, nat: o.nat ?? null },
  };
  return { w, ddnsCalls };
}

const host = (o: { localIp?: string | null; gateway?: boolean; publicIp?: string | null; nat?: boolean } = {}): HostInfo => ({
  kind: 'linux-root', platform: 'linux', arch: 'x64', isRoot: true, docker: false, osName: 'Linux', publicIp: o.publicIp === undefined ? '203.0.113.9' : o.publicIp,
  nat: o.nat === false ? null : { gateway: o.gateway ? ({ kind: 'natpmp', gatewayIp: '10.0.0.1' } as NatProbe['gateway']) : null, externalIp: null, localIp: o.localIp ?? null, errors: [] },
});

/** The home DuckDNS answers: name and token (the rejected-then-accepted script when asked for). */
const duckAnswers = (o: { retry?: boolean } = {}): Record<string, unknown[]> => ({
  'text:duckdns-domain': ['My-Group.duckdns.org'],
  'secret:DUCKDNS_TOKEN': o.retry ? ['bad', 'good'] : ['good'],
});

/** Every column the address step owns. */
const COLUMNS = ['HOSTING', 'INGRESS', 'PUBLIC_URL', 'HTTP_PORT', 'HTTPS_PORT', 'ACME_DNS', 'DDNS_PROVIDER', 'DUCKDNS_DOMAIN', 'DUCKDNS_TOKEN', 'TUNNEL_TOKEN', 'LIVEKIT_NODE_IP', 'UPNP'];

describe('parsers', () => {
  test('parseHost strips scheme, port, path; refuses IPs and junk', () => {
    expect(parseHost('https://Telinha.Example.com:443/x?y')).toBe('telinha.example.com');
    expect(parseHost('telinha.example.com.')).toBe('telinha.example.com');
    expect(parseHost('203.0.113.9')).toBeNull();
    expect(parseHost('localhost')).toBeNull();
    expect(parseHost('bad_host.example.com')).toBeNull();
  });
  test('parseDuckDomain keeps the subdomain only', () => {
    expect(parseDuckDomain('My-Group.duckdns.org')).toBe('my-group');
    expect(parseDuckDomain('https://abc.duckdns.org/')).toBe('abc');
    expect(parseDuckDomain('a.b')).toBeNull();
  });
  test('sslip host from an IP', () => {
    expect(sslipHost('203.0.113.9')).toBe('203-0-113-9.sslip.io');
  });
  test('the token out of a pasted install command (what the dashboard\'s copy button copies)', () => {
    expect(extractTunnelToken(`cloudflared.exe service install ${TUNNEL}`)).toBe(TUNNEL);
    expect(extractTunnelToken(`sudo cloudflared service install ${TUNNEL}\n`)).toBe(TUNNEL);
    expect(extractTunnelToken(`  ${TUNNEL}  `)).toBe(TUNNEL);
    expect(extractTunnelToken(' junk ')).toBe('junk');
  });
  test('tunnel token shape: base64 JSON with a, t, s', () => {
    expect(validTunnelToken(TUNNEL)).toBe(true);
    expect(validTunnelToken(Buffer.from('{"a":"x"}').toString('base64'))).toBe(false);
    expect(validTunnelToken('not-a-token')).toBe(false);
  });
});

describe('re-run defaults', () => {
  test('guessHosting: home unless the public IP sits on this machine', () => {
    expect(guessHosting(host({ localIp: '10.0.0.5', gateway: true }))).toBe('home');
    expect(guessHosting(host({ localIp: '192.168.1.20' }))).toBe('home');
    expect(guessHosting(host({ localIp: '10.128.0.2' }))).toBe('home');
    expect(guessHosting(host({ localIp: '172.31.5.9' }))).toBe('home');
    expect(guessHosting(host({ localIp: '203.0.113.9' }))).toBe('vps');
    expect(guessHosting(host({ nat: false }))).toBe('home');
    expect(guessHosting(host({ localIp: '203.0.113.9', publicIp: null }))).toBe('home');
  });

  test('inferHosting: the file\'s answer, else its VPS-only keys, else the machine', () => {
    const vpsLike = host({ localIp: '203.0.113.9' });
    expect(inferHosting({ HOSTING: 'home' }, vpsLike)).toBe('home');
    expect(inferHosting({ HOSTING: 'vps' }, host())).toBe('vps');
    expect(inferHosting({ LIVEKIT_NODE_IP: '203.0.113.9' }, host())).toBe('vps');
    expect(inferHosting({ PUBLIC_URL: 'https://203-0-113-9.sslip.io' }, host())).toBe('vps');
    expect(inferHosting({ INGRESS: 'tunnel' }, host())).toBe('home');
    expect(inferHosting({}, vpsLike)).toBe('vps');
    expect(inferHosting({}, host())).toBe('home');
  });

  test('homeChoice: advanced only for a home file that already is one', () => {
    expect(homeChoice({})).toBe('no');
    expect(homeChoice({ HOSTING: 'vps', INGRESS: 'direct', HTTP_PORT: '80', HTTPS_PORT: '443' })).toBe('no');
    expect(homeChoice({ HOSTING: 'home', INGRESS: 'direct', HTTP_PORT: '80', HTTPS_PORT: '443' })).toBe('advanced');
    expect(homeChoice({ HOSTING: 'home', INGRESS: 'external' })).toBe('advanced');
    expect(homeChoice({ HOSTING: 'home', INGRESS: 'direct', ACME_DNS: 'duckdns', HTTPS_PORT: '8443' })).toBe('no');
    expect(homeChoice({ HOSTING: 'home' })).toBe('no');
    expect(homeChoice({ INGRESS: 'tunnel' })).toBe('yes');
    expect(homeChoice({ HOSTING: 'vps', INGRESS: 'tunnel' })).toBe('yes');
  });

  test('currentChoice reads the VPS list\'s default from the file', () => {
    expect(currentChoice({ INGRESS: 'tunnel' })).toBe('tunnel');
    expect(currentChoice({ INGRESS: 'direct', DDNS_PROVIDER: 'duckdns' })).toBe('duckdns');
    expect(currentChoice({ PUBLIC_URL: 'https://1-2-3-4.sslip.io' })).toBe('sslip');
    expect(currentChoice({ INGRESS: 'external' })).toBe('external');
    expect(currentChoice({})).toBe('domain');
  });
});

describe('askAddress at home', () => {
  test('a domain on Cloudflare: tunnel, every direct key cleared, UPnP asked', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['yes'], 'secret:TUNNEL_TOKEN': ['nope', TUNNEL], 'text:public-url': ['t.example.com'] });
    const values: Values = { HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'x', DUCKDNS_TOKEN: 'tok' };
    expect(await askAddress(wizard(term).w, values, 'home')).toBe('tunnel');
    expect(values).toEqual({
      HOSTING: 'home', INGRESS: 'tunnel', PUBLIC_URL: 'https://t.example.com', TUNNEL_TOKEN: TUNNEL,
      HTTP_PORT: '', HTTPS_PORT: '', ACME_DNS: '', DDNS_PROVIDER: '', DUCKDNS_DOMAIN: '', DUCKDNS_TOKEN: '', LIVEKIT_NODE_IP: '', UPNP: 'auto',
    });
    expect(term.asked).toContain('confirm:upnp');
    expect(term.text_()).toContain('does not look like a Cloudflare tunnel token');
    expect(term.text_()).toContain('http://localhost:8081');
  });

  test('no domain: DuckDNS on a high port, the certificate through the token, nothing about opening 80/443', async () => {
    const term = new FakeTerm({ ...duckAnswers({ retry: true }), 'confirm:upnp': [false] });
    const { w, ddnsCalls } = wizard(term, { duck: (tok) => tok === 'good' });
    const values: Values = { TUNNEL_TOKEN: 'old' };
    expect(await askAddress(w, values, 'home')).toBe('duckdns-home');
    expect(values).toEqual({
      HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org:8443', HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns',
      DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good', TUNNEL_TOKEN: '', LIVEKIT_NODE_IP: '', UPNP: 'off',
    });
    expect(ddnsCalls).toEqual([{ domain: 'my-group', token: 'bad', ip: '203.0.113.9' }, { domain: 'my-group', token: 'good', ip: '203.0.113.9' }]);
    const out = term.text_();
    expect(out).toContain('DuckDNS did not accept it');
    expect(out).toContain('ok Address: https://my-group.duckdns.org:8443 (the port is part of it).');
    expect(out).toContain('Some strict networks (offices, schools) only let browsers reach port 443');
    expect(out).toContain('Home internet connections usually do not let the web ports 80 and 443 in');
    expect(out).not.toContain('Can ports 80 and 443 from the internet reach this machine?');
    expect(out).not.toContain('forward');
    // The default is the DuckDNS path, never Advanced.
    expect(term.asked).toContain('select:cf-domain');
    expect(out).toContain('select cf-domain: Yes: use a Cloudflare Tunnel | No: use a free DuckDNS address | Advanced');
  });

  test('the HTTPS port: a custom high one is fine; 80, 443 and Telinha\'s own ports are refused', async () => {
    const term = new FakeTerm({ ...duckAnswers(), 'text:https-port': ['443', '80', '8081', '7880', '7881', '7882', '70000', '9443'] });
    const values: Values = {};
    await askAddress(wizard(term).w, values, 'home');
    expect(values).toMatchObject({ PUBLIC_URL: 'https://my-group.duckdns.org:9443', HTTPS_PORT: '9443', HTTP_PORT: '0', ACME_DNS: 'duckdns' });
    const fails = term.out.filter((l) => l.startsWith('fail '));
    expect(fails).toEqual([
      'fail Use a port from 1024 up: home connections usually do not let 80 or 443 in.',
      'fail Use a port from 1024 up: home connections usually do not let 80 or 443 in.',
      'fail That port is already used by Telinha (LISTEN).',
      'fail That port is already used by Telinha (LIVEKIT_PORT).',
      // The media ports come next and are only checked when changed: refused here, not at the save.
      'fail That port is already used by Telinha (MEDIA_TCP_PORT).',
      'fail That port is already used by Telinha (MEDIA_UDP_PORT).',
      'fail A port is a number from 1 to 65535.',
    ]);
  });

  test('the HTTPS port: custom media ports are the ones refused', async () => {
    const term = new FakeTerm({ ...duckAnswers(), 'text:https-port': ['9000', '7881'] });
    const values: Values = { MEDIA_TCP_PORT: '9000' };
    await askAddress(wizard(term).w, values, 'home');
    expect(values.HTTPS_PORT).toBe('7881');
    expect(term.out.filter((l) => l.startsWith('fail '))).toEqual(['fail That port is already used by Telinha (MEDIA_TCP_PORT).']);
  });

  test('the HTTPS port: --https-port is the default on a fresh install and after a switch; a low one is not offered', async () => {
    const fresh = new FakeTerm(duckAnswers());
    const a: Values = {};
    await askAddress(wizard(fresh).w, a, 'home', { httpsPort: '9443' });
    expect(a).toMatchObject({ HTTPS_PORT: '9443', PUBLIC_URL: 'https://my-group.duckdns.org:9443' });
    const switched = new FakeTerm({ 'select:cf-domain': ['no'], ...duckAnswers() });
    const b: Values = { HOSTING: 'home', INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: 'https://t.example.com' };
    await askAddress(wizard(switched).w, b, 'home', { httpsPort: '10443' });
    expect(b.HTTPS_PORT).toBe('10443');
    // Over the file's previous high port too.
    const rerun = new FakeTerm(duckAnswers());
    const c: Values = { HOSTING: 'home', INGRESS: 'direct', ACME_DNS: 'duckdns', HTTPS_PORT: '9443', DUCKDNS_DOMAIN: 'my-group' };
    await askAddress(wizard(rerun).w, c, 'home', { httpsPort: '10443' });
    expect(c.HTTPS_PORT).toBe('10443');
    const low = new FakeTerm(duckAnswers());
    const d: Values = {};
    await askAddress(wizard(low).w, d, 'home', { httpsPort: '443' });
    expect(d.HTTPS_PORT).toBe('8443');
  });

  test('the router help names what must reach this machine for the path taken', async () => {
    const help = async (answers: Record<string, unknown[]>) => {
      const term = new FakeTerm(answers);
      await askAddress(wizard(term).w, {}, 'home');
      return term.out.filter((l) => l.includes('must reach this machine'));
    };
    expect(await help({ ...duckAnswers(), 'text:https-port': ['9443'] })).toEqual(['The media ports and TCP 9443 must reach this machine from the internet.']);
    expect(await help({ 'select:cf-domain': ['yes'], 'secret:TUNNEL_TOKEN': [TUNNEL], 'text:public-url': ['t.example.com'] }))
      .toEqual(['The media ports must reach this machine from the internet.']);
    expect(await help({ 'select:cf-domain': ['advanced'], 'select:advanced': ['proxy'], 'text:public-url': ['https://x.example.com'] }))
      .toEqual(['The media ports must reach this machine from the internet.']);
    expect(await help({ 'select:cf-domain': ['advanced'], 'select:advanced': ['ports'], 'select:ingress': ['domain'], 'text:public-url': ['telinha.example.com'] }))
      .toEqual(['The media ports must reach this machine from the internet (80 and 443 stay forwarded by hand).']);
  });

  test('advanced, ports, own domain: 80/443 and the A record check, no DNS certificate', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['advanced'], 'select:advanced': ['ports'], 'select:ingress': ['domain'], 'text:public-url': ['https://telinha.example.com/'] });
    const values: Values = {};
    expect(await askAddress(wizard(term, { resolve: ['198.51.100.1'] }).w, values, 'home')).toBe('domain');
    expect(values).toEqual({
      HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://telinha.example.com', HTTP_PORT: '80', HTTPS_PORT: '443', ACME_DNS: '',
      DDNS_PROVIDER: '', DUCKDNS_DOMAIN: '', DUCKDNS_TOKEN: '', TUNNEL_TOKEN: '', LIVEKIT_NODE_IP: '', UPNP: 'auto',
    });
    const out = term.text_();
    expect(out).toContain('telinha.example.com points at 198.51.100.1, not at 203.0.113.9');
    expect(out).toContain('Telinha will not ask the router for 80 and 443');
  });

  test('advanced, ports, DuckDNS: URL without a port, HTTP-01 like a VPS', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['advanced'], 'select:advanced': ['ports'], 'select:ingress': ['duckdns'], ...duckAnswers() });
    const values: Values = {};
    expect(await askAddress(wizard(term).w, values, 'home')).toBe('duckdns');
    expect(values).toMatchObject({ INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org', HTTP_PORT: '80', HTTPS_PORT: '443', ACME_DNS: '', DDNS_PROVIDER: 'duckdns', DUCKDNS_TOKEN: 'good' });
    expect(term.asked).not.toContain('text:https-port');
  });

  test('advanced, own proxy: external, URL as typed', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['advanced'], 'select:advanced': ['proxy'], 'text:public-url': ['ftp://x', 'https://x.example.com:8443/'] });
    const values: Values = {};
    expect(await askAddress(wizard(term).w, values, 'home')).toBe('external');
    expect(values).toMatchObject({ HOSTING: 'home', INGRESS: 'external', PUBLIC_URL: 'https://x.example.com:8443', HTTP_PORT: '', HTTPS_PORT: '', ACME_DNS: '' });
    expect(term.asked).not.toContain('select:ingress');
    expect(term.text_()).toContain('Your proxy terminates HTTPS and forwards everything to http://127.0.0.1:8081');
  });

  test('sslip.io is never offered at home', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['advanced'], 'select:advanced': ['ports'], 'text:public-url': ['a.example.com'] });
    await askAddress(wizard(term, { resolve: ['203.0.113.9'] }).w, {}, 'home');
    expect(term.text_()).not.toContain('sslip.io');
  });
});

describe('askAddress on a VPS', () => {
  test('own domain: 80/443, HTTP-01, UPnP off and not asked, no Cloudflare question', async () => {
    const term = new FakeTerm({ 'select:ingress': ['domain'], 'text:public-url': ['telinha.example.com'] });
    const values: Values = { TUNNEL_TOKEN: 'old', DDNS_PROVIDER: 'duckdns', ACME_DNS: 'duckdns' };
    expect(await askAddress(wizard(term, { resolve: ['203.0.113.9'] }).w, values, 'vps')).toBe('domain');
    expect(values).toEqual({
      HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: 'https://telinha.example.com', HTTP_PORT: '80', HTTPS_PORT: '443', ACME_DNS: '',
      DDNS_PROVIDER: '', DUCKDNS_DOMAIN: '', DUCKDNS_TOKEN: '', TUNNEL_TOKEN: '', LIVEKIT_NODE_IP: '', UPNP: 'off',
    });
    expect(term.asked).not.toContain('confirm:upnp');
    expect(term.asked).not.toContain('select:cf-domain');
    expect(term.text_()).toContain('points at this network');
  });

  test('DuckDNS: no port, HTTP_PORT=80, no DNS certificate; "keep anyway" accepts an unverified token', async () => {
    const term = new FakeTerm({ 'select:ingress': ['duckdns'], 'text:duckdns-domain': ['abc'], 'secret:DUCKDNS_TOKEN': ['x'], 'select:duckdns-retry': ['keep'] });
    const values: Values = {};
    expect(await askAddress(wizard(term, { duck: () => false }).w, values, 'vps')).toBe('duckdns');
    expect(values).toMatchObject({ INGRESS: 'direct', PUBLIC_URL: 'https://abc.duckdns.org', HTTP_PORT: '80', HTTPS_PORT: '443', ACME_DNS: '', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'abc', DUCKDNS_TOKEN: 'x', UPNP: 'off' });
    expect(term.asked).not.toContain('text:https-port');
  });

  test('sslip.io: name from the public IP, node IP pinned', async () => {
    const term = new FakeTerm({ 'select:ingress': ['sslip'] });
    const values: Values = {};
    expect(await askAddress(wizard(term).w, values, 'vps')).toBe('sslip');
    expect(values).toMatchObject({ INGRESS: 'direct', PUBLIC_URL: 'https://203-0-113-9.sslip.io', LIVEKIT_NODE_IP: '203.0.113.9', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off' });
    expect(term.text_()).toContain('select ingress: My own domain | DuckDNS | No domain: sslip.io | Cloudflare Tunnel | My own reverse proxy');
  });

  test('tunnel: the whole install command pasted keeps just the token', async () => {
    const term = new FakeTerm({ 'select:ingress': ['tunnel'], 'secret:TUNNEL_TOKEN': [`cloudflared.exe service install ${TUNNEL}`], 'text:public-url': ['t.example.com'] });
    const values: Values = {};
    expect(await askAddress(wizard(term).w, values, 'vps')).toBe('tunnel');
    expect(values).toMatchObject({ HOSTING: 'vps', INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: 'https://t.example.com', HTTP_PORT: '', HTTPS_PORT: '', UPNP: 'off' });
  });

  test('own reverse proxy: external, URL kept as typed', async () => {
    const term = new FakeTerm({ 'select:ingress': ['external'], 'text:public-url': ['https://x.example.com:8443/'] });
    const values: Values = {};
    expect(await askAddress(wizard(term).w, values, 'vps')).toBe('external');
    expect(values).toMatchObject({ INGRESS: 'external', PUBLIC_URL: 'https://x.example.com:8443', UPNP: 'off' });
  });
});

describe('mode switches', () => {
  test('tunnel -> home DuckDNS clears the tunnel token', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['no'], ...duckAnswers() });
    const values: Values = { HOSTING: 'home', INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: 'https://t.example.com' };
    await askAddress(wizard(term).w, values, 'home');
    expect(values).toMatchObject({ INGRESS: 'direct', TUNNEL_TOKEN: '', PUBLIC_URL: 'https://my-group.duckdns.org:8443', ACME_DNS: 'duckdns' });
  });

  test('home DuckDNS -> tunnel clears the DNS certificate, the ports and the DuckDNS keys', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['yes'], 'secret:TUNNEL_TOKEN': [TUNNEL], 'text:public-url': ['t.example.com'] });
    const values: Values = { HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org:8443', HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good' };
    await askAddress(wizard(term).w, values, 'home');
    expect(values).toMatchObject({ INGRESS: 'tunnel', ACME_DNS: '', HTTPS_PORT: '', HTTP_PORT: '', DDNS_PROVIDER: '', DUCKDNS_DOMAIN: '', DUCKDNS_TOKEN: '' });
  });

  test('vps sslip.io -> home DuckDNS drops the pinned IP', async () => {
    const term = new FakeTerm(duckAnswers());
    const values: Values = { HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: 'https://203-0-113-9.sslip.io', LIVEKIT_NODE_IP: '203.0.113.9', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off' };
    await askAddress(wizard(term).w, values, 'home');
    // A VPS file re-run as home defaults to DuckDNS, never to Advanced.
    expect(term.asked).toContain('select:cf-domain');
    expect(term.asked).not.toContain('select:advanced');
    // UPnP is asked now, defaulting to on: the VPS path wrote off by itself, the user never chose it.
    expect(term.asked).toContain('confirm:upnp');
    expect(values).toMatchObject({ HOSTING: 'home', LIVEKIT_NODE_IP: '', HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns', UPNP: 'auto' });
  });

  test('home DuckDNS -> advanced ports keeps the DuckDNS keys, drops the DNS certificate and the URL port', async () => {
    const term = new FakeTerm({ 'select:cf-domain': ['advanced'], 'select:advanced': ['ports'] });
    const values: Values = { HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org:8443', HTTP_PORT: '0', HTTPS_PORT: '8443', ACME_DNS: 'duckdns', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good' };
    await askAddress(wizard(term).w, values, 'home');
    // The advanced list defaults to DuckDNS (the file's name and token kept on Enter).
    expect(term.asked).toContain('select:DUCKDNS_TOKEN');
    expect(values).toMatchObject({ INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org', HTTP_PORT: '80', HTTPS_PORT: '443', ACME_DNS: '', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good' });
  });
});

describe('preselection: a re-run that presses Enter reproduces the file', () => {
  const cases: { name: string; hosting: 'home' | 'vps'; values: Values; asked: string[]; notAsked?: string[] }[] = [
    {
      name: 'home tunnel', hosting: 'home',
      values: { HOSTING: 'home', INGRESS: 'tunnel', PUBLIC_URL: 'https://t.example.com', TUNNEL_TOKEN: TUNNEL, UPNP: 'auto' },
      asked: ['select:cf-domain', 'select:TUNNEL_TOKEN', 'text:public-url', 'confirm:upnp'], notAsked: ['secret:TUNNEL_TOKEN'],
    },
    {
      name: 'home DuckDNS on 9443, UPnP off', hosting: 'home',
      values: { HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org:9443', HTTP_PORT: '0', HTTPS_PORT: '9443', ACME_DNS: 'duckdns', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good', UPNP: 'off' },
      asked: ['select:cf-domain', 'text:duckdns-domain', 'select:DUCKDNS_TOKEN', 'text:https-port', 'confirm:upnp'], notAsked: ['select:advanced'],
    },
    {
      name: 'home advanced own domain', hosting: 'home',
      values: { HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://telinha.example.com', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'auto' },
      asked: ['select:cf-domain', 'select:advanced', 'select:ingress', 'text:public-url', 'confirm:upnp'],
    },
    {
      name: 'home advanced DuckDNS on 443', hosting: 'home',
      values: { HOSTING: 'home', INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org', HTTP_PORT: '80', HTTPS_PORT: '443', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good', UPNP: 'auto' },
      asked: ['select:cf-domain', 'select:advanced', 'select:ingress', 'text:duckdns-domain', 'select:DUCKDNS_TOKEN', 'confirm:upnp'], notAsked: ['text:https-port'],
    },
    {
      name: 'home advanced proxy', hosting: 'home',
      values: { HOSTING: 'home', INGRESS: 'external', PUBLIC_URL: 'https://x.example.com:8443', UPNP: 'off' },
      asked: ['select:cf-domain', 'select:advanced', 'text:public-url', 'confirm:upnp'], notAsked: ['select:ingress'],
    },
    {
      name: 'vps own domain', hosting: 'vps',
      values: { HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: 'https://telinha.example.com', HTTP_PORT: '80', HTTPS_PORT: '443', UPNP: 'off' },
      asked: ['select:ingress', 'text:public-url'], notAsked: ['select:cf-domain', 'confirm:upnp'],
    },
    {
      name: 'vps DuckDNS', hosting: 'vps',
      values: { HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: 'https://my-group.duckdns.org', HTTP_PORT: '80', HTTPS_PORT: '443', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good', UPNP: 'off' },
      asked: ['select:ingress', 'text:duckdns-domain', 'select:DUCKDNS_TOKEN'],
    },
    {
      name: 'vps sslip.io', hosting: 'vps',
      values: { HOSTING: 'vps', INGRESS: 'direct', PUBLIC_URL: 'https://203-0-113-9.sslip.io', HTTP_PORT: '80', HTTPS_PORT: '443', LIVEKIT_NODE_IP: '203.0.113.9', UPNP: 'off' },
      asked: ['select:ingress'],
    },
    {
      name: 'vps tunnel', hosting: 'vps',
      values: { HOSTING: 'vps', INGRESS: 'tunnel', PUBLIC_URL: 'https://t.example.com', TUNNEL_TOKEN: TUNNEL, UPNP: 'off' },
      asked: ['select:ingress', 'select:TUNNEL_TOKEN', 'text:public-url'],
    },
    {
      name: 'vps proxy', hosting: 'vps',
      values: { HOSTING: 'vps', INGRESS: 'external', PUBLIC_URL: 'https://x.example.com', UPNP: 'off' },
      asked: ['select:ingress', 'text:public-url'],
    },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const term = new FakeTerm();
      const values: Values = { ...c.values };
      await askAddress(wizard(term, { resolve: ['203.0.113.9'] }).w, values, c.hosting);
      // Every column set, the ones the mode does not use cleared, the rest as before.
      const want = Object.fromEntries(COLUMNS.map((k) => [k, c.values[k] ?? '']));
      expect(values).toEqual(want);
      for (const q of c.asked) expect(term.asked).toContain(q);
      for (const q of c.notAsked ?? []) expect(term.asked).not.toContain(q);
    });
  }
});
