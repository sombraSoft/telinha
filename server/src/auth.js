// Pure helpers for Telinha's login gate: signed session cookies, safe
// redirect targets and cookie parsing. No I/O here so it can be unit tested.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = (s) => Buffer.from(s).toString('base64url');
const mac = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

// value = base64url(json).hmac ; payload must contain exp (ms epoch)
export function sign(secret, payload) {
  const data = b64(JSON.stringify(payload));
  return `${data}.${mac(secret, data)}`;
}

export function verify(secret, value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const data = value.slice(0, dot);
  const got = Buffer.from(value.slice(dot + 1));
  const want = Buffer.from(mac(secret, data));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, 'base64url').toString());
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Only same-site relative paths, never //host or /\host (open redirect).
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/';
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next.startsWith('/auth/')) return '/';
  return next;
}

export function cookie(name, value, { maxAge, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}
