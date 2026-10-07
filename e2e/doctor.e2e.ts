// The phone test page against the E2E stack: a phone test from the control
// endpoint (as `telinha doctor` gets it), the one-time link, the page's run
// through the /livekit relay, and the report the CLI would print.
//
// Needs the local control endpoint (/internal/*, token in <data>/run/control.token)
// in the server the stack runs; without it the spec skips itself.

import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createControlClient } from '../server/src/cli/control.ts';

// scripts/stack.ts --e2e: DATA_DIR=.cache/e2e-data, LISTEN=127.0.0.1:8081.
const control = createControlClient({
  paths: { run: join(import.meta.dirname, '..', '.cache', 'e2e-data', 'run') },
  envFile: join(import.meta.dirname, '..', '.cache', 'no-such.env'),
  env: { LISTEN: '127.0.0.1:8081' },
});

test('doctor link: one use, the page runs the test and reports', async ({ page, request }) => {
  test.skip(!(await control.available()), 'the server has no control endpoint to create phone tests');
  const phoneTest = await control.phoneTestLink();
  const link = new URL(phoneTest.url);

  // Nothing under /doctor without the link's cookie.
  expect((await request.get('/doctor', { maxRedirects: 0 })).status()).toBe(404);

  await page.goto(`${link.pathname}${link.search}`);
  await expect(page).toHaveURL(/\/doctor$/);
  await expect(page.locator('.footer .done')).toBeVisible({ timeout: 60_000 });

  const state = await control.phoneTestWait(phoneTest.id, 1000);
  expect(state.state).toBe('done');
  expect(state.report?.signaling.ok).toBe(true);
  expect(state.report?.publish.ok).toBe(true);

  // The link worked once.
  expect((await request.get(`${link.pathname}${link.search}`, { maxRedirects: 0 })).status()).toBe(404);
});
