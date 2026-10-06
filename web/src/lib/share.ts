// Screen capture, codec pick and encoder settings for the local stream.
import {
  AudioPresets,
  Track,
  VideoPreset,
  VideoQuality,
  type LocalAudioTrack,
  type LocalParticipant,
  type LocalVideoTrack,
} from 'livekit-client';

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

// Text stays sharp for readability; everything else keeps its frame rate.
// Never 'maintain-framerate': it collapsed screen shares to 359x201.
export const contentHintOf = (p: Preset): 'detail' | 'motion' => (p === 'readable' ? 'detail' : 'motion');
export const degradationOf = (p: Preset): RTCDegradationPreference =>
  p === 'readable' ? 'maintain-resolution' : 'balanced';

// Top-layer bitrate (kbps) per resolution x fps. The SFU sends viewers lower
// simulcast layers when their tile is small or their connection is weak.
export const KBPS: Record<Res, Record<Fps, number>> = {
  720: { 15: 2500, 30: 4000, 60: 6000 },
  1080: { 15: 4000, 30: 7000, 60: 12000 },
  1440: { 15: 6000, 30: 10000, 60: 16000 },
};

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

// resizeMode is a Chrome constraint missing from lib.dom.
export type CaptureConstraints = MediaTrackConstraints & { resizeMode: 'crop-and-scale' };

export function captureConstraints(res: Res, fps: Fps): CaptureConstraints {
  return { height: { max: res }, frameRate: { ideal: fps, max: fps }, resizeMode: 'crop-and-scale' };
}

// Lower layers are exactly /2 and /4 of the capture. livekit-client derives
// each factor as min(w,h) / min(layer w,h) from the same getSettings() size,
// so they come out as integers, and it keeps them when the window is resized.
export function simulcastLayers(width: number, height: number, fps: number): VideoPreset[] {
  const layer = (div: number, kbps: number, maxFps: number) =>
    new VideoPreset(width / div, height / div, kbps * 1000, Math.min(fps, maxFps));
  if (height > 1080) return [layer(2, 3500, 30), layer(4, 700, 15)];
  if (height > 720) return [layer(2, 3000, 30), layer(4, 700, 15)];
  return [layer(2, 700, 15)];
}

// Chrome's insertable streams ("breakout box"), not in lib.dom yet.
declare const MediaStreamTrackProcessor: (new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }) | undefined;
declare const MediaStreamTrackGenerator: (new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> }) | undefined;

export const ALIGN = 8;
export const alignDown = (n: number) => n - (n % ALIGN);

/**
 * Hardware HEVC (Chrome's NVIDIA MFT on Windows, at least) encodes nothing when
 * any simulcast layer has an odd width or height, and Chrome then switches the
 * stream to another codec for good (viewers end up on the H.264 backup). Window
 * captures have any size and change size when the window is resized, so every
 * frame is cropped to multiples of ALIGN: the /2 and /4 layers are then always
 * even. visibleRect crops without copying pixels. Returns null where the API is
 * missing (Firefox, which has no H.265 anyway).
 */
export function alignedTrack(src: MediaStreamTrack): MediaStreamTrack | null {
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') return null;
  const { readable } = new MediaStreamTrackProcessor({ track: src });
  const out = new MediaStreamTrackGenerator({ kind: 'video' });
  const crop = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, ctl) {
      const r = frame.visibleRect;
      if (!r) return ctl.enqueue(frame);
      const width = alignDown(r.width);
      const height = alignDown(r.height);
      if ((width === r.width && height === r.height) || !width || !height) return ctl.enqueue(frame);
      ctl.enqueue(new VideoFrame(frame, { visibleRect: { x: r.x, y: r.y, width, height }, displayWidth: width, displayHeight: height }));
      frame.close();
    },
  });
  // Ends by itself when the capture stops (the processor's stream closes).
  readable.pipeThrough(crop).pipeTo(out.writable).catch(() => {});
  return out;
}

/** The generator only reports its size once a frame went through. */
async function settledSize(track: MediaStreamTrack, timeoutMs = 3000): Promise<{ width: number; height: number }> {
  for (let waited = 0; ; waited += 50) {
    const { width = 0, height = 0 } = track.getSettings();
    if ((width && height) || waited >= timeoutMs) return { width, height };
    await new Promise((r) => setTimeout(r, 50));
  }
}

type DisplayOptions = DisplayMediaStreamOptions & {
  systemAudio?: 'include' | 'exclude';
  windowAudio?: 'exclude' | 'window' | 'system';
  selfBrowserSurface?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
};

/** Without audio the picker shows no sound option at all. */
export function displayMediaOptions(res: Res, fps: Fps, audio = true): DisplayOptions {
  const surfaces = { selfBrowserSurface: 'exclude', surfaceSwitching: 'include' } as const;
  if (!audio) return { video: captureConstraints(res, fps), audio: false, ...surfaces };
  return {
    video: captureConstraints(res, fps),
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
    systemAudio: 'include',
    windowAudio: 'window', // Chrome: offer the game window's own audio (no Discord voices)
    ...surfaces,
  };
}

export type Codec = 'av1' | 'h265' | 'h264';

