import { expect, type Page, test } from '@playwright/test';
import { fakeDisplayMedia, newRoom, openRoom } from './helpers.ts';

/** Init script: remembers what the page asked getDisplayMedia for. */
function recordDisplayOptions() {
  const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = (options?: DisplayMediaStreamOptions) => {
    (window as unknown as { displayOptions: unknown }).displayOptions = JSON.parse(JSON.stringify(options ?? null));
    return orig(options);
  };
}

async function dockBox(page: Page) {
  const box = await page.getByTestId('share-dock').boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test('share modal: presets, Custom on manual change, Escape and backdrop close', async ({ page }) => {
  await openRoom(page, newRoom());
  const share = page.getByTestId('share-button');
  const modal = page.getByTestId('share-modal');
  const preset = page.getByTestId('share-preset');

  await share.click();
  await expect(modal).toBeVisible();
  // Defaults: Smoother video = 1080p 60 fps, with sound.
  await expect(preset).toHaveValue('smooth');
  await expect(page.getByTestId('res-1080')).toBeChecked();
  await expect(page.getByTestId('fps-60')).toBeChecked();
  await expect(page.getByTestId('share-audio')).toBeChecked();
  await expect(page.getByTestId('share-go-live')).toHaveText('Go live');

  // A manual pick that matches no preset flips it to Custom.
  await page.getByTestId('res-720').check();
  await expect(preset).toHaveValue('custom');
  await expect(page.getByTestId('fps-60')).toBeChecked();

  // A preset sets both values; arrow keys move within a radio group.
  await preset.selectOption('readable');
  await expect(page.getByTestId('res-1440')).toBeChecked();
  await expect(page.getByTestId('fps-15')).toBeChecked();
  await page.getByTestId('fps-15').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('fps-30')).toBeChecked();
  await expect(preset).toHaveValue('custom');

  // Escape closes it, focus goes back to the dock, and nothing was saved.
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(share).toBeFocused();
  await share.click();
  await expect(preset).toHaveValue('smooth');

  // A click on the backdrop (outside the card) closes it too.
  await page.mouse.click(5, 5);
  await expect(modal).toBeHidden();
  await expect(share).not.toContainText('⏹');
});

test('go live uses the modal settings, keeps them, and Quality changes them live', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakeDisplayMedia);
  await ctx.addInitScript(recordDisplayOptions);
  try {
    const page = await ctx.newPage();
    await openRoom(page, newRoom());
    const share = page.getByTestId('share-button');

    await share.click();
    await page.getByTestId('share-preset').selectOption('readable');
    await page.getByTestId('share-audio').uncheck();
    await page.getByTestId('share-go-live').click();
    await expect(page.getByTestId('share-modal')).toBeHidden();
    await expect(page.locator('[data-testid="tile"][data-local="true"]')).toBeVisible();

    // Unticked sound asks for no audio at all; the readability preset captures up to 1440p 15 fps.
    const opts = await page.evaluate(
      () => (window as unknown as { displayOptions: Record<string, unknown> }).displayOptions,
    );
    expect(opts.audio).toBe(false);
    expect(opts).not.toHaveProperty('systemAudio');
    expect(opts.video).toMatchObject({ height: { max: 1440 }, frameRate: { ideal: 15, max: 15 } });

    // Live: Stop + Quality + codec info; no "streaming without sound" tip when sound was turned off.
    await expect(share).toContainText('⏹');
    await expect(page.getByTestId('share-info')).toContainText('no sound');
    await expect(page.getByTestId('toast')).toHaveCount(0);
    // At home the dock gets its own strip below the tile, so it hides none of the tile's controls.
    const tileBox = (await page.locator('[data-testid="tile"][data-local="true"]').boundingBox())!;
    expect(tileBox.y + tileBox.height).toBeLessThanOrEqual((await dockBox(page)).y);
    // Share is now Stop: focus moved on to Quality, so a stray Enter can't end the stream.
    await expect(page.getByTestId('share-quality')).toBeFocused();

    // Keys inside the modal stay out of the page's shortcuts (F fullscreen, Escape unfocus).
    const own = page.locator('[data-testid="tile"][data-local="true"]');
    await own.locator('.hit').click();
    await expect(own).toHaveClass(/\bfocused\b/);
    await page.getByTestId('share-quality').click();
    await expect(page.getByTestId('share-modal')).toBeVisible();
    await page.keyboard.press('f');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-modal')).toBeHidden();
    await expect(page.getByTestId('share-quality')).toBeFocused();
    await expect(own).toHaveClass(/\bfocused\b/);
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();

    await page.getByTestId('share-quality').click();
    await expect(page.getByTestId('share-preset')).toHaveValue('readable');
    await expect(page.getByTestId('share-audio')).toBeDisabled();
    await expect(page.getByTestId('share-audio')).not.toBeChecked();
    await expect(page.getByTestId('share-go-live')).toHaveText('Apply');
    await page.getByTestId('res-720').check();
    await page.getByTestId('share-go-live').click();
    await expect(page.getByTestId('toast')).toContainText('720p 15 fps');

    await share.click();
    await expect(share).not.toContainText('⏹');
    await expect(page.getByTestId('share-quality')).toHaveCount(0);

    // Saved per browser: the next modal starts from the last choice.
    await page.reload();
    await expect(page.getByTestId('me')).toContainText('Dev');
    await share.click();
    await expect(page.getByTestId('share-preset')).toHaveValue('custom');
    await expect(page.getByTestId('res-720')).toBeChecked();
    await expect(page.getByTestId('fps-15')).toBeChecked();
    await expect(page.getByTestId('share-audio')).not.toBeChecked();
  } finally {
    await ctx.close();
  }
});

test('the dock drags inside the stage, persists, and double-click sends it home', async ({ page }) => {
  await openRoom(page, newRoom());
  const grip = page.getByTestId('dock-grip');
  await expect(grip).toHaveAttribute('title', /double-click/);
  const home = await dockBox(page);
  const stage = (await page.locator('.stage').boundingBox())!;
  // Home: bottom, centred on the window even with the people list open beside the stage.
  expect(Math.abs(home.x + home.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2);

  // Dragged far past the top-left corner: clamped inside the stage.
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(2, 2, { steps: 5 });
  await page.mouse.up();
  const moved = await dockBox(page);
  expect(moved.x).toBeGreaterThanOrEqual(stage.x);
  expect(moved.y).toBeGreaterThanOrEqual(stage.y);
  expect(moved.y).toBeLessThan(home.y - 100);

  // Remembered across a reload.
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Dev');
  await expect.poll(async () => Math.round((await dockBox(page)).y)).toBe(Math.round(moved.y));

  // Double-click on the grip: back home.
  await grip.dblclick();
  await expect.poll(async () => Math.round((await dockBox(page)).y)).toBe(Math.round(home.y));
  await expect.poll(async () => Math.round((await dockBox(page)).x)).toBe(Math.round(home.x));

  // Released within the snap radius of home: snaps exactly there.
  const g2 = (await grip.boundingBox())!;
  await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await page.mouse.down();
  await page.mouse.move(g2.x + g2.width / 2 + 60, g2.y - 60, { steps: 3 });
  await page.mouse.move(g2.x + g2.width / 2 + 10, g2.y + g2.height / 2 - 10, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await dockBox(page)).x)).toBe(Math.round(home.x));
  expect(await page.evaluate(() => localStorage.getItem('telinha.dock'))).toBe('null');
});
