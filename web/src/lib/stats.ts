// Turns a WebRTC stats report into the numbers the 📊 overlay shows.

/**
 * The fields of a WebRTC stats entry that this file and the doctor read. All
 * but id and type are optional: each stats type carries its own subset, and
 * browsers differ (Firefox has no transport stats, no relayProtocol).
 */
export type Stat = {
  id: string;
  type: string;
  timestamp?: number;
  kind?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  bytesSent?: number;
  bytesReceived?: number;
  packetsLost?: number;
  codecId?: string;
  mimeType?: string;
  encoderImplementation?: string;
  decoderImplementation?: string;
  qualityLimitationReason?: string;
  selectedCandidatePairId?: string;
  selected?: boolean;
  nominated?: boolean;
  state?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  currentRoundTripTime?: number;
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
  address?: string;
  ip?: string;
};

/** Minimal view of RTCStatsReport (a maplike), so tests can pass a plain Map. */
export type StatsLike = { forEach(cb: (stat: Stat) => void): void };
export type ByteSample = { bytes: number; t: number };

export type VideoStats = {
  out: boolean;
  width: number;
  height: number;
  fps: number;
  mbps: number;
  codec: string;
  impl: string;
  /** outbound only: qualityLimitationReason */
  limitation: string;
  /** inbound only */
  lost: number;
  /** null when the transport has no selected pair yet */
  relay: boolean | null;
  rttMs: number | null;
};

export function summarize(report: StatsLike, prev?: ByteSample): { stats: VideoStats; sample: ByteSample } | null {
  const all: Stat[] = [];
  const byId = new Map<string, Stat>();
  report.forEach((s: Stat) => {
    all.push(s);
    byId.set(s.id, s);
  });
  const get = (id: string | undefined) => (id === undefined ? undefined : byId.get(id));

  // Simulcast sends several outbound-rtp streams: report the biggest one.
  let best: Stat | undefined;
  for (const s of all) {
    if ((s.type === 'inbound-rtp' || s.type === 'outbound-rtp') && s.kind === 'video') {
      if (!best || (s.frameHeight || 0) > (best.frameHeight || 0)) best = s;
    }
  }
  if (!best) return null;
  const out = best.type === 'outbound-rtp';

  let bytes = 0;
  for (const s of all) {
    if (s.type === best.type && s.kind === 'video') bytes += (out ? s.bytesSent : s.bytesReceived) || 0;
  }
  const t = Number(best.timestamp) || 0;
  const mbps = prev && t > prev.t ? ((bytes - prev.bytes) * 8) / ((t - prev.t) * 1000) : 0;

  let pair: Stat | undefined;
  for (const s of all) {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
  }
  // Firefox has no transport stats; it flags the pair itself.
  pair ??= all.find((s) => s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')));
  const relay = pair
    ? [get(pair.localCandidateId), get(pair.remoteCandidateId)].some((c) => c?.candidateType === 'relay')
    : null;

  return {
    stats: {
      out,
      width: best.frameWidth || 0,
      height: best.frameHeight || 0,
      fps: Math.round(best.framesPerSecond || 0),
      mbps: Math.max(0, mbps),
      codec: String(get(best.codecId)?.mimeType || '').replace('video/', ''),
      impl: String((out ? best.encoderImplementation : best.decoderImplementation) || ''),
      limitation: String(best.qualityLimitationReason || '-'),
      lost: Number(best.packetsLost ?? 0),
      relay,
      rttMs: pair ? Math.round((pair.currentRoundTripTime || 0) * 1000) : null,
    },
    sample: { bytes, t },
  };
}

/** "1080p60" badge; empty until frames arrive. */
export function qualityLabel(s: VideoStats | undefined): string {
  return s?.height ? `${s.height}p${s.fps}` : '';
}

export type CodecCaps = { codec: 'H265' | 'AV1'; send: boolean; recv: boolean };

/** What this browser can send/receive (why a stream fell back to H.264). */
export function codecCaps(): CodecCaps[] {
  const has = (caps: RTCRtpCapabilities | null | undefined, mime: string) =>
    !!caps?.codecs.some((c) => c.mimeType === mime);
  const send = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video') : null;
  const recv = typeof RTCRtpReceiver !== 'undefined' ? RTCRtpReceiver.getCapabilities?.('video') : null;
  return (['H265', 'AV1'] as const).map((codec) => ({
    codec,
    send: has(send, `video/${codec}`),
    recv: has(recv, `video/${codec}`),
  }));
}

/**
 * What the streamer's page reports to Telinha for the bot's room card, e.g.
 * "1080p60 · H265". fps snaps to a multiple of 5 so the jitter of a live
 * encoder (59, 60, 58) doesn't edit the Discord message every few seconds.
 */
export function streamLabel(s: VideoStats | undefined): string {
  if (!s?.out || !s.height || !s.fps) return '';
  const fps = Math.max(5, Math.round(s.fps / 5) * 5);
  const codec = s.codec.toUpperCase();
  return codec ? `${s.height}p${fps} · ${codec}` : `${s.height}p${fps}`;
}
