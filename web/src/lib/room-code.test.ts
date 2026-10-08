import { describe, expect, test } from 'bun:test';
import { newRoomCode, ROOM_RE as SERVER_ROOM_RE } from '../../../server/src/codes';
import { avatarUrl, discordIdOf, parseMeta } from './avatar';
import { isRoomCode, ROOM_RE } from './room-code';

describe('room codes', () => {
  test('same rule as Telinha', () => {
    expect(ROOM_RE.source).toBe(SERVER_ROOM_RE.source);
  });
  test('every code Telinha makes is valid', () => {
    const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    for (let i = 0; i < 200; i++) {
      expect(isRoomCode(newRoomCode(random))).toBe(true);
      expect(isRoomCode(newRoomCode(random, 6))).toBe(true);
    }
  });
  test('anything else is not', () => {
    for (const ok of ['lamo-futi', 'bafo-kiru', 'lamofu-tibare']) expect(isRoomCode(ok)).toBe(true);
    for (const bad of [
      null,
      undefined,
      '',
      'abcd',
      'Room_1-x',
      'x'.repeat(40),
      'AbC_dEf-123',
      'q3Jx_9aZ-kP2w', // old ids
      'lamofuti',
      'lamo-',
      '-futi',
      'la-futi',
      'lamo-fu',
      'lamofu-ti',
      'lamo-futiba',
      'lamofuti-bare',
      'lamofutiba-re',
      'Lamo-futi',
      'lamo_futi',
      'lamo--futi',
      'lamo-futi-bare',
      'cama-futi',
      'lamo-fyti',
      'lamo-futi ',
      ' lamo-futi',
      'lamo-futi\n',
      '../etc',
      'sala!',
    ])
      expect(isRoomCode(bad)).toBe(false);
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
