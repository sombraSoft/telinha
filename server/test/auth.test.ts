import { expect, test } from 'bun:test';
import { cookie, parseCookies, type Session, safeNext, sign, verify } from '../src/auth.ts';

const S = 'test-secret';

test('sign/verify round trip', () => {
  const v = sign(S, { id: '1', name: 'Zé', exp: 2000 });
  expect(verify(S, v, 1000)).toEqual({ id: '1', name: 'Zé', exp: 2000 } as never);
});

test('verify rejects expired, tampered, wrong secret, junk', () => {
  const v = sign(S, { id: '1', exp: 2000 });
  expect(verify(S, v, 2000)).toBeNull();
  expect(verify('other', v, 1000)).toBeNull();
  const [data, m] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ id: '2', exp: 2000 })).toString('base64url');
  expect(verify(S, `${forged}.${m}`, 1000)).toBeNull();
  expect(verify(S, `${data}.x${m}`, 1000)).toBeNull();
  expect(verify(S, 'nodot', 1000)).toBeNull();
  expect(verify(S, undefined, 1000)).toBeNull();
  expect(verify(S, sign(S, { id: '1' }), 1000)).toBeNull(); // missing exp
});

test('0.1.1 session cookies still verify (same format and secret)', () => {
  // produced by main:server/src/auth.js sign('test-secret', {id:'1',name:'Zé',avatar:null,exp:2000})
  const data = Buffer.from(JSON.stringify({ id: '1', name: 'Zé', avatar: null, exp: 2000 })).toString('base64url');
  const mac = new Bun.CryptoHasher('sha256', S).update(data).digest('base64url');
  expect(verify<Session>(S, `${data}.${mac}`, 1000)).toEqual({ id: '1', name: 'Zé', avatar: null, exp: 2000 });
});

test('parseCookies', () => {
  expect(parseCookies('a=1; b=x%3Dy; junk; a=2')).toEqual({ a: '1', b: 'x=y' });
  expect(parseCookies(undefined)).toEqual({});
  expect(parseCookies(null)).toEqual({});
  expect(parseCookies('bad=%E0%A4%A; ok=1')).toEqual({ ok: '1' });
});

test('safeNext blocks open redirects', () => {
  expect(safeNext('/r/?x=1&y=2')).toBe('/r/?x=1&y=2');
  expect(safeNext('/r/bafo-kiru#x')).toBe('/r/bafo-kiru#x');
  for (const bad of [
    '//evil.com',
    '/\\evil.com',
    'https://evil.com',
    '',
    undefined,
    '/auth/login',
    '/./auth/login',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r\n/evil.com',
    '/\u0000/evil.com',
  ]) {
    expect(safeNext(bad)).toBe('/');
  }
});

test('cookie flags', () => {
  const c = cookie('s', 'v', { maxAge: 60 });
  for (const f of ['s=v', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=60']) expect(c).toContain(f);
});

test('cookie without Secure for plain-http dev', () => {
  const c = cookie('s', 'v', { secure: false, path: '/auth' });
  expect(c).not.toContain('Secure');
  expect(c).toContain('Path=/auth');
  expect(c).toContain('HttpOnly');
});
