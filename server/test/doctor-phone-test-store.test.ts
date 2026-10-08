import { describe, expect, test } from 'bun:test';
import { sign, verify } from '../src/auth.ts';
import {
  COOKIE_TTL_MS,
  createPhoneTestStore,
  type DoctorReport,
  deriveDoctorKey,
  MAX_PHONE_TESTS,
  PHONE_TEST_TTL_MS,
} from '../src/doctor/phone-test-store.ts';

const NOW = 1_700_000_000_000;
const SECRET = 'cookie-secret';

const REPORT: DoctorReport = {
  https: { ok: true, latencyMs: 80 },
  signaling: { ok: true },
  initial: { protocol: 'udp', candidateIp: '203.0.113.7', rttMs: 40 },
  tcp: { ok: true, rttMs: 60 },
  udp: { ok: true, rttMs: 40 },
  publish: { ok: true },
  client: { ua: 'phone' },
  startedAt: NOW,
  finishedAt: NOW + 20_000,
};

function make() {
  let now = NOW;
  let n = 0;
  // Distinct, predictable bytes per call.
  const random = (len: number) => new Uint8Array(len).fill(0xa0 + ++n);
  const store = createPhoneTestStore({ cookieSecret: SECRET, now: () => now, random });
  return { store, tick: (ms: number) => (now += ms), at: () => now };
}

describe('phone test store', () => {
  test('create: hex id, base64url token, 10 minute expiry, pending', () => {
    const { store } = make();
    const s = store.create();
    expect(s.id).toMatch(/^[0-9a-f]{32}$/);
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.expiresAt).toBe(NOW + PHONE_TEST_TTL_MS);
    expect(store.state(s.id)).toEqual({ state: 'pending' });
  });

  test('a token works once', () => {
    const { store } = make();
    const s = store.create();
    expect(store.claim(s.token)).toEqual({ id: s.id });
    expect(store.claim(s.token)).toBeNull();
    expect(store.claim('nope')).toBeNull();
    expect(store.state(s.id)).toEqual({ state: 'opened', openedAt: NOW });
  });

  test('an unopened link expires after 10 minutes', () => {
    const { store, tick } = make();
    const s = store.create();
    tick(PHONE_TEST_TTL_MS);
    expect(store.claim(s.token)).toBeNull();
    expect(store.state(s.id)).toEqual({ state: 'expired' });
  });

  test('opening extends the phone test to the cookie lifetime', () => {
    const { store, tick } = make();
    const s = store.create();
    tick(PHONE_TEST_TTL_MS - 1000);
    expect(store.claim(s.token)).not.toBeNull();
    const cookie = store.cookieFor(s.id);
    tick(COOKIE_TTL_MS - 1000);
    expect(store.verifyCookie(cookie)).toEqual({ id: s.id });
    tick(1000);
    expect(store.verifyCookie(cookie)).toBeNull();
  });

  test('cookie: verifies for a live phone test only', () => {
    const { store } = make();
    const s = store.create();
    store.claim(s.token);
    const value = store.cookieFor(s.id);
    expect(store.verifyCookie(value)).toEqual({ id: s.id });
    expect(store.verifyCookie(`${value}x`)).toBeNull();
    expect(store.verifyCookie(undefined)).toBeNull();
    store.gc(NOW + COOKIE_TTL_MS + 1);
    expect(store.verifyCookie(value, NOW)).toBeNull();
  });

  test('a session-cookie-shaped payload signed with cookieSecret is not a doctor cookie', () => {
    const { store } = make();
    const s = store.create();
    store.claim(s.token);
    // Same fields a doctor cookie has, but the session cookie's key.
    expect(store.verifyCookie(sign(SECRET, { typ: 'doctor', d: s.id, exp: NOW + 60_000 }))).toBeNull();
    expect(store.verifyCookie(sign(SECRET, { id: '1', name: 'Zé', avatar: null, exp: NOW + 60_000 }))).toBeNull();
  });

  test('a doctor cookie does not verify with cookieSecret', () => {
    const { store } = make();
    const s = store.create();
    store.claim(s.token);
    expect(verify(SECRET, store.cookieFor(s.id), NOW)).toBeNull();
  });

  test('typ and the id shape are checked even under the doctor key', () => {
    const { store } = make();
    const s = store.create();
    store.claim(s.token);
    const key = deriveDoctorKey(SECRET);
    expect(key).not.toBe(SECRET);
    expect(store.verifyCookie(sign(key, { typ: 'doctor', d: s.id, exp: NOW + 60_000 }))).toEqual({ id: s.id });
    expect(store.verifyCookie(sign(key, { typ: 'session', d: s.id, exp: NOW + 60_000 }))).toBeNull();
    expect(store.verifyCookie(sign(key, { d: s.id, exp: NOW + 60_000 }))).toBeNull();
    expect(store.verifyCookie(sign(key, { typ: 'doctor', d: s.id.toUpperCase(), exp: NOW + 60_000 }))).toBeNull();
    expect(store.verifyCookie(sign(key, { typ: 'doctor', d: 'a'.repeat(32), exp: NOW + 60_000 }))).toBeNull();
  });

  test('report once; state carries it', () => {
    const { store } = make();
    const s = store.create();
    store.claim(s.token);
    expect(store.report(s.id, REPORT)).toBe(true);
    expect(store.report(s.id, REPORT)).toBe(false);
    expect(store.report('f'.repeat(32), REPORT)).toBe(false);
    expect(store.state(s.id)).toEqual({ state: 'done', openedAt: NOW, report: REPORT });
  });

  test('the media grant is handed out once, and can be given back', () => {
    const { store } = make();
    const s = store.create();
    expect(store.takeGrant(s.id)).toBe(true);
    expect(store.takeGrant(s.id)).toBe(false);
    store.returnGrant(s.id);
    expect(store.takeGrant(s.id)).toBe(true);
    expect(store.takeGrant('0'.repeat(32))).toBe(false);
  });

  test('at most 5 live phone tests: the oldest goes', () => {
    const { store } = make();
    const all = Array.from({ length: MAX_PHONE_TESTS + 1 }, () => store.create());
    expect(store.state(all[0]!.id)).toEqual({ state: 'expired' });
    expect(store.claim(all[0]!.token)).toBeNull();
    for (const s of all.slice(1)) expect(store.state(s.id)).toEqual({ state: 'pending' });
  });

  test('wait resolves early on report', async () => {
    const { store } = make();
    const s = store.create();
    store.claim(s.token);
    const started = performance.now();
    const p = store.wait(s.id, 5000);
    setTimeout(() => store.report(s.id, REPORT), 10);
    expect((await p).state).toBe('done');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('wait resolves early when the phone opens the link', async () => {
    const { store } = make();
    const s = store.create();
    const p = store.wait(s.id, 5000);
    setTimeout(() => store.claim(s.token), 10);
    expect((await p).state).toBe('opened');
  });

  test('wait: immediate for done/unknown, times out to the current state', async () => {
    const { store } = make();
    expect(await store.wait('0'.repeat(32), 5000)).toEqual({ state: 'expired' });
    const s = store.create();
    expect(await store.wait(s.id, 20)).toEqual({ state: 'pending' });
  });

  test('gc drops expired phone tests and wakes their waiters', async () => {
    const { store, tick } = make();
    const s = store.create();
    const p = store.wait(s.id, 5000);
    tick(PHONE_TEST_TTL_MS);
    store.gc();
    expect(await p).toEqual({ state: 'expired' });
    expect(store.takeGrant(s.id)).toBe(false);
  });
});
