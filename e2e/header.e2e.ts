import { expect, type Page, test } from '@playwright/test';
import { newRoom, openRoom } from './helpers.ts';

/** Answers /auth/token as Telinha would, with this topic and Discord server name (dev rooms have neither). */
async function named(page: Page, topic: string | null, server: string | null) {
  await page.route(
    (url) => url.pathname === '/auth/token',
    async (route) => {
      const r = await route.fetch();
      await route.fulfill({ response: r, json: { ...(await r.json()), topic, server } });
    },
  );
}

test('without topic or server name the page is just Telinha', async ({ page }) => {
  await openRoom(page, newRoom());
  await expect(page).toHaveTitle('Telinha');
  await expect(page.getByTestId('room-label')).toHaveCount(0);
});

test('named after the topic, else the Discord server, in the tab and the header', async ({ page }) => {
  await named(page, 'Filme de sexta', 'Gurizada');
  await openRoom(page, newRoom());
  await expect(page).toHaveTitle('Telinha - Filme de sexta');
  await expect(page.getByTestId('room-label')).toHaveText('Filme de sexta');

  await page.unrouteAll();
  await named(page, null, 'Gurizada');
  await page.reload();
  await expect(page).toHaveTitle('Telinha - Gurizada');
  await expect(page.getByTestId('room-label')).toHaveText('Gurizada');
});

test('a long name is cut short in the header and leaves the side groups whole', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await named(page, 'x'.repeat(80), null);
  await openRoom(page, newRoom());
  const label = page.getByTestId('room-label');
  await expect(label).toBeVisible();
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(page.getByTestId('copy-link')).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('me')).toBeInViewport({ ratio: 1 });
});

test('the settings menu shows the running version and links to GitHub', async ({ page, request }) => {
  const { version } = (await (await request.get('/healthz')).json()) as { version: string };
  await openRoom(page, newRoom());
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('app-version')).toHaveText(`Version ${version}`);
  const link = page.getByTestId('repo-link');
  await expect(link).toHaveAttribute('href', 'https://github.com/sombraSoft/telinha');
  await expect(link).toHaveAttribute('target', '_blank');
});
