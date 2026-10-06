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
  if (initial.protocol === 'udp' && !initial.relay) return { ok: true, ...(initial.rttMs !== null ? { rttMs: initial.rttMs } : {}) };
  return { ok: false, error: `fell back to ${initial.protocol.toUpperCase()}` };
}

/** The TCP step after force-tcp: a path that still says UDP means TCP could not be forced. */
export function tcpFromForced(path: Path | null, reconnected: boolean, error?: string): StepResult {
  if (!reconnected) return { ok: false, error: error ?? 'did not reconnect over TCP' };
  if (!path) return { ok: false, error: 'no media path' };
  if (path.protocol !== 'tcp') return { ok: false, error: `could not force TCP (still ${path.protocol.toUpperCase()})` };
  return { ok: true, ...(path.rttMs !== null ? { rttMs: path.rttMs } : {}) };
}

export type HintKey = 'hintSignaling' | 'hintBoth' | 'hintUdp' | 'hintTcp' | 'hintHttp' | 'hintAllGood';
export type Hint = { key: HintKey; params: Record<string, string | number> };

/** Plain-language explanation of a finished report, most important first. */
export function hints(r: Pick<Report, 'https' | 'signaling' | 'tcp' | 'udp'>, ports: { tcp: number; udp: number } | null): Hint[] {
  const params = { tcp: ports?.tcp ?? '?', udp: ports?.udp ?? '?' };
  if (!r.https.ok) return [{ key: 'hintHttp', params }];
  if (!r.signaling.ok) return [{ key: 'hintSignaling', params }];
  if (!r.tcp.ok && !r.udp.ok) return [{ key: 'hintBoth', params }];
  if (!r.udp.ok) return [{ key: 'hintUdp', params }];
  if (!r.tcp.ok) return [{ key: 'hintTcp', params }];
  return [{ key: 'hintAllGood', params }];
}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
