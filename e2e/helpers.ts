// Shared E2E helpers. Not a *.e2e.ts file, so neither Playwright nor bun test
// runs it on its own.
import { expect, type Page } from '@playwright/test';

/** A fresh, valid room per test so runs never see each other's participants. */
export function newRoom(prefix = 'e2e'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Opens a room and waits until the DEV_USER login round-trip is done. In dev
 * mode the server opens an unknown valid room on first use (there is no /tela).
 */
export async function openRoom(page: Page, room: string): Promise<string> {
  await page.goto(`/sala/?room=${room}`);
  await expect(page.getByTestId('me')).toContainText('Dev');
  const current = new URL(page.url()).searchParams.get('room');
  expect(current).toBe(room);
  return current!;
}

/**
 * Init script: getDisplayMedia returns an animated 1280x720 canvas at 30 fps
 * (video only). Canvas tracks report no capture settings and may reject
 * applyConstraints, so the track is patched to look like a screen capture.
 */
export function fakeDisplayMedia() {
  const W = 1280;
  const H = 720;
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    let n = 0;
    // A timer, not requestAnimationFrame: rAF stalls when the page is not
    // the foreground one, and the frame counter must keep moving.
    setInterval(() => {
      n++;
      ctx.fillStyle = `hsl(${(n * 7) % 360} 70% 40%)`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.fillRect((n * 16) % W, (n * 9) % H, 160, 90);
      ctx.font = '64px sans-serif';
      ctx.fillText(String(n), 40, 100);
    }, 1000 / 30);
    const stream = canvas.captureStream(30);
    const track = stream.getVideoTracks()[0]!;
    const settings = { width: W, height: H, frameRate: 30, displaySurface: 'monitor', deviceId: 'e2e-canvas' };
    track.getSettings = () => ({ ...settings }) as MediaTrackSettings;
    track.getCapabilities = () => ({ width: { min: 1, max: W }, height: { min: 1, max: H }, frameRate: { min: 1, max: 30 } }) as MediaTrackCapabilities;
    track.applyConstraints = async () => {};
    Object.defineProperty(track, 'label', { value: 'e2e-canvas', configurable: true });
    return stream;
  };
}
