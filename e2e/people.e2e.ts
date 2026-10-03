import { expect, test, type Page } from '@playwright/test';
import { newRoom, openRoom } from './helpers.ts';

async function centreX(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box).not.toBeNull();
  return box!.x + box!.width / 2;
}

test('people list collapses from the header and the edge handle, and remembers it', async ({ page }) => {
  await openRoom(page, newRoom());
  const toggle = page.getByTestId('people-toggle');
  const handle = page.getByTestId('people-handle');
  const list = page.getByTestId('people-list');
  const stage = page.locator('.stage');
  const width = page.viewportSize()!.width;

  // Desktop default: open beside the stage.
  await expect(list).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-controls', 'people-panel');
  await expect(page.locator('#people-panel')).toHaveCount(1);
  expect((await stage.boundingBox())!.width).toBeLessThan(width - 200);

  // Header: collapse. The stage takes the full width; the handle stays on its edge.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
  await expect.poll(async () => Math.round((await stage.boundingBox())!.width)).toBe(width);
  await expect(handle).toBeVisible();
  const h = (await handle.boundingBox())!;
  expect(h.x + h.width).toBeLessThanOrEqual(width + 0.5);
  expect(h.x).toBeGreaterThan(width - 40);

  // Remembered across a reload.
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Dev');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();

  // Edge handle: open again, also remembered.
  await handle.click();
  await expect(list).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Dev');
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('telinha.people'))).toBe('true');
});

test('people list starts collapsed on phones, and an explicit choice wins at any width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openRoom(page, newRoom());
  const toggle = page.getByTestId('people-toggle');
  const list = page.getByTestId('people-list');

  // Nothing saved: phones start folded.
  expect(await page.evaluate(() => localStorage.getItem('telinha.people'))).toBeNull();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();

  // Opened on the phone, it stays open there and on a desktop width.
  await page.getByTestId('people-handle').click();
  await expect(list).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Closed on the desktop, it stays closed back on the phone.
  await toggle.click();
  await page.setViewportSize({ width: 360, height: 740 });
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Dev');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
});

test('the edge handle works from the keyboard and keeps focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openRoom(page, newRoom());
  const handle = page.getByTestId('people-handle');

  await handle.focus();
  await page.keyboard.press('Enter');
  await expect(handle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('people-list')).toBeHidden();
  await expect(handle).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(handle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('people-list')).toBeVisible();
  await expect(handle).toBeFocused();
});

test('dock home and the empty state sit on the window centre, list open or not', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openRoom(page, newRoom());
  const mid = 640;
  await expect(page.getByTestId('people-list')).toBeVisible();
  await expect(page.getByTestId('empty-state')).toBeVisible();

  // The stage is off-centre (the list is on its right), yet both line up with the window.
  const stage = (await page.locator('.stage').boundingBox())!;
  expect(Math.abs(stage.x + stage.width / 2 - mid)).toBeGreaterThan(100);
  expect(Math.abs((await centreX(page, 'share-dock')) - mid)).toBeLessThan(2);
  expect(Math.abs((await centreX(page, 'empty-state')) - mid)).toBeLessThan(2);

  await page.getByTestId('people-toggle').click();
  await expect.poll(async () => Math.round((await page.locator('.stage').boundingBox())!.width)).toBe(1280);
  expect(Math.abs((await centreX(page, 'share-dock')) - mid)).toBeLessThan(2);
  expect(Math.abs((await centreX(page, 'empty-state')) - mid)).toBeLessThan(2);

  // Too narrow to reach the window centre: shifted only as far as the stage allows.
  await page.getByTestId('people-toggle').click();
  await page.setViewportSize({ width: 740, height: 700 });
  await expect.poll(async () => Math.round((await page.locator('.stage').boundingBox())!.width)).toBe(480);
  const dock = (await page.getByTestId('share-dock').boundingBox())!;
  // 1px slack: the dock's measured width is rounded (bind:clientWidth).
  expect(dock.x + dock.width).toBeLessThanOrEqual(480 - 16 + 1);
  expect(dock.x + dock.width).toBeGreaterThan(480 - 16 - 2);
  const empty = (await page.getByTestId('empty-state').boundingBox())!;
  expect(empty.x + empty.width).toBeLessThanOrEqual(480 - 16 + 1);
});
