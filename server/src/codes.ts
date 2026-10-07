// Room codes people can read out loud: "lamo-futi". Consonant-vowel syllables,
// two syllables per word, two words; 6 syllables (37 bits) once the 4-syllable
// space (25 bits) starts colliding. The token TTL, not the code, keeps links short-lived.
const CONSONANTS = 'bdfgjklmnprstvz';
const VOWELS = 'aeiou';

export const SYLLABLES: readonly string[] = [...CONSONANTS].flatMap((c) => [...VOWELS].map((v) => c + v));

// Exactly what newRoomCode makes: 2+2 or 3+3 syllables. The only room names
// the server accepts (web/src/lib/room-name.ts has the same rule).
const S = `(?:[${CONSONANTS}][${VOWELS}])`;
export const ROOM_RE = new RegExp(`^(?:${S}{2}-${S}{2}|${S}{3}-${S}{3})$`);

// 225 = 3 * 75: bytes from 225 up would favour the first 31 syllables.
const LIMIT = 225;

function syllable(random: (n: number) => Uint8Array): string {
  for (;;) {
    const b = random(1)[0]!;
    if (b < LIMIT) return SYLLABLES[b % SYLLABLES.length]!;
  }
}

export function newRoomCode(random: (n: number) => Uint8Array, syllables: 4 | 6 = 4): string {
  const s = Array.from({ length: syllables }, () => syllable(random));
  const half = syllables / 2;
  return `${s.slice(0, half).join('')}-${s.slice(half).join('')}`;
}

/** Tries 4-syllable codes up to `tries` times against `exists`, then 6-syllable ones; throws after 2*tries. */
export function uniqueRoomCode(
  exists: (code: string) => boolean,
  random: (n: number) => Uint8Array,
  tries = 8,
): string {
  for (let i = 0; i < 2 * tries; i++) {
    const code = newRoomCode(random, i < tries ? 4 : 6);
    if (!exists(code)) return code;
  }
  throw new Error(`no free room code after ${2 * tries} tries`);
}
