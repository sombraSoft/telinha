import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { newRoomCode, ROOM_RE, SYLLABLES, uniqueRoomCode } from '../src/codes.ts';

const S = '[bdfgjklmnprstvz][aeiou]';
const FOUR = new RegExp(`^${S}${S}-${S}${S}$`);
const SIX = new RegExp(`^${S}${S}${S}-${S}${S}${S}$`);

/** Bytes 0, 1, 2, ... (wrapping at 256): deterministic and covers every byte value. */
function counting() {
  let n = 0;
  return (len: number) => Uint8Array.from({ length: len }, () => n++ % 256);
}

test('75 distinct consonant-vowel syllables', () => {
  expect(SYLLABLES.length).toBe(75);
  expect(new Set(SYLLABLES).size).toBe(75);
  for (const s of SYLLABLES) expect(s).toMatch(new RegExp(`^${S}$`));
});

describe('newRoomCode', () => {
  test('shape: 4 syllables by default, 6 on request; always passes ROOM_RE', () => {
    for (let i = 0; i < 200; i++) {
      const four = newRoomCode(randomBytes);
      const six = newRoomCode(randomBytes, 6);
      expect(four).toMatch(FOUR);
      expect(six).toMatch(SIX);
      expect(four).toMatch(ROOM_RE);
      expect(six).toMatch(ROOM_RE);
    }
  });

  test('deterministic for a fixed random', () => {
    expect(newRoomCode(counting())).toBe(newRoomCode(counting()));
    expect(newRoomCode(counting())).toBe('babe-bibo');
    expect(newRoomCode(counting(), 6)).toBe('babebi-bobuda');
  });

  test('rejection sampling: bytes >= 225 are skipped, the rest are uniform', () => {
    // Every byte value once per 256 draws: a biased b % 75 would give the first
    // 31 syllables 4 hits per cycle instead of 3.
    const random = counting();
    const counts = new Map<string, number>();
    // Four full byte cycles: 4 * 225 accepted bytes = 225 codes of 4 syllables.
    for (let i = 0; i < 225; i++) {
      for (const s of newRoomCode(random).replace('-', '').match(/../g)!) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    expect(counts.size).toBe(75);
    expect(new Set(counts.values())).toEqual(new Set([12]));
    // A byte >= 225 never picks a syllable.
    let calls = 0;
    const high = (len: number) => Uint8Array.from({ length: len }, () => (calls++ < 5 ? 250 : 0));
    expect(newRoomCode(high)).toBe('baba-baba');
  });
});

describe('ROOM_RE', () => {
  test('exactly the codes newRoomCode makes', () => {
    for (const ok of ['lamo-futi', 'bafo-kiru', 'lamofu-tibare', 'baba-baba', 'zuzuzu-zuzuzu']) expect(ok).toMatch(ROOM_RE);
    for (const bad of [
      '', 'abcd', 'Room_1-x', 'x'.repeat(40), 'AbC_dEf-123', 'q3Jx_9aZ-kP2w', // old ids
      'lamofuti', 'lamo-', '-futi', 'la-futi', 'lamo-fu', 'lamofu-ti', 'lamo-futiba', 'lamofuti-bare', 'lamofutiba-re',
      'Lamo-futi', 'lamo_futi', 'lamo--futi', 'lamo-futi-bare', 'cama-futi', 'lamo-fyti', 'lamo-futi ', ' lamo-futi',
      'lamo-futi\n',
    ]) expect(bad).not.toMatch(ROOM_RE);
  });
});

describe('uniqueRoomCode', () => {
  test('skips codes that exist', () => {
    const taken = new Set([newRoomCode(counting())]);
    const random = counting();
    const code = uniqueRoomCode((c) => taken.has(c), random);
    expect(code).toMatch(FOUR);
    expect(taken.has(code)).toBe(false);
  });

  test('escalates to 6 syllables after `tries` collisions', () => {
    const seen: string[] = [];
    const code = uniqueRoomCode((c) => (seen.push(c), FOUR.test(c)), randomBytes, 3);
    expect(code).toMatch(SIX);
    expect(seen.slice(0, 3).every((c) => FOUR.test(c))).toBe(true);
    expect(seen).toHaveLength(4);
  });

  test('throws after 2 * tries', () => {
    let n = 0;
    expect(() => uniqueRoomCode(() => (n++, true), randomBytes, 4)).toThrow();
    expect(n).toBe(8);
  });
});
