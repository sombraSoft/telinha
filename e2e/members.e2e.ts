import { expect, test } from '@playwright/test';
import { newRoom, openRoom } from './helpers.ts';

// Against the DEV_USER preview list (members.ts devMembers): the dev user and
// Ana online, Bruno idle, Carla do-not-disturb, four offline.
test('Online and Offline sections from the member list; whoever is in the room is left out', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openRoom(page, newRoom());

  const online = page.getByTestId('online-list');
  await expect(online.getByTestId('member-item')).toHaveText(['Ana, Online', 'Bruno, Idle', 'Carla, Do not disturb']);
  await expect(page.getByRole('heading', { name: 'Online — 3' })).toBeVisible();
  // The dev user is in the room: listed there only.
  await expect(page.getByTestId('people-list')).toContainText('Dev');
  await expect(online).not.toContainText('Dev');

  const toggle = page.getByTestId('offline-toggle');
  const offline = page.getByTestId('offline-list');
  await expect(toggle).toHaveText(/Offline — 4/);
  // Collapsed by default.
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-controls', 'offline-list');
  await expect(offline).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(offline.getByTestId('member-item')).toHaveText(['Diego, Offline', 'Elis, Offline', 'Fábio, Offline', 'Gabi, Offline']);

  // The open section is remembered.
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Dev');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(offline).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('telinha.offline'))).toBe('true');

  await toggle.click();
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Dev');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(offline).toBeHidden();
});

test('member list in pt-BR', async ({ page }) => {
  await openRoom(page, newRoom());
  await page.getByTestId('settings-button').click();
  await page.getByTestId('lang-select').selectOption('pt-BR');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('online-list').getByTestId('member-item'))
    .toHaveText(['Ana, Online', 'Bruno, Ausente', 'Carla, Não perturbe']);
  await expect(page.getByTestId('offline-toggle')).toHaveText(/Offline — 4/);
});

test('an empty section is left out; a long name never scrolls the sidebar sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // 32 characters, Discord's longest display name; nobody offline.
  const long = 'Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww';
  await page.route('/auth/members', (r) => r.fulfill({
    json: { members: [{ id: '1', name: 'Dev', avatar: null, status: 'online' }, { id: '2', name: long, avatar: null, status: 'online' }] },
  }));
  await openRoom(page, newRoom());

  await expect(page.getByTestId('online-list').getByTestId('member-item')).toHaveText([`${long}, Online`]);
  await expect(page.getByTestId('offline-toggle')).toHaveCount(0);
  await expect(page.getByTestId('offline-list')).toHaveCount(0);
  const side = page.locator('#people-panel');
  expect(await side.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

  // Only ourselves left: no Online section either.
  await page.unroute('/auth/members');
  await page.route('/auth/members', (r) => r.fulfill({ json: { members: [{ id: '1', name: 'Dev', avatar: null, status: 'online' }] } }));
  await page.reload();
  await expect(page.getByTestId('me')).toContainText('Dev');
  await expect(page.getByTestId('people-list')).toContainText('Dev');
  await expect(page.getByTestId('online-list')).toHaveCount(0);
  await expect(page.getByTestId('offline-toggle')).toHaveCount(0);
});
