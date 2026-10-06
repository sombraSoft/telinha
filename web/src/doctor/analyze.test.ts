import { describe, expect, test } from 'bun:test';
import { hints, selectedPath, tcpFromForced, udpFromInitial, type Path } from './analyze';
import { pickLocale, tr } from './strings';

const report = (stats: Record<string, unknown>[]) => new Map(stats.map((s) => [s.id as string, s]));

const pairStats = (o: { protocol: string; address?: string; rtt?: number; viaTransport?: boolean; relay?: boolean }) =>
  report([
    ...(o.viaTransport === false ? [] : [{ id: 't', type: 'transport', selectedCandidatePairId: 'p' }]),
    { id: 'old', type: 'candidate-pair', localCandidateId: 'l0', remoteCandidateId: 'r0', nominated: false, state: 'failed' },
    {
      id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', nominated: true, state: 'succeeded',
      ...(o.rtt !== undefined ? { currentRoundTripTime: o.rtt } : {}),
    },
    { id: 'l0', type: 'local-candidate', protocol: 'udp', candidateType: 'host' },
    { id: 'r0', type: 'remote-candidate', protocol: 'udp', address: '10.0.0.5' },
    { id: 'l', type: 'local-candidate', protocol: o.protocol, candidateType: o.relay ? 'relay' : 'srflx' },
    { id: 'r', type: 'remote-candidate', protocol: o.protocol, address: o.address ?? '203.0.113.7', candidateType: 'host' },
  ]);

describe('selectedPath', () => {
  test('the transport-selected pair: protocol, server address, rtt in ms', () => {
    expect(selectedPath(pairStats({ protocol: 'udp', rtt: 0.0412 }))).toEqual({ protocol: 'udp', candidateIp: '203.0.113.7', rttMs: 41, relay: false });
  });

  test('without transport stats (Firefox) the nominated, succeeded pair', () => {
    expect(selectedPath(pairStats({ protocol: 'TCP', viaTransport: false }))).toEqual({ protocol: 'tcp', candidateIp: '203.0.113.7', rttMs: null, relay: false });
  });

  test('relay candidates are flagged', () => {
    expect(selectedPath(pairStats({ protocol: 'udp', relay: true }))?.relay).toBe(true);
  });

  test('no selected pair yet: null', () => {
    expect(selectedPath(report([{ id: 'p', type: 'candidate-pair', nominated: true, state: 'in-progress' }]))).toBeNull();
    expect(selectedPath(new Map())).toBeNull();
  });
});

const path = (protocol: string, o: Partial<Path> = {}): Path => ({ protocol, candidateIp: '203.0.113.7', rttMs: 30, relay: false, ...o });

describe('udp and tcp results', () => {
  test('UDP works when the first path is UDP', () => {
    expect(udpFromInitial(path('udp'), true)).toEqual({ ok: true, rttMs: 30 });
    expect(udpFromInitial(path('udp', { rttMs: null }), true)).toEqual({ ok: true });
  });

  test('UDP fails when ICE fell back to TCP, found no path, or there was no connection', () => {
    expect(udpFromInitial(path('tcp'), true)).toEqual({ ok: false, error: 'fell back to TCP' });
    expect(udpFromInitial(null, true).ok).toBe(false);
    expect(udpFromInitial(path('udp'), false).ok).toBe(false);
    expect(udpFromInitial(path('udp', { relay: true }), true).ok).toBe(false);
  });

  test('TCP: reconnected on a TCP pair works; still UDP means it could not be forced', () => {
    expect(tcpFromForced(path('tcp', { rttMs: 55 }), true)).toEqual({ ok: true, rttMs: 55 });
    expect(tcpFromForced(path('udp'), true)).toEqual({ ok: false, error: 'could not force TCP (still UDP)' });
    expect(tcpFromForced(null, false)).toEqual({ ok: false, error: 'did not reconnect over TCP' });
    expect(tcpFromForced(null, true)).toEqual({ ok: false, error: 'no media path' });
  });
});

describe('hints', () => {
  const ok = { ok: true };
  const bad = { ok: false };
  const ports = { tcp: 7881, udp: 7882 };
  const base = { https: { ok: true, latencyMs: 50 }, signaling: ok, tcp: ok, udp: ok };

  test('maps each failure to one plain-language hint', () => {
    expect(hints(base, ports)).toEqual([{ key: 'hintAllGood', params: { tcp: 7881, udp: 7882 } }]);
    expect(hints({ ...base, https: { ok: false, latencyMs: null } }, ports)[0]!.key).toBe('hintHttp');
    expect(hints({ ...base, signaling: bad, tcp: bad, udp: bad }, ports)[0]!.key).toBe('hintSignaling');
    expect(hints({ ...base, tcp: bad, udp: bad }, ports)[0]!.key).toBe('hintBoth');
    expect(hints({ ...base, udp: bad }, ports)[0]!.key).toBe('hintUdp');
    expect(hints({ ...base, tcp: bad }, ports)[0]!.key).toBe('hintTcp');
  });

  test('ports unknown: placeholders', () => {
    expect(hints({ ...base, udp: bad }, null)[0]!.params).toEqual({ tcp: '?', udp: '?' });
  });

  test('hint text names the ports in both languages', () => {
    const h = hints({ ...base, tcp: bad, udp: bad }, ports)[0]!;
    expect(tr('en', h.key, h.params)).toContain('TCP 7881 and UDP 7882');
    expect(tr('pt-BR', h.key, h.params)).toContain('TCP 7881 e UDP 7882');
  });
});

test('pickLocale: any Portuguese tag is pt-BR', () => {
  expect(pickLocale('pt-PT')).toBe('pt-BR');
  expect(pickLocale('pt')).toBe('pt-BR');
  expect(pickLocale('en-GB')).toBe('en');
  expect(pickLocale(undefined)).toBe('en');
});