export async function pickCodec(): Promise<Codec> {
  // AV1 only with a hardware encoder; H.265 is only offered with one in Chrome.
  try {
    const r = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: { contentType: 'video/AV1', width: 1920, height: 1080, bitrate: 12e6, framerate: 60 },
    });
    if (r.supported && r.powerEfficient) return 'av1';
  } catch {}
  const send = RTCRtpSender.getCapabilities?.('video')?.codecs.map((c) => c.mimeType) ?? [];
  return send.includes('video/H265') ? 'h265' : 'h264';
}

/** New fps/bitrate for a live sender: top layer gets the full budget, lower layers are capped. */
export function tuneEncodings(encodings: RTCRtpEncodingParameters[], res: Res, fps: Fps): void {
  const top = encodings.reduce<RTCRtpEncodingParameters | undefined>(
    (a, b) => (!a || (b.scaleResolutionDownBy || 1) < (a.scaleResolutionDownBy || 1) ? b : a),
    undefined,
  );
  if (!top) return;
  for (const e of encodings) e.maxFramerate = e === top ? fps : Math.min(fps, e.maxFramerate || fps);
  top.maxBitrate = KBPS[res][fps] * 1000;
}

// Tracks, not publications: a full reconnect republishes the same LocalTracks
// under new publications and leaves the old ones without a track.
export type Share = {
  video: LocalVideoTrack;
  /** The raw capture track (constraints go here; video may be its aligned copy). */
  capture: MediaStreamTrack;
  audio: LocalAudioTrack | null;
  stream: MediaStream;
  codec: Codec;
};

export type ShareOutcome =
  | { kind: 'ok'; share: Share }
  | { kind: 'cancelled' }
  | { kind: 'error'; stage: 'capture' | 'publish'; message: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function startShare(
  lp: LocalParticipant,
  { res, fps, preset, audio: withAudio }: ShareSettings,
  onEnded: () => void,
): Promise<ShareOutcome> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(res, fps, withAudio));
  } catch (e) {
    // NotAllowedError = the user closed the picker
    if ((e as { name?: unknown } | null)?.name === 'NotAllowedError') return { kind: 'cancelled' };
    return { kind: 'error', stage: 'capture', message: messageOf(e) };
  }
  const v = stream.getVideoTracks()[0];
  const a = stream.getAudioTracks()[0];
  if (!v) {
    stream.getTracks().forEach((t) => t.stop());
    return { kind: 'error', stage: 'capture', message: 'no video track' };
  }
  const codec = await pickCodec();
  const aligned = alignedTrack(v);
  const sent = aligned ?? v;
  sent.contentHint = contentHintOf(preset);
  const { width, height } = await settledSize(sent);
  // No size (shouldn't happen for screen capture): let livekit pick layers.
  const layers = width && height ? simulcastLayers(width, height, fps) : undefined;
  let video: LocalVideoTrack | undefined;
  try {
    video = (
      await lp.publishTrack(sent, {
        source: Track.Source.ScreenShare,
        name: 'screen',
        videoCodec: codec,
        backupCodec: codec === 'h264' ? false : { codec: 'h264' },
        screenShareEncoding: { maxBitrate: KBPS[res][fps] * 1000, maxFramerate: fps },
        screenShareSimulcastLayers: layers,
        simulcast: true,
        degradationPreference: degradationOf(preset),
      })
    ).videoTrack;
    if (!video) throw new Error('no published video track');
    const audio = a
      ? ((
          await lp.publishTrack(a, {
            source: Track.Source.ScreenShareAudio,
            name: 'screen-audio',
            audioPreset: AudioPresets.musicHighQualityStereo,
            dtx: false,
            red: false,
            forceStereo: true,
          })
        ).audioTrack ?? null)
      : null;
    v.addEventListener('ended', onEnded);
    return { kind: 'ok', share: { video, capture: v, audio, stream, codec } };
  } catch (e) {
    // stopping the capture fires no 'ended', so a published video would linger
    await lp.unpublishTrack(video ?? sent, true).catch(() => {});
    aligned?.stop();
    stream.getTracks().forEach((t) => t.stop());
    return { kind: 'error', stage: 'publish', message: messageOf(e) };
  }
}

export async function stopShare(lp: LocalParticipant, share: Share): Promise<void> {
  // unpublishTrack looks up the current publication of each track
  for (const track of [share.video, share.audio]) {
    if (track) await lp.unpublishTrack(track, true).catch(() => {});
  }
  share.stream.getTracks().forEach((t) => t.stop());
}

/** Change resolution/fps/preset while live, without picking the screen again. Throws on failure. */
export async function applyLive(share: Share, { res, fps, preset }: ShareSettings): Promise<void> {
  // On the raw capture; the aligned copy follows its new size.
  await share.capture.applyConstraints(captureConstraints(res, fps));
  const sender = share.video.sender;
  if (!sender) throw new Error('no video sender');
  // The hint goes on the sent track (the aligned copy when there is one).
  share.video.mediaStreamTrack.contentHint = contentHintOf(preset);
  const params = sender.getParameters();
  tuneEncodings(params.encodings, res, fps);
  await sender.setParameters(params);
  // After our setParameters, not alongside it: livekit applies it to every
  // sender of the track (the backup codec's too), one at a time.
  const degradation = degradationOf(preset);
  await share.video.setDegradationPreference(degradation);
  // A full reconnect republishes with these options (the publication holds the
  // same object): without this it would go back to the preference of the start.
  if (share.video.publishOptions) share.video.publishOptions.degradationPreference = degradation;
}
