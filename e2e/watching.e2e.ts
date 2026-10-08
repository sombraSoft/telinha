import { type Browser, expect, type Locator, type Page, test } from '@playwright/test';
import { fakeDisplayMedia, goLive, newRoom, openRoom } from './helpers.ts';

/** A tab in the room whose screen picker hands out a canvas and a tone. Every tab is the same DEV_USER. */
async function tab(browser: Browser, room: string): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(fakeDisplayMedia, true);
  const page = await ctx.newPage();
  await openRoom(page, room);
  return page;
}

const ownTile = (page: Page) => page.locator('[data-testid="tile"][data-local="true"]');

/** The tile another tab's stream has on this page, by its LiveKit identity. */
async function tileOf(viewer: Page, streamer: Page): Promise<Locator> {
  const identity = await ownTile(streamer).getAttribute('data-identity');
  return viewer.locator(`[data-testid="tile"][data-identity="${identity}"]`);
}

const playing = (tile: Locator) =>
  expect
    .poll(() => tile.getByTestId('tile-video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 })
    .toBeGreaterThan(0);

test('a stream alone plays at once, the next one waits as a Watch card', async ({ browser }) => {
  const room = newRoom();
  const ana = await tab(browser, room);
  const bia = await tab(browser, room);
  const viewer = await tab(browser, room);
  try {
    await goLive(ana);
    const first = await tileOf(viewer, ana);
    await playing(first);

    // For Bia's stream the viewer already has Ana's open: a card, nothing downloaded.
    // Ana's tab has no other stream, so it plays Bia's at once.
    await goLive(bia);
    const second = await tileOf(viewer, bia);
    await expect(second.getByTestId('watch')).toBeVisible({ timeout: 20_000 });
    expect(await second.getByTestId('tile-video').evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
    const biaViewers = ownTile(bia).getByTestId('tile-viewers');
    await expect(biaViewers).toContainText('1', { timeout: 15_000 });

    await second.getByTestId('watch').click();
    await playing(second);
    await expect(second.getByTestId('watch')).toHaveCount(0);
    await expect(biaViewers).toContainText('2', { timeout: 15_000 });
  } finally {
    for (const p of [ana, bia, viewer]) await p.context().close();
  }
});

test("a person's own stream, heard from another of their tabs, starts muted and can be unmuted", async ({
  browser,
}) => {
  const room = newRoom();
  const streamer = await tab(browser, room);
  const other = await tab(browser, room);
  try {
    await goLive(streamer);
    const tile = await tileOf(other, streamer);
    await playing(tile);
    // DEV_USER: both tabs are the same person.
    const mute = tile.getByTestId('mute');
    await expect(mute).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
    await tile.hover();
    await mute.click();
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
  } finally {
    for (const p of [streamer, other]) await p.context().close();
  }
});

test('the own preview hides on request and while the window is in the background', async ({ browser }) => {
  const page = await tab(browser, newRoom());
  try {
    await goLive(page);
    const own = ownTile(page);
    const video = own.getByTestId('tile-video');
    const attached = () => video.evaluate((v: HTMLVideoElement) => v.srcObject !== null);
    await expect.poll(attached).toBe(true);

    await own.hover();
    await own.getByTestId('preview-toggle').click();
    await expect(own.getByTestId('preview-off')).toContainText('Preview hidden');
    await expect.poll(attached).toBe(false);
    // Still live, and the choice is remembered.
    await expect(page.getByTestId('share-info')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('telinha.preview'))).toBe('false');
    await own.getByTestId('preview-toggle').click();
    await expect(own.getByTestId('preview-off')).toHaveCount(0);
    await expect.poll(attached).toBe(true);

    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(own.getByTestId('preview-off')).toContainText('in the background');
    await expect.poll(attached).toBe(false);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(own.getByTestId('preview-off')).toHaveCount(0);
    await expect.poll(attached).toBe(true);
  } finally {
    await page.context().close();
  }
});
