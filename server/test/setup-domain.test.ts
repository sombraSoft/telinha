import { describe, expect, test } from 'bun:test';
import type { Ddns } from '../src/ddns.ts';
import { resolvePaths } from '../src/paths.ts';
import type { CliContext } from '../src/cli/args.ts';
import type { Choice, Spinner, Term } from '../src/cli/term.ts';
import { askIngress, currentChoice, extractTunnelToken, parseDuckDomain, parseHost, sslipHost, validTunnelToken } from '../src/cli/setup/domain.ts';
import { guessTarget, type HostInfo } from '../src/cli/setup/host.ts';
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

  test('guessTarget: a router means home; 192.168.x without one is a home too; 10.x / 172.16-31.x without one is a 1:1-NAT cloud', () => {
    const host = (localIp: string, gateway = false): HostInfo => ({
      kind: 'linux-root', platform: 'linux', arch: 'x64', isRoot: true, docker: false, osName: 'Linux', publicIp: '203.0.113.9',
      nat: { gateway: gateway ? ({ kind: 'natpmp', gatewayIp: '10.0.0.1' } as NatProbe['gateway']) : null, externalIp: null, localIp, errors: [] },
    });
    expect(guessTarget(host('10.0.0.5', true))).toBe('home');
    expect(guessTarget(host('192.168.1.20'))).toBe('home');
    expect(guessTarget(host('172.31.5.9'))).toBe('vps');
    expect(guessTarget(host('10.128.0.2'))).toBe('vps');
    expect(guessTarget(host('203.0.113.9'))).toBe('vps');
  });

  test('tunnel token shape: base64 JSON with a, t, s', () => {
    expect(validTunnelToken(TUNNEL)).toBe(true);
    expect(validTunnelToken(Buffer.from('{"a":"x"}').toString('base64'))).toBe(false);
    expect(validTunnelToken('not-a-token')).toBe(false);
  });
  test('currentChoice reads a re-run default from the file', () => {
    expect(currentChoice({ INGRESS: 'tunnel' })).toBe('tunnel');
    expect(currentChoice({ INGRESS: 'direct', DDNS_PROVIDER: 'duckdns' })).toBe('duckdns');
    expect(currentChoice({ PUBLIC_URL: 'https://1-2-3-4.sslip.io' })).toBe('sslip');
    expect(currentChoice({ INGRESS: 'external' })).toBe('external');
    expect(currentChoice({})).toBe('domain');
  });
});

