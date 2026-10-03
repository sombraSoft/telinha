import { expect, test } from '@playwright/test';
import { newRoom, openRoom } from './helpers.ts';

test('/sala/ without a room: a notice, no token request', async ({ browser }) => {
  for (const [locale, text] of [
    ['en-US', 'Open a Telinha with /tela on Discord.'],
    ['pt-BR', 'Abra uma telinha com /tela no Discord.'],
  ] as const) {
    const ctx = await browser.newContext({ locale });
    try {
      const page = await ctx.newPage();
      const tokens: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/auth/token')) tokens.push(r.url());
      });
      await page.goto('/sala/');
      await expect(page.getByTestId('notice')).toHaveText(text);
      await expect(page.getByTestId('fatal').getByRole('button')).toHaveCount(0);
      expect(tokens).toEqual([]);
    } finally {
      await ctx.close();
    }
  }
});

// The e2e stack runs with CLOSE_EMPTY_SECONDS=4 and POLL_SECONDS=1.
test('a room closes for good once it sat empty', async ({ browser }) => {
  const room = newRoom();
  const first = await browser.newContext();
  const page = await first.newPage();
  await openRoom(page, room);
  await expect(page.getByTestId('empty-state')).toBeVisible();
  // Navigating away fires pagehide, so the page leaves the room right away
  // instead of LiveKit timing the connection out.
  await page.goto('about:blank');
  await first.close();

  const ctx = await browser.newContext({ locale: 'en-US' });
  try {
    const later = await ctx.newPage();
    await later.goto('/auth/login?next=%2Fsala%2F'); // dev login: session cookie for ctx.request
    await expect(later.getByTestId('notice')).toBeVisible();
    // Poll the token endpoint, not the page: a page that joins counts as
    // someone in the room. A token fetch also keeps an open room alive for
    // CLOSE_EMPTY_SECONDS, so poll more slowly than that.
    await expect
      .poll(async () => (await ctx.request.get(`/auth/token?room=${room}`)).status(), { intervals: [6_000], timeout: 60_000 })
      .toBe(410);

    await later.goto(`/sala/?room=${room}`);
    await expect(later.getByTestId('notice')).toHaveText('This Telinha has ended. Open another with /tela on Discord.');
    await expect(later.getByTestId('me')).toHaveCount(0);
    await expect(later.getByTestId('fatal').getByRole('button')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
