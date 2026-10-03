import { expect, test } from '@playwright/test';
import { newRoom, openRoom } from './helpers.ts';

test('language picker switches the UI text', async ({ page }) => {
  await openRoom(page, newRoom());
  const share = page.getByTestId('share-button');

  await page.getByTestId('settings-button').click();
  await page.getByTestId('lang-select').selectOption('pt-BR');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(share).toContainText('Transmitir');

  await page.getByTestId('lang-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(share).not.toContainText('Transmitir');
  await expect(share).toHaveText(/\S/);
});

test('theme picker applies and survives a reload', async ({ page }) => {
  await openRoom(page, newRoom());
  await page.getByTestId('settings-button').click();
  await page.getByTestId('theme-onyx').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'onyx');
  await expect(page.getByTestId('theme-onyx')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-pressed', 'false');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'onyx');
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('theme-onyx')).toHaveAttribute('aria-pressed', 'true');
});

test('settings menu closes on Escape and outside clicks', async ({ page }) => {
  await openRoom(page, newRoom());
  const cog = page.getByTestId('settings-button');
  const menu = page.getByTestId('settings-menu');

  await cog.click();
  await expect(menu).toBeVisible();
  await expect(cog).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(cog).toBeFocused();
  await expect(cog).toHaveAttribute('aria-expanded', 'false');

  await cog.click();
  await expect(menu).toBeVisible();
  // Something inert, so the click can't also trigger whatever sits behind.
  await page.locator('header .title').click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('share-modal')).toBeHidden();
  await expect(page.getByTestId('share-button')).not.toContainText('⏹');
});

test('debug toggle shows codec support and persists', async ({ page }) => {
  await openRoom(page, newRoom());
  await page.getByTestId('settings-button').click();
  const toggle = page.getByTestId('debug-toggle');
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('codec-caps')).toHaveCount(0);

  await toggle.check();
  await expect(page.getByTestId('codec-caps')).toContainText('AV1');

  await page.reload();
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('debug-toggle')).toBeChecked();
});
