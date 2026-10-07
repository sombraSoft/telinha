import { describe, expect, test } from 'bun:test';
import { isCgnatIpv4, isPrivateIpv4, lookupPublicIp, parseAltNames, resolveA, tcpOpen } from '../src/netinfo.ts';

const TRACE = 'https://1.1.1.1/cdn-cgi/trace';
const IPIFY = 'https://api.ipify.org';

function fakeFetch(replies: Record<string, string | Error | number>) {
  const calls: string[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const r = replies[url] ?? new Error('no route');
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('', { status: r });
    return new Response(r);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('lookupPublicIp', () => {
  test('reads ip= from the Cloudflare trace', async () => {
    const f = fakeFetch({ [TRACE]: 'fl=1\nip=203.0.113.7\nts=1\n' });
    expect(await lookupPublicIp(f.fetch)).toBe('203.0.113.7');
    expect(f.calls).toEqual([TRACE]);
  });

  test('falls back to ipify when the trace fails or is not IPv4', async () => {
    const f = fakeFetch({ [TRACE]: 'ip=2001:db8::1\n', [IPIFY]: ' 198.51.100.2\n' });
    expect(await lookupPublicIp(f.fetch)).toBe('198.51.100.2');
    expect(f.calls).toEqual([TRACE, IPIFY]);
  });

  test('throws with every source when all fail', async () => {
    const f = fakeFetch({ [TRACE]: 503, [IPIFY]: new Error('offline') });
    await expect(lookupPublicIp(f.fetch)).rejects.toThrow(/1\.1\.1\.1: HTTP 503; api\.ipify\.org: offline/);
  });
});

describe('address classes', () => {
  test('private ranges', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1']) expect(isPrivateIpv4(ip)).toBe(true);
    for (const ip of ['172.15.0.1', '172.32.0.1', '100.64.0.1', '8.8.8.8', 'nope', ''])
      expect(isPrivateIpv4(ip)).toBe(false);
  });

  test('CGNAT is 100.64.0.0/10 only', () => {
    for (const ip of ['100.64.0.0', '100.100.1.1', '100.127.255.255']) expect(isCgnatIpv4(ip)).toBe(true);
    for (const ip of ['100.63.255.255', '100.128.0.0', '10.0.0.1', 'x']) expect(isCgnatIpv4(ip)).toBe(false);
  });
});

test('parseAltNames', () => {
  expect(parseAltNames('DNS:a.example, DNS:b.example, IP Address:1.2.3.4')).toEqual([
    'a.example',
    'b.example',
    '1.2.3.4',
  ]);
  expect(parseAltNames(undefined)).toEqual([]);
});

test('resolveA returns an IPv4 literal as is, without a lookup', async () => {
  expect(await resolveA('203.0.113.9', [])).toEqual(['203.0.113.9']);
});

test('tcpOpen: true for a listening port, false once it is closed', async () => {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  expect(await tcpOpen('127.0.0.1', port, 2000)).toBe(true);
  server.stop(true);
  expect(await tcpOpen('127.0.0.1', port, 2000)).toBe(false);
});
