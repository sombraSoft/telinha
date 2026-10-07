// Pure parts of the phone test: which network path a WebRTC stats report shows,
// the report the page posts, and the plain-language hints for a result.
// No DOM, so bun test runs them.

/** Minimal view of RTCStatsReport (a maplike), so tests can pass a plain Map. */
export type StatsLike = { forEach(cb: (stat: any) => void): void };

type Stat = Record<string, any> & { id: string; type: string };

export type Path = {
  /** 'udp' | 'tcp' (the local candidate's transport). */
  protocol: string;
  /** The server's advertised address (remote candidate), so a wrong node IP shows. */
  candidateIp: string | null;
  rttMs: number | null;
  /** Went through a TURN relay. */
  relay: boolean;
  /** How the browser reaches the relay ('udp' | 'tcp' | 'tls'); null when not given (Firefox). */
  relayProtocol: string | null;
};

/** The candidate pair in use, or null while ICE has not picked one. */
export function selectedPath(report: StatsLike): Path | null {
  const all: Stat[] = [];
  const byId = new Map<string, Stat>();
  report.forEach((s: Stat) => {
    all.push(s);
    byId.set(s.id, s);
  });
  let pair: Stat | undefined;
  for (const s of all) {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
  }
  // Firefox has no transport stats; it flags the pair itself.
  pair ??= all.find((s) => s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')));
  if (!pair) return null;
  const local = byId.get(pair.localCandidateId);
  const remote = byId.get(pair.remoteCandidateId);
  const protocol = String(local?.protocol ?? remote?.protocol ?? '').toLowerCase();
  if (!protocol) return null;
  const rtt = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
  return {
    protocol,
    candidateIp: (remote?.address ?? remote?.ip ?? null) as string | null,
    rttMs: rtt,
    relay: [local, remote].some((c) => c?.candidateType === 'relay'),
    relayProtocol: typeof local?.relayProtocol === 'string' ? local.relayProtocol.toLowerCase() : null,
  };
}

export type StepResult = { ok: boolean; rttMs?: number; error?: string };

/** What the page posts to /doctor/api/report (the server validates every field). */
export type Report = {
  https: { ok: boolean; latencyMs: number | null };
  signaling: { ok: boolean; error?: string };
  initial: { protocol: string; candidateIp: string | null; rttMs: number | null } | null;
  tcp: StepResult;
  udp: StepResult;
  publish: { ok: boolean; error?: string };
  /** null when the server offers no TURN over TLS. */
  turn: StepResult | null;
  client: { ua: string };
  startedAt: number;
  finishedAt: number;
};

/**
 * UDP from the first path: ICE prefers UDP, so landing on TCP (or no path at
 * all) means UDP did not get through. The browser cannot be told to use UDP
 * only; only TCP can be forced, which is the separate TCP step.
 */
export function udpFromInitial(initial: Path | null, signalingOk: boolean): StepResult {
  if (!signalingOk) return { ok: false, error: 'no connection' };
  if (!initial) return { ok: false, error: 'no media path' };
  if (initial.protocol === 'udp' && !initial.relay)
    return { ok: true, ...(initial.rttMs !== null ? { rttMs: initial.rttMs } : {}) };
  return { ok: false, error: `fell back to ${initial.protocol.toUpperCase()}` };
}

/** The TCP step after force-tcp: a path that still says UDP means TCP could not be forced. */
export function tcpFromForced(path: Path | null, reconnected: boolean, error?: string): StepResult {
  if (!reconnected) return { ok: false, error: error ?? 'did not reconnect over TCP' };
  if (!path) return { ok: false, error: 'no media path' };
  if (path.protocol !== 'tcp')
    return { ok: false, error: `could not force TCP (still ${path.protocol.toUpperCase()})` };
  return { ok: true, ...(path.rttMs !== null ? { rttMs: path.rttMs } : {}) };
}

/**
 * The TURN step after force-tls. The relay must carry it, and over TLS: a
 * browser that relays over UDP or TCP instead did not prove port 443 works.
 * A missing relayProtocol (Firefox) is taken as TLS, the only relay offered.
 */
export function turnFromForced(path: Path | null, reconnected: boolean): StepResult {
  if (!reconnected) return { ok: false, error: 'did not reconnect through TURN' };
  if (!path) return { ok: false, error: 'no media path' };
  if (!path.relay) return { ok: false, error: 'not relayed' };
  if (path.relayProtocol !== null && path.relayProtocol !== 'tls')
    return { ok: false, error: `relayed over ${path.relayProtocol}, not TLS` };
  return { ok: true, ...(path.rttMs !== null ? { rttMs: path.rttMs } : {}) };
}

export type Media = 'self' | 'cloud';
export type HintKey =
  | 'hintSignaling'
  | 'hintBoth'
  | 'hintUdp'
  | 'hintTcp'
  | 'hintHttp'
  | 'hintAllGood'
  | 'hintCloudSignaling'
  | 'hintCloudBoth'
  | 'hintCloudUdp'
  | 'hintCloudTcp'
  | 'hintTurn';
export type Hint = { key: HintKey; params: Record<string, string | number> };

/** Plain-language explanation of a finished report, most important first. */
export function hints(
  r: Pick<Report, 'https' | 'signaling' | 'tcp' | 'udp'> & { turn?: StepResult | null },
  ports: { tcp: number; udp: number } | null,
  media: Media = 'self',
  turnHost: string | null = null,
): Hint[] {
  const params = { tcp: ports?.tcp ?? '?', udp: ports?.udp ?? '?' };
  const main = mainHint(r, media);
  const out: Hint[] = [{ key: main, params }];
  if (r.turn && !r.turn.ok) out.push({ key: 'hintTurn', params: { turnHost: turnHost ?? 'turn.<host>' } });
  return out;
}

function mainHint(r: Pick<Report, 'https' | 'signaling' | 'tcp' | 'udp'>, media: Media): HintKey {
  // With LiveKit Cloud there is no port to open here: a media failure is the phone's network.
  const cloud = media === 'cloud';
  if (!r.https.ok) return 'hintHttp';
  // The page itself came from PUBLIC_URL: in cloud mode signaling goes straight to Cloud.
  if (!r.signaling.ok) return cloud ? 'hintCloudSignaling' : 'hintSignaling';
  if (!r.tcp.ok && !r.udp.ok) return cloud ? 'hintCloudBoth' : 'hintBoth';
  if (!r.udp.ok) return cloud ? 'hintCloudUdp' : 'hintUdp';
  if (!r.tcp.ok) return cloud ? 'hintCloudTcp' : 'hintTcp';
  return 'hintAllGood';
}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
