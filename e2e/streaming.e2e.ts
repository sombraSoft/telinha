import { expect, test } from '@playwright/test';
import { RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { fakeDisplayMedia, newRoom, openRoom } from './helpers.ts';

test('screen share reaches a second tab at 720p and >= 20 fps', async ({ browser }) => {
  const room = newRoom();
  const pubCtx = await browser.newContext();
  await pubCtx.addInitScript(fakeDisplayMedia);
  // Big viewport at 2x so adaptiveStream asks for the top simulcast layer.
  const subCtx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  try {
    const pub = await pubCtx.newPage();
    await openRoom(pub, room);
    await pub.getByTestId('share-button').click();
    await expect(pub.locator('[data-testid="tile"][data-local="true"]')).toBeVisible();

    const sub = await subCtx.newPage();
    await openRoom(sub, room);
    const tile = sub.locator('[data-testid="tile"][data-local="false"]');
    await expect(tile).toHaveCount(1, { timeout: 20_000 });
    await tile.click();
    const video = tile.getByTestId('tile-video');

    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => `${v.videoWidth}x${v.videoHeight}`), { timeout: 30_000 })
      .toBe('1280x720');

    // Frames actually presented by the subscriber's <video> over ~3 s.
    const fps = await video.evaluate(
      (v: HTMLVideoElement) =>
        new Promise<number>((resolve) => {
          let first: number | null = null;
          let frames = 0;
          const tick = (now: number) => {
            if (first === null) first = now;
            else frames++;
            const elapsed = (now - first) / 1000;
            if (elapsed >= 3) resolve(frames / elapsed);
            else v.requestVideoFrameCallback(tick);
          };
          v.requestVideoFrameCallback(tick);
        }),
    );
    // Logged so CI runs show how much headroom the threshold has.
    console.log(`subscriber presented ${fps.toFixed(1)} fps at 1280x720`);
    expect(fps).toBeGreaterThanOrEqual(20);
    await expect(tile.getByTestId('tile-quality')).toContainText('720p');

    await sub.getByTestId('stats-toggle').click();
    // No GPU in CI: software H264 (or VP8). Locally AV1/H265 may win the pick.
    const codecs = process.env.CI ? /H264|VP8/i : /H264|VP8|VP9|H265|AV1/i;
    await expect(tile).toContainText(codecs, { timeout: 15_000 });
    console.log(`subscriber codec: ${(await tile.innerText()).match(codecs)?.[0]}`);

    // The subscriber's focused tile is announced back to the publisher.
    const own = pub.locator('[data-testid="tile"][data-local="true"]');
    await expect(own.getByTestId('tile-viewers')).toContainText('1', { timeout: 15_000 });

    // The streamer reports its quality for the /tela card (read by the server's poller).
    const lk = new RoomServiceClient('http://127.0.0.1:7880', 'devkey', 'secret');
    await expect
      .poll(async () => {
        const ps = await lk.listParticipants(room);
        return ps.find((p) => p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE))?.attributes.stream ?? '';
      }, { timeout: 15_000 })
      .toMatch(/^720p\d+ · [A-Z0-9]+$/);
  } finally {
    await pubCtx.close();
    await subCtx.close();
  }
});
