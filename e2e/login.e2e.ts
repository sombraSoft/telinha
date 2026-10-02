import { expect, test } from '@playwright/test';
import { openRoom } from './helpers.ts';

test('no cookie: token 401 -> dev login -> back in a generated room', async ({ page }) => {
  const token401 = page.waitForResponse((r) => r.url().includes('/auth/token') && r.status() === 401);
  const login = page.waitForRequest((r) => new URL(r.url()).pathname === '/auth/login');
  const room = await openRoom(page);
  await token401;
  // The login carries the page (with its freshly generated room) as next.
  const next = new URL((await login).url()).searchParams.get('next');
  expect(next).toBe(`/sala/?room=${room}`);
  await expect(page).toHaveURL(new RegExp(`/sala/\\?room=${room}$`));
  await expect(page.getByTestId('empty-state')).toBeVisible();
});
