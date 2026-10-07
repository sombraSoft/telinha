// Share settings (what the modal edits and prefs store) and the viewer's
// quality pick. Capture and publishing live in local-share.svelte.ts.
import { VideoQuality } from 'livekit-client';

export const RESOLUTIONS = [720, 1080, 1440] as const;
export const FRAME_RATES = [15, 30, 60] as const;
export type Res = (typeof RESOLUTIONS)[number];
export type Fps = (typeof FRAME_RATES)[number];
// Discord-style presets; any other res x fps pick is 'custom'.
export const PRESETS = ['smooth', 'readable', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_SETTINGS: Record<Exclude<Preset, 'custom'>, { res: Res; fps: Fps }> = {
  smooth: { res: 1080, fps: 60 },
  readable: { res: 1440, fps: 15 },
};
/** audio: whether to ask the picker for sound at all. */
export type ShareSettings = { res: Res; fps: Fps; preset: Preset; audio: boolean };
export const DEFAULT_SHARE: ShareSettings = { ...PRESET_SETTINGS.smooth, preset: 'smooth', audio: true };

/** The preset these values match, else 'custom'. */
export function presetOf(res: Res, fps: Fps): Preset {
  if (res === PRESET_SETTINGS.smooth.res && fps === PRESET_SETTINGS.smooth.fps) return 'smooth';
  if (res === PRESET_SETTINGS.readable.res && fps === PRESET_SETTINGS.readable.fps) return 'readable';
  return 'custom';
}

/** Phones have no screen capture: no share controls there at all. */
export const canShareScreen = (): boolean =>
  typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

// Viewer-side quality pick. Values are the 0.1.1 stored strings.
export const QUALITY_CHOICES = ['auto', 'alta', 'media', 'baixa'] as const;
export type QualityChoice = (typeof QUALITY_CHOICES)[number];
export const QUALITY: Record<QualityChoice, VideoQuality> = {
  auto: VideoQuality.HIGH,
  alta: VideoQuality.HIGH,
  media: VideoQuality.MEDIUM,
  baixa: VideoQuality.LOW,
};

export function parseQuality(v: unknown): QualityChoice {
  return (QUALITY_CHOICES as readonly unknown[]).includes(v) ? (v as QualityChoice) : 'auto';
}

/**
 * Stored settings, field by field. Before 0.5 only {res, fps} was stored: the
 * preset then follows from the values, and audio stays on as it always was.
 * A named preset whose values don't match falls back the same way.
 */
export function parseShareSettings(v: unknown): ShareSettings {
  const o = (v && typeof v === 'object' ? v : {}) as { res?: unknown; fps?: unknown; preset?: unknown; audio?: unknown };
  const r = Number(o.res);
  const f = Number(o.fps);
  const res = (RESOLUTIONS as readonly number[]).includes(r) ? (r as Res) : DEFAULT_SHARE.res;
  const fps = (FRAME_RATES as readonly number[]).includes(f) ? (f as Fps) : DEFAULT_SHARE.fps;
  const matched = presetOf(res, fps);
  return {
    res,
    fps,
    preset: o.preset === 'custom' ? 'custom' : matched,
    audio: typeof o.audio === 'boolean' ? o.audio : DEFAULT_SHARE.audio,
  };
}
