import { describe, expect, test } from 'bun:test';
import { VideoQuality } from 'livekit-client';
import {
  KBPS,
  alignDown,
  QUALITY,
  captureConstraints,
  displayMediaOptions,
  parseQuality,
  parseShareSettings,
  simulcastLayers,
  tuneEncodings,
} from './share';

describe('KBPS', () => {
  test('matches the 0.1.1 table', () => {
    expect(KBPS).toEqual({
      720: { 15: 2500, 30: 4000, 60: 6000 },
      1080: { 15: 4000, 30: 7000, 60: 12000 },
      1440: { 15: 6000, 30: 10000, 60: 16000 },
    });
  });
});

describe('alignDown', () => {
  test('rounds down to a multiple of 8', () => {
    expect([1920, 1080, 1311, 1079, 992, 7].map(alignDown)).toEqual([1920, 1080, 1304, 1072, 992, 0]);
  });
  test('aligned sizes give even /2 and /4 layers', () => {
    for (const n of [1311, 1079, 845, 1501, 993]) {
      const a = alignDown(n);
      expect([(a / 2) % 2, (a / 4) % 2]).toEqual([0, 0]);
    }
  });
});

describe('simulcastLayers', () => {
  const plain = (w: number, h: number, fps: number) =>
    simulcastLayers(w, h, fps).map((p) => [p.width, p.height, p.encoding.maxBitrate, p.encoding.maxFramerate]);

  test('720p and below: one half-size layer', () => {
    expect(plain(1280, 720, 60)).toEqual([[640, 360, 700_000, 15]]);
    expect(plain(856, 480, 30)).toEqual([[428, 240, 700_000, 15]]);
  });
  test('1080p: half + quarter size', () => {
    expect(plain(1920, 1080, 60)).toEqual([
      [960, 540, 3_000_000, 30],
      [480, 270, 700_000, 15],
    ]);
  });
  test('above 1080p: a richer half-size layer', () => {
    expect(plain(2560, 1440, 60)).toEqual([
      [1280, 720, 3_500_000, 30],
      [640, 360, 700_000, 15],
    ]);
  });
  test('layer fps never exceeds the capture fps', () => {
    expect(plain(1920, 1080, 15)).toEqual([
      [960, 540, 3_000_000, 15],
      [480, 270, 700_000, 15],
    ]);
  });
  test('livekit derives exact integer factors for any window size', () => {
    // 992x1080 broke H.265 in 0.1.1: a 1280x720 preset gave factor 1.378, and the HW encoder sent nothing
    for (const [w, h] of [[992, 1080], [1856, 1010], [993, 1079], [2560, 1440], [800, 600]]) {
      const factors = simulcastLayers(w, h, 60).map((p) => Math.min(w, h) / Math.min(p.width, p.height));
      expect(factors).toEqual(h > 720 ? [2, 4] : [2]);
    }
  });
});

describe('capture options', () => {
  test('captureConstraints', () => {
    expect(captureConstraints(1080, 60)).toEqual({
      height: { max: 1080 },
      frameRate: { ideal: 60, max: 60 },
      resizeMode: 'crop-and-scale',
    });
  });
  test('getDisplayMedia options match 0.1.1', () => {
    expect(displayMediaOptions(720, 30)).toEqual({
      video: captureConstraints(720, 30),
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
      systemAudio: 'include',
      windowAudio: 'window',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  });
});

describe('tuneEncodings', () => {
  test('top layer gets fps + full bitrate, lower layers are capped', () => {
    const encs: RTCRtpEncodingParameters[] = [
      { rid: 'q', scaleResolutionDownBy: 3, maxFramerate: 15, maxBitrate: 700_000 },
      { rid: 'h', scaleResolutionDownBy: 1.5, maxFramerate: 30, maxBitrate: 3_000_000 },
      { rid: 'f', scaleResolutionDownBy: 1, maxFramerate: 60, maxBitrate: 12_000_000 },
    ];
    tuneEncodings(encs, 720, 15);
    expect(encs.map((e) => [e.rid, e.maxFramerate, e.maxBitrate])).toEqual([
      ['q', 15, 700_000],
      ['h', 15, 3_000_000],
      ['f', 15, 2_500_000],
    ]);
  });
  test('a single encoding without scale is the top layer', () => {
    const encs: RTCRtpEncodingParameters[] = [{}];
    tuneEncodings(encs, 1440, 60);
    expect(encs[0]).toEqual({ maxFramerate: 60, maxBitrate: 16_000_000 });
  });
  test('no encodings: no-op', () => {
    const encs: RTCRtpEncodingParameters[] = [];
    tuneEncodings(encs, 1080, 30);
    expect(encs).toEqual([]);
  });
});

describe('stored settings', () => {
  test('quality map and parse', () => {
    expect(QUALITY).toEqual({
      auto: VideoQuality.HIGH,
      alta: VideoQuality.HIGH,
      media: VideoQuality.MEDIUM,
      baixa: VideoQuality.LOW,
    });
    expect(parseQuality('media')).toBe('media');
    expect(parseQuality('ultra')).toBe('auto');
    expect(parseQuality(null)).toBe('auto');
  });
  test('share settings fall back per field', () => {
    expect(parseShareSettings({ res: 720, fps: 30 })).toEqual({ res: 720, fps: 30 });
    expect(parseShareSettings({ res: '1440', fps: '15' })).toEqual({ res: 1440, fps: 15 });
    expect(parseShareSettings({ res: 999, fps: 30 })).toEqual({ res: 1080, fps: 30 });
    expect(parseShareSettings(null)).toEqual({ res: 1080, fps: 60 });
  });
});