describe('askIngress', () => {
  test('own domain, 80+443: direct, A record checked against the public IP', async () => {
    const term = new FakeTerm({ 'select:ingress': ['domain'], 'text:public-url': ['https://telinha.example.com/'] });
    const values: Values = { TUNNEL_TOKEN: 'old', DDNS_PROVIDER: 'duckdns' };
    const choice = await askIngress(wizard(term, { resolve: ['198.51.100.1'] }).w, values, 'home');
    expect(choice).toBe('domain');
    expect(values).toMatchObject({ INGRESS: 'direct', PUBLIC_URL: 'https://telinha.example.com', HTTP_PORT: '80', HTTPS_PORT: '443', TUNNEL_TOKEN: '', DDNS_PROVIDER: '', UPNP: 'auto' });
    expect(term.text_()).toContain('telinha.example.com points at 198.51.100.1, not at 203.0.113.9');
  });

  test('443 only, to another port: HTTPS_PORT=8443, HTTP_PORT=0', async () => {
    const term = new FakeTerm({ 'select:ports': ['other'], 'text:public-url': ['telinha.example.com'], 'confirm:upnp': [false] });
    const values: Values = {};
    await askIngress(wizard(term, { resolve: ['203.0.113.9'] }).w, values, 'home');
    expect(values).toMatchObject({ HTTPS_PORT: '8443', HTTP_PORT: '0', UPNP: 'off' });
    expect(term.text_()).toContain('points at this network');
  });

  test('neither port: back to the choice with the tunnel suggested', async () => {
    const term = new FakeTerm({ 'select:ingress': ['domain'], 'select:ports': ['neither'], 'secret:TUNNEL_TOKEN': ['nope', TUNNEL], 'text:public-url': ['t.example.com'] });
    const values: Values = { HTTP_PORT: '80' };
    const choice = await askIngress(wizard(term).w, values, 'home');
    expect(choice).toBe('tunnel');
    expect(values).toMatchObject({ INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: 'https://t.example.com', HTTP_PORT: '', HTTPS_PORT: '' });
    expect(term.asked.filter((a) => a === 'select:ingress')).toHaveLength(2);
    expect(term.text_()).toContain('does not look like a Cloudflare tunnel token');
    expect(term.text_()).toContain('http://localhost:8081');
  });

  test('DuckDNS: validated live, a rejected token is asked again', async () => {
    const term = new FakeTerm({ 'select:ingress': ['duckdns'], 'text:duckdns-domain': ['My-Group.duckdns.org'], 'secret:DUCKDNS_TOKEN': ['bad', 'good'] });
    const { w, ddnsCalls } = wizard(term, { duck: (tok) => tok === 'good' });
    const values: Values = {};
    await askIngress(w, values, 'home');
    expect(values).toMatchObject({ INGRESS: 'direct', DDNS_PROVIDER: 'duckdns', DUCKDNS_DOMAIN: 'my-group', DUCKDNS_TOKEN: 'good', PUBLIC_URL: 'https://my-group.duckdns.org' });
    expect(ddnsCalls).toEqual([{ domain: 'my-group', token: 'bad', ip: '203.0.113.9' }, { domain: 'my-group', token: 'good', ip: '203.0.113.9' }]);
    expect(term.text_()).toContain('DuckDNS did not accept it');
  });

  test('DuckDNS: "keep anyway" accepts an unverified token', async () => {
    const term = new FakeTerm({ 'select:ingress': ['duckdns'], 'text:duckdns-domain': ['abc'], 'secret:DUCKDNS_TOKEN': ['x'], 'select:duckdns-retry': ['keep'] });
    const values: Values = {};
    await askIngress(wizard(term, { duck: () => false }).w, values, 'home');
    expect(values.DUCKDNS_TOKEN).toBe('x');
  });

  test('sslip.io only on a VPS: name from the public IP, node IP pinned, no UPnP question (UPnP off)', async () => {
    const home = new FakeTerm({ 'text:public-url': ['a.example.com'] });
    await askIngress(wizard(home, { resolve: ['203.0.113.9'] }).w, {}, 'home');
    expect(home.text_()).not.toContain('sslip.io');
    const term = new FakeTerm({ 'select:ingress': ['sslip'] });
    const values: Values = {};
    await askIngress(wizard(term).w, values, 'vps');
    expect(values).toMatchObject({ INGRESS: 'direct', PUBLIC_URL: 'https://203-0-113-9.sslip.io', LIVEKIT_NODE_IP: '203.0.113.9' });
    expect(values.UPNP).toBe('off');
    expect(term.asked).not.toContain('confirm:upnp');
  });

  test('Cloudflare-only target starts at the tunnel; the tunnel is offered on every target', async () => {
    const term = new FakeTerm({ 'secret:TUNNEL_TOKEN': [TUNNEL], 'text:public-url': ['t.example.com'] });
    expect(await askIngress(wizard(term).w, {}, 'cloudflare')).toBe('tunnel');
    for (const target of ['home', 'vps'] as const) {
      const t2 = new FakeTerm({ 'select:ingress': ['tunnel'], 'secret:TUNNEL_TOKEN': [TUNNEL], 'text:public-url': ['t.example.com'] });
      expect(await askIngress(wizard(t2).w, {}, target)).toBe('tunnel');
    }
  });

  test('the whole install command pasted as the tunnel token: the token is kept', async () => {
    const term = new FakeTerm({ 'select:ingress': ['tunnel'], 'secret:TUNNEL_TOKEN': [`cloudflared.exe service install ${TUNNEL}`], 'text:public-url': ['t.example.com'] });
    const values: Values = {};
    await askIngress(wizard(term).w, values, 'home');
    expect(values.TUNNEL_TOKEN).toBe(TUNNEL);
  });

  test('a router answering UPnP: the ports question says Telinha can open them', async () => {
    const nat = { gateway: { kind: 'igd', gatewayIp: '192.168.0.1' }, externalIp: '203.0.113.9', localIp: '192.168.0.10', errors: [] } as unknown as NatProbe;
    const term = new FakeTerm({ 'text:public-url': ['a.example.com'] });
    await askIngress(wizard(term, { resolve: ['203.0.113.9'], nat }).w, {}, 'home');
    expect(term.text_()).toContain('Your router accepts automatic port forwarding: answer Yes');
    const none = new FakeTerm({ 'text:public-url': ['a.example.com'] });
    await askIngress(wizard(none, { resolve: ['203.0.113.9'] }).w, {}, 'home');
    expect(none.text_()).not.toContain('automatic port forwarding');
  });

  test('switching away from sslip.io drops the pinned IP (DuckDNS and LiveKit follow the real one again)', async () => {
    const term = new FakeTerm({ 'select:ingress': ['duckdns'], 'text:duckdns-domain': ['my-group'], 'secret:DUCKDNS_TOKEN': ['tok'] });
    const values: Values = { INGRESS: 'direct', PUBLIC_URL: 'https://203-0-113-9.sslip.io', LIVEKIT_NODE_IP: '203.0.113.9' };
    await askIngress(wizard(term).w, values, 'vps');
    expect(values.LIVEKIT_NODE_IP).toBe('');
    expect(values.UPNP).toBe('off');
  });

  test('re-run keeps the current tunnel token on Enter', async () => {
    const term = new FakeTerm();
    const values: Values = { INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL, PUBLIC_URL: 'https://t.example.com' };
    await askIngress(wizard(term).w, values, 'home');
    expect(values.TUNNEL_TOKEN).toBe(TUNNEL);
    expect(term.asked).toContain('select:TUNNEL_TOKEN');
    expect(term.asked).not.toContain('secret:TUNNEL_TOKEN');
  });

  test('own reverse proxy: external, URL kept as typed', async () => {
    const term = new FakeTerm({ 'select:ingress': ['external'], 'text:public-url': ['ftp://x', 'https://x.example.com:8443/'] });
    const values: Values = {};
    await askIngress(wizard(term).w, values, 'vps');
    expect(values).toMatchObject({ INGRESS: 'external', PUBLIC_URL: 'https://x.example.com:8443' });
  });
});
