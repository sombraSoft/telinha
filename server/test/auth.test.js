import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, parseCookies, safeNext, cookie } from '../src/auth.js';

const S = 'test-secret';

test('sign/verify round trip', () => {
  const v = sign(S, { id: '1', name: 'Zé', exp: 2000 });
  assert.deepEqual(verify(S, v, 1000), { id: '1', name: 'Zé', exp: 2000 });
});

test('verify rejects expired, tampered, wrong secret, junk', () => {
  const v = sign(S, { id: '1', exp: 2000 });
  assert.equal(verify(S, v, 2000), null);
  assert.equal(verify('other', v, 1000), null);
  const [data, m] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ id: '2', exp: 2000 })).toString('base64url');
  assert.equal(verify(S, `${forged}.${m}`, 1000), null);
  assert.equal(verify(S, `${data}.x${m}`, 1000), null);
  assert.equal(verify(S, 'nodot', 1000), null);
  assert.equal(verify(S, undefined, 1000), null);
  assert.equal(verify(S, sign(S, { id: '1' }), 1000), null, 'missing exp');
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; b=x%3Dy; junk; a=2'), { a: '1', b: 'x=y' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('safeNext blocks open redirects', () => {
  assert.equal(safeNext('/?room=abc&create=true'), '/?room=abc&create=true');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '', undefined, '/auth/login']) {
    assert.equal(safeNext(bad), '/', String(bad));
  }
});

test('cookie flags', () => {
  const c = cookie('s', 'v', { maxAge: 60 });
  for (const f of ['s=v', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=60']) assert.ok(c.includes(f), f);
});
