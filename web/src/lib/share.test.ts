// The settings vocabulary only; capture and publishing are tested through the
// room session (room.test.ts).
import { describe, expect, test } from 'bun:test';
import { VideoQuality } from 'livekit-client';
import { QUALITY, parseQuality, parseShareSettings, presetOf, type ShareSettings } from './share';

describe('presets', () => {
  test('values pick their preset, anything else is custom', () => {
    expect(presetOf(1080, 60)).toBe('smooth');
    expect(presetOf(1440, 15)).toBe('readable');
    expect(presetOf(1440, 60)).toBe('custom');
    expect(presetOf(720, 15)).toBe('custom');
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
  test('share settings: the old {res, fps} format still loads, audio on', () => {
    expect(parseShareSettings({ res: 720, fps: 30 })).toEqual({ res: 720, fps: 30, preset: 'custom', audio: true });
    expect(parseShareSettings({ res: '1440', fps: '15' })).toEqual({ res: 1440, fps: 15, preset: 'readable', audio: true });
    expect(parseShareSettings({ res: 1080, fps: 60 })).toEqual({ res: 1080, fps: 60, preset: 'smooth', audio: true });
  });
  test('share settings: the new format round-trips', () => {
    const stored: ShareSettings[] = [
      { res: 1080, fps: 60, preset: 'smooth', audio: false },
      { res: 1440, fps: 15, preset: 'readable', audio: true },
      { res: 720, fps: 60, preset: 'custom', audio: false },
      // Custom picked on purpose keeps the motion hint even on preset values.
      { res: 1440, fps: 15, preset: 'custom', audio: true },
    ];
    for (const v of stored) expect(parseShareSettings(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });
  test('share settings: garbage falls back per field to Smoother video with sound', () => {
    expect(parseShareSettings(null)).toEqual({ res: 1080, fps: 60, preset: 'smooth', audio: true });
    expect(parseShareSettings('1080p')).toEqual({ res: 1080, fps: 60, preset: 'smooth', audio: true });
    expect(parseShareSettings([720, 30])).toEqual({ res: 1080, fps: 60, preset: 'smooth', audio: true });
    expect(parseShareSettings({ res: 999, fps: 30, audio: 'no' })).toEqual({ res: 1080, fps: 30, preset: 'custom', audio: true });
    // A preset name that doesn't match the values follows the values.
    expect(parseShareSettings({ res: 720, fps: 15, preset: 'smooth' })).toEqual({ res: 720, fps: 15, preset: 'custom', audio: true });
    expect(parseShareSettings({ res: 1440, fps: 15, preset: 'ultra', audio: false })).toEqual({ res: 1440, fps: 15, preset: 'readable', audio: false });
  });
});
