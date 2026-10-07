import { expect, test } from '@playwright/test';

test('/ lands on /r/', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/r\/$/);
  await expect(page.getByTestId('notice')).toBeVisible();
});

test('only room codes get the page: old ids and /sala are 404', async ({ page }) => {
  await page.goto('/r/'); // dev login
  for (const p of ['/r/q3Jx_9aZ-kP2w', '/r/abcd', '/sala/?room=bafo-kiru']) {
    expect([p, (await page.request.get(p, { maxRedirects: 0 })).status()]).toEqual([p, 404]);
  }
});

// The `request` fixture carries no cookies: the signaling proxy is behind the gate.
test('/livekit without a session: 401, no redirect', async ({ request }) => {
  const res = await request.get('/livekit/rtc/validate', { maxRedirects: 0 });
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: 'login' });
});

test('/livekit proxies only signaling, even with a session', async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL });
  try {
    expect((await ctx.get('/auth/login?next=%2Fr%2F')).ok()).toBe(true); // dev login sets the cookie
    const res = await ctx.post('/livekit/twirp/livekit.RoomService/ListRooms', { data: {} });
    expect(res.status()).toBe(404);
  } finally {
    await ctx.dispose();
  }
});
