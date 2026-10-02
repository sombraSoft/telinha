// Pure helpers for the login gate: signed session cookies, safe redirect
// targets and cookie parsing. No I/O here so it can be unit tested.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION = 'telinha';
export const STATE = 'telinha_state';

export interface Session {
  id: string;
  name: string;
  avatar: string | null;
  /** Discord user locale (e.g. "pt-BR", "en-US"); absent on 0.1.1 sessions. */
  locale?: string;
  exp: number;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const mac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

// value = base64url(json).hmac ; payload must contain exp (ms epoch)
export function sign(secret: string, payload: object): string {
  const data = b64(JSON.stringify(payload));
  return `${data}.${mac(secret, data)}`;
}

export function verify<T extends { exp: number } = Session>(
  secret: string, value: unknown, now = Date.now(),
): T | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const data = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(mac(secret, data));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number' || exp <= now) return null;
  return payload as T;
}

export function parseCookies(header: string | null | undefined = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (Object.hasOwn(out, k)) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed escape: ignore that cookie rather than fail the request
    }
  }
  return out;
}

// Only same-site relative paths, never //host or /\host (open redirect).
// Browsers drop tab/CR/LF before parsing, so "/<TAB>/evil.com" means
// //evil.com: reject control characters, then check what a URL parser makes of it.
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';
  let url: URL;
  try {
    url = new URL(next, 'http://x');
  } catch {
    return '/';
  }
  if (url.origin !== 'http://x' || url.pathname.startsWith('/auth/')) return '/';
  return next;
}

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  /** Default true; only plain-http dev URLs turn it off. */
  secure?: boolean;
}

export function cookie(name: string, value: string, { maxAge, path = '/', secure = true }: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly'];
  if (secure) parts.push('Secure');
  parts.push('SameSite=Lax');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}
