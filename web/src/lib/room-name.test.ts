import { describe, expect, test } from 'bun:test';
import { avatarUrl, discordIdOf, parseMeta } from './avatar';
import { isValidRoom, randomRoom } from './room-name';

describe('room names', () => {
  test('same rule as the server', () => {
    for (const ok of ['abcd', 'A_b-9', 'x'.repeat(40)]) expect(isValidRoom(ok)).toBe(true);
    for (const bad of [null, '', 'abc', 'x'.repeat(41), 'a b c d', '../etc', 'sala!']) expect(isValidRoom(bad)).toBe(false);
  });
  test('random rooms are 9 chars without look-alikes', () => {
    for (let i = 0; i < 50; i++) {
      const r = randomRoom();
      expect(r).toMatch(/^[a-km-np-z2-9]{9}$/);
      expect(isValidRoom(r)).toBe(true);
    }
    expect(randomRoom((n) => new Uint8Array(n).fill(0))).toBe('aaaaaaaaa');
    expect(randomRoom((n) => new Uint8Array(n).fill(31))).toBe('999999999');
  });
});

describe('avatars', () => {
  test('custom avatar from the CDN', () => {
    expect(avatarUrl('123', 'abc')).toBe('https://cdn.discordapp.com/avatars/123/abc.png?size=64');
  });
  test('default avatar from the id', () => {
    const id = (6n << 22n) * 7n + (3n << 22n); // (id >> 22) % 6 === 3
    expect(avatarUrl(String(id), null)).toBe('https://cdn.discordapp.com/embed/avatars/3.png');
    expect(avatarUrl('not-a-number', null)).toBe('https://cdn.discordapp.com/embed/avatars/0.png');
  });
  test('metadata and identity parsing', () => {
    expect(parseMeta('{"id":"1","avatar":null}')).toEqual({ id: '1', avatar: null });
    expect(parseMeta('oops')).toEqual({});
    expect(parseMeta(undefined)).toEqual({});
    expect(discordIdOf('123:ab12cd')).toBe('123');
  });
});
