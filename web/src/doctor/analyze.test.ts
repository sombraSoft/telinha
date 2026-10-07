import { describe, expect, test } from 'bun:test';
import { hints, type Path, selectedPath, tcpFromForced, turnFromForced, udpFromInitial } from './analyze';
import { pickLocale, tr } from './strings';

const report = (stats: Record<string, unknown>[]) => new Map(stats.map((s) => [s.id as string, s]));

const pairStats = (o: {
  protocol: string;
  address?: string;
  rtt?: number;
  viaTransport?: boolean;
  relay?: boolean;
  relayProtocol?: string;
}) =>
  report([
    ...(o.viaTransport === false ? [] : [{ id: 't', type: 'transport', selectedCandidatePairId: 'p' }]),
    {
      id: 'old',
      type: 'candidate-pair',
      localCandidateId: 'l0',
      remoteCandidateId: 'r0',
      nominated: false,
      state: 'failed',
    },
    {
      id: 'p',
      type: 'candidate-pair',
      localCandidateId: 'l',
      remoteCandidateId: 'r',
      nominated: true,
      state: 'succeeded',
      ...(o.rtt !== undefined ? { currentRoundTripTime: o.rtt } : {}),
    },
    { id: 'l0', type: 'local-candidate', protocol: 'udp', candidateType: 'host' },
    { id: 'r0', type: 'remote-candidate', protocol: 'udp', address: '10.0.0.5' },
    {
      id: 'l',
      type: 'local-candidate',
      protocol: o.protocol,
      candidateType: o.relay ? 'relay' : 'srflx',
      ...(o.relayProtocol !== undefined ? { relayProtocol: o.relayProtocol } : {}),
    },
    {
      id: 'r',
      type: 'remote-candidate',
      protocol: o.protocol,
      address: o.address ?? '203.0.113.7',
      candidateType: 'host',
    },
  ]);

describe('selectedPath', () => {
  test('the transport-selected pair: protocol, SFU address, rtt in ms', () => {
    expect(selectedPath(pairStats({ protocol: 'udp', rtt: 0.0412 }))).toEqual({
      protocol: 'udp',
      candidateIp: '203.0.113.7',
      rttMs: 41,
      relay: false,
      relayProtocol: null,
    });
  });

  test('without transport stats (Firefox) the nominated, succeeded pair', () => {
    expect(selectedPath(pairStats({ protocol: 'TCP', viaTransport: false }))).toEqual({
      protocol: 'tcp',
      candidateIp: '203.0.113.7',
      rttMs: null,
      relay: false,
      relayProtocol: null,
    });
  });

  test('relay candidates are flagged', () => {
    expect(selectedPath(pairStats({ protocol: 'udp', relay: true }))?.relay).toBe(true);
  });

  test('relayProtocol comes from the local candidate, lowercased; absent (Firefox) is null', () => {
    expect(selectedPath(pairStats({ protocol: 'udp', relay: true, relayProtocol: 'TLS' }))?.relayProtocol).toBe('tls');
    expect(selectedPath(pairStats({ protocol: 'udp', relay: true, relayProtocol: 'tcp' }))?.relayProtocol).toBe('tcp');
    expect(selectedPath(pairStats({ protocol: 'udp', relay: true }))?.relayProtocol).toBeNull();
  });

  test('no selected pair yet: null', () => {
    expect(
      selectedPath(report([{ id: 'p', type: 'candidate-pair', nominated: true, state: 'in-progress' }])),
    ).toBeNull();
    expect(selectedPath(new Map())).toBeNull();
  });
});

const path = (protocol: string, o: Partial<Path> = {}): Path => ({
  protocol,
  candidateIp: '203.0.113.7',
  rttMs: 30,
  relay: false,
  relayProtocol: null,
  ...o,
});

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

  test('TURN: works only relayed over TLS (or relayed with no protocol given)', () => {
    expect(turnFromForced(path('udp', { relay: true, relayProtocol: 'tls', rttMs: 80 }), true)).toEqual({
      ok: true,
      rttMs: 80,
    });
    expect(turnFromForced(path('udp', { relay: true, rttMs: null }), true)).toEqual({ ok: true });
    expect(turnFromForced(null, false)).toEqual({ ok: false, error: 'did not reconnect through TURN' });
    expect(turnFromForced(null, true)).toEqual({ ok: false, error: 'no media path' });
    expect(turnFromForced(path('udp'), true)).toEqual({ ok: false, error: 'not relayed' });
    expect(turnFromForced(path('udp', { relay: true, relayProtocol: 'udp' }), true)).toEqual({
      ok: false,
      error: 'relayed over udp, not TLS',
    });
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

  test('cloud: the media hints say the phone network, not ports', () => {
    expect(hints({ ...base, tcp: bad, udp: bad }, null, 'cloud')[0]!.key).toBe('hintCloudBoth');
    expect(hints({ ...base, udp: bad }, null, 'cloud')[0]!.key).toBe('hintCloudUdp');
    expect(hints({ ...base, tcp: bad }, null, 'cloud')[0]!.key).toBe('hintCloudTcp');
    expect(hints(base, null, 'cloud')[0]!.key).toBe('hintAllGood');
    expect(hints({ ...base, signaling: bad }, null, 'cloud')[0]!.key).toBe('hintCloudSignaling');
    expect(hints({ ...base, https: { ok: false, latencyMs: null } }, null, 'cloud')[0]!.key).toBe('hintHttp');
    expect(tr('en', 'hintCloudBoth')).toContain('Nothing to open on your side');
  });

  test('cloud: a signaling failure points at LiveKit Cloud, not at PUBLIC_URL, DNS or the router', () => {
    expect(hints({ ...base, signaling: bad, tcp: bad, udp: bad }, null, 'cloud')[0]!.key).toBe('hintCloudSignaling');
    for (const locale of ['en', 'pt-BR'] as const) {
      const text = tr(locale, 'hintCloudSignaling');
      expect(text).toContain('LiveKit Cloud');
      expect(text).toContain('livekit-cloud');
      expect(text).not.toMatch(/DNS|rout/);
    }
  });

  test('a failed TURN step adds hintTurn after the main hint; ok or absent adds nothing', () => {
    expect(hints({ ...base, turn: bad }, ports).map((h) => h.key)).toEqual(['hintAllGood', 'hintTurn']);
    expect(hints({ ...base, udp: bad, turn: bad }, null, 'cloud').map((h) => h.key)).toEqual([
      'hintCloudUdp',
      'hintTurn',
    ]);
    expect(hints({ ...base, turn: ok }, ports).map((h) => h.key)).toEqual(['hintAllGood']);
    expect(hints({ ...base, turn: null }, ports).map((h) => h.key)).toEqual(['hintAllGood']);
    expect(hints({ ...base, turn: bad }, ports, 'self', 'turn.x.duckdns.org')[1]).toEqual({
      key: 'hintTurn',
      params: { turnHost: 'turn.x.duckdns.org' },
    });
    expect(hints({ ...base, turn: bad }, ports)[1]!.params).toEqual({ turnHost: 'turn.<host>' });
    expect(tr('pt-BR', 'hintTurn', { turnHost: 'turn.x.duckdns.org' })).toContain('certificado de turn.x.duckdns.org)');
    expect(tr('en', 'hintTurn', { turnHost: 'turn.x.duckdns.org' })).toContain('certificate for turn.x.duckdns.org)');
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
