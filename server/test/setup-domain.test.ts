import { describe, expect, test } from 'bun:test';
import {
  currentChoice, DEFAULT_HOME_HTTPS_PORT, extractTunnelToken, homeChoice, listenPort, parseDuckDomain, parseHost, sslipHost, takenPort, validTunnelToken,
} from '../src/cli/setup/domain.ts';
import { guessHosting, inferHosting, type HostInfo } from '../src/cli/setup/host.ts';
import type { NatProbe } from '../src/nat/index.ts';

const TUNNEL = Buffer.from(JSON.stringify({ a: 'acct', t: 'tunnel-id', s: 'c2VjcmV0' })).toString('base64');

const host = (o: { localIp?: string | null; gateway?: boolean; publicIp?: string | null; nat?: boolean } = {}): HostInfo => ({
  kind: 'linux-root', platform: 'linux', arch: 'x64', isRoot: true, docker: false, osName: 'Linux', publicIp: o.publicIp === undefined ? '203.0.113.9' : o.publicIp,
  nat: o.nat === false ? null : { gateway: o.gateway ? ({ kind: 'natpmp', gatewayIp: '10.0.0.1' } as NatProbe['gateway']) : null, externalIp: null, localIp: o.localIp ?? null, errors: [] },
});

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

describe('ports', () => {
  test("listenPort: LISTEN's port, 8081 by default", () => {
    expect(listenPort({})).toBe(8081);
    expect(listenPort({ LISTEN: '127.0.0.1:9000' })).toBe(9000);
  });

  test("takenPort: Telinha's own ports, the media ports as they are now", () => {
    expect(takenPort({}, 8081)).toBe('LISTEN');
    expect(takenPort({}, 7880)).toBe('LIVEKIT_PORT');
    expect(takenPort({}, 7881)).toBe('MEDIA_TCP_PORT');
    expect(takenPort({}, 7882)).toBe('MEDIA_UDP_PORT');
    expect(takenPort({ MEDIA_TCP_PORT: '9000' }, 9000)).toBe('MEDIA_TCP_PORT');
    expect(takenPort({ MEDIA_TCP_PORT: '9000' }, 7881)).toBeNull();
    expect(takenPort({}, Number(DEFAULT_HOME_HTTPS_PORT))).toBeNull();
  });
});
