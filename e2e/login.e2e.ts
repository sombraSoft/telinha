import { expect, test } from '@playwright/test';
import { newRoom, openRoom } from './helpers.ts';

test('no cookie: the gate sends the room to the dev login and back', async ({ page }) => {
  const login = page.waitForRequest((r) => new URL(r.url()).pathname === '/auth/login');
  const room = await openRoom(page, newRoom());
  // The server's gate redirected the room page itself, carrying it as next.
  const req = await login;
  expect(new URL(req.redirectedFrom()?.url() ?? '').pathname).toBe(`/r/${room}`);
  expect(new URL(req.url()).searchParams.get('next')).toBe(`/r/${room}`);
  await expect(page).toHaveURL(new RegExp(`/r/${room}$`));
  await expect(page.getByTestId('empty-state')).toBeVisible();
});
