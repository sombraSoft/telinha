// The phone test in the running service: the CLI asks for a link (control
// endpoint), shows that one-time link as a QR code, the phone opens it, gets a
// short-lived cookie scoped to /doctor, runs the media test and posts a report
// the CLI is long-polling for. Everything is in memory: a restart forgets them.
import { createHmac, randomBytes } from 'node:crypto';
import { sign, verify } from '../auth.ts';
import type { DoctorReport, PhoneTestPoll } from '../cli/control.ts';

export type { DoctorReport, PhoneTestPoll };

export const DOCTOR_COOKIE = 'telinha_doctor';
/** An unopened link dies after this. */
export const SESSION_TTL_MS = 10 * 60_000;
/** The page's cookie, and how long an opened link stays alive. */
export const COOKIE_TTL_MS = 15 * 60_000;
export const MAX_SESSIONS = 5;

const ID_RE = /^[0-9a-f]{32}$/;

interface Entry {
  id: string;
  /** Deleted on claim: the link works once. */
  token: string | null;
  createdAt: number;
  expiresAt: number;
  openedAt?: number;
  report?: DoctorReport;
  /** The LiveKit token was handed out (one per link). */
  granted: boolean;
  waiters: Set<() => void>;
}

export interface DoctorStore {
  /** id 16 random bytes hex, token 32 bytes base64url; the oldest link goes when MAX_SESSIONS are live. */
  create(now?: number): { id: string; token: string; expiresAt: number };
  /** One-time: the token is gone after the first use. */
  claim(token: string, now?: number): { id: string } | null;
  /** Value for the telinha_doctor cookie. */
  cookieFor(id: string, now?: number): string;
  verifyCookie(value: unknown, now?: number): { id: string } | null;
  /** false when the link is gone or already has a report. */
  report(id: string, report: DoctorReport, now?: number): boolean;
  /** The media token may be handed out once per link: true the first time. */
  takeGrant(id: string): boolean;
  /** Gives the grant back (the room could not be created). */
  returnGrant(id: string): void;
  state(id: string, now?: number): PhoneTestPoll;
  /** Resolves on report or expiry, else after maxMs (long-poll). */
  wait(id: string, maxMs: number): Promise<PhoneTestPoll>;
  gc(now?: number): void;
}

// Separate key for the doctor cookie: a session cookie never verifies as a
// doctor cookie (and the other way round), whatever their payloads look like.
export const deriveDoctorKey = (cookieSecret: string): string =>
  createHmac('sha256', cookieSecret).update('telinha-doctor').digest('hex');

export function createDoctorStore(o: {
  cookieSecret: string;
  now?: () => number;
  random?: (n: number) => Uint8Array;
}): DoctorStore {
  const clock = o.now ?? Date.now;
  const random = o.random ?? ((n: number) => randomBytes(n));
  const doctorKey = deriveDoctorKey(o.cookieSecret);
  const sessions = new Map<string, Entry>();
  const byToken = new Map<string, string>();

  const live = (e: Entry | undefined, now: number): e is Entry => !!e && e.expiresAt > now;

  const wake = (e: Entry) => {
    for (const w of e.waiters) w();
    e.waiters.clear();
  };

  const drop = (e: Entry) => {
    sessions.delete(e.id);
    if (e.token) byToken.delete(e.token);
    wake(e);
  };

  const store: DoctorStore = {
    create(now = clock()) {
      store.gc(now);
      // Map order is insertion order: the first one is the oldest.
      while (sessions.size >= MAX_SESSIONS) drop(sessions.values().next().value!);
      const id = Buffer.from(random(16)).toString('hex');
      const token = Buffer.from(random(32)).toString('base64url');
      const e: Entry = {
        id,
        token,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        granted: false,
        waiters: new Set(),
      };
      sessions.set(id, e);
      byToken.set(token, id);
      return { id, token, expiresAt: e.expiresAt };
    },

    claim(token, now = clock()) {
      if (typeof token !== 'string' || !token) return null;
      const id = byToken.get(token);
      if (!id) return null;
      byToken.delete(token);
      const e = sessions.get(id);
      if (!live(e, now)) return null;
      e.token = null;
      e.openedAt = now;
      // Opened just before the link expired: the test still gets the cookie's lifetime.
      e.expiresAt = Math.max(e.expiresAt, now + COOKIE_TTL_MS);
      wake(e);
      return { id };
    },

    cookieFor(id, now = clock()) {
      return sign(doctorKey, { typ: 'doctor', d: id, exp: now + COOKIE_TTL_MS });
    },

    verifyCookie(value, now = clock()) {
      const p = verify<{ typ?: unknown; d?: unknown; exp: number }>(doctorKey, value, now);
      // typ and the strict id shape keep any other signed payload out, even under the same key.
      if (!p || p.typ !== 'doctor' || typeof p.d !== 'string' || !ID_RE.test(p.d)) return null;
      return live(sessions.get(p.d), now) ? { id: p.d } : null;
    },

    report(id, report, now = clock()) {
      const e = sessions.get(id);
      if (!live(e, now) || e.report) return false;
      e.report = report;
      wake(e);
      return true;
    },

    takeGrant(id) {
      const e = sessions.get(id);
      if (!live(e, clock()) || e.granted) return false;
      e.granted = true;
      return true;
    },

    returnGrant(id) {
      const e = sessions.get(id);
      if (e) e.granted = false;
    },

    state(id, now = clock()) {
      const e = sessions.get(id);
      if (e?.report)
        return { state: 'done', ...(e.openedAt !== undefined ? { openedAt: e.openedAt } : {}), report: e.report };
      if (!live(e, now)) return { state: 'expired' };
      return e.openedAt !== undefined ? { state: 'opened', openedAt: e.openedAt } : { state: 'pending' };
    },

    async wait(id, maxMs) {
      const first = store.state(id);
      if (first.state === 'done' || first.state === 'expired') return first;
      const e = sessions.get(id)!;
      // Woken early when the phone opens the link, reports, or the link goes.
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          e.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, Math.min(maxMs, e.expiresAt - clock())));
        e.waiters.add(done);
      });
      return store.state(id);
    },

    gc(now = clock()) {
      for (const e of [...sessions.values()]) {
        // A finished test stays until its expiry so a late wait() still gets the report.
        if (e.expiresAt <= now) drop(e);
      }
    },
  };
  return store;
}
