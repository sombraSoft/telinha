import { expect, test } from '@playwright/test';
import { newRoom, openRoom } from './helpers.ts';

test('language picker switches the UI text', async ({ page }) => {
  await openRoom(page, newRoom());
  const share = page.getByTestId('share-button');

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
  await page.getByTestId('theme-select').selectOption('onyx');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'onyx');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'onyx');
  await expect(page.getByTestId('theme-select')).toHaveValue('onyx');
});
