import { describe, expect, test } from 'bun:test';
import { qualityLabel, streamLabel, summarize, type VideoStats } from './stats';

const report = (stats: Record<string, unknown>[]) => new Map(stats.map((s) => [s.id as string, s]));

describe('summarize', () => {
  const outbound = (ts: number, bytes: [number, number]) =>
    report([
      { id: 'c1', type: 'codec', mimeType: 'video/H264' },
      { id: 'o-low', type: 'outbound-rtp', kind: 'video', frameHeight: 360, frameWidth: 640, bytesSent: bytes[0], timestamp: ts },
      {
        id: 'o-top',
        type: 'outbound-rtp',
        kind: 'video',
        frameHeight: 1080,
        frameWidth: 1920,
        framesPerSecond: 59.6,
        bytesSent: bytes[1],
        codecId: 'c1',
        encoderImplementation: 'OpenH264',
        qualityLimitationReason: 'bandwidth',
        timestamp: ts,
      },
      { id: 'a', type: 'outbound-rtp', kind: 'audio', bytesSent: 999_999, timestamp: ts },
      { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
      { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.0234 },
      { id: 'l', type: 'local-candidate', candidateType: 'host' },
      { id: 'r', type: 'remote-candidate', candidateType: 'relay' },
    ]);

  test('picks the biggest simulcast layer and sums video bytes', () => {
    const first = summarize(outbound(1000, [100_000, 400_000]));
    expect(first?.stats).toEqual({
      out: true,
      width: 1920,
      height: 1080,
      fps: 60,
      mbps: 0,
      codec: 'H264',
      impl: 'OpenH264',
      limitation: 'bandwidth',
      lost: 0,
      relay: true,
      rttMs: 23,
    });
    expect(first?.sample).toEqual({ bytes: 500_000, t: 1000 });
    // +1.5 MB in 1 s = 12 Mbps
    const second = summarize(outbound(2000, [400_000, 1_600_000]), first?.sample);
    expect(second?.stats.mbps).toBeCloseTo(12, 5);
  });

  test('inbound: decoder and packets lost, no path yet', () => {
    const r = summarize(
      report([
        { id: 'c', type: 'codec', mimeType: 'video/VP8' },
        { id: 'i', type: 'inbound-rtp', kind: 'video', frameHeight: 720, frameWidth: 1280, framesPerSecond: 30, bytesReceived: 10, packetsLost: 4, codecId: 'c', decoderImplementation: 'libvpx', timestamp: 5 },
      ]),
    );
    expect(r?.stats).toMatchObject({ out: false, codec: 'VP8', impl: 'libvpx', lost: 4, relay: null, rttMs: null });
  });

  test('Firefox-style selected candidate pair', () => {
    const r = summarize(
      report([
        { id: 'i', type: 'inbound-rtp', kind: 'video', frameHeight: 720, timestamp: 1 },
        { id: 'p', type: 'candidate-pair', selected: true, localCandidateId: 'l', remoteCandidateId: 'r', currentRoundTripTime: 0.01 },
        { id: 'l', type: 'local-candidate', candidateType: 'host' },
        { id: 'r', type: 'remote-candidate', candidateType: 'host' },
      ]),
    );
    expect(r?.stats).toMatchObject({ relay: false, rttMs: 10 });
  });

  test('no video rtp stats: null', () => {
    expect(summarize(report([{ id: 'a', type: 'inbound-rtp', kind: 'audio' }]))).toBeNull();
  });
});

describe('qualityLabel', () => {
  test('<h>p<fps>, empty without frames', () => {
    expect(qualityLabel(summarize(report([{ id: 'i', type: 'inbound-rtp', kind: 'video', frameHeight: 720, framesPerSecond: 29.7 }]))?.stats)).toBe('720p30');
    expect(qualityLabel(undefined)).toBe('');
  });
});

describe('streamLabel', () => {
  const out: VideoStats = {
    out: true, width: 1920, height: 1080, fps: 59, mbps: 8, codec: 'H265', impl: '', limitation: '-', lost: 0, relay: false, rttMs: 1,
  };
  test('height, snapped fps and codec for the /telinha card', () => {
    expect(streamLabel(out)).toBe('1080p60 · H265');
    expect(streamLabel({ ...out, fps: 29, codec: 'av1' })).toBe('1080p30 · AV1');
    expect(streamLabel({ ...out, height: 720, fps: 14, codec: '' })).toBe('720p15');
    expect(streamLabel({ ...out, fps: 2 })).toBe('1080p5 · H265');
  });
  test('nothing until frames go out, and never for a received stream', () => {
    expect(streamLabel(undefined)).toBe('');
    expect(streamLabel({ ...out, height: 0 })).toBe('');
    expect(streamLabel({ ...out, fps: 0 })).toBe('');
    expect(streamLabel({ ...out, out: false })).toBe('');
  });
});
