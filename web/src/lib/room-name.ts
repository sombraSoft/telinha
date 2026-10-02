export const ROOM_RE = /^[A-Za-z0-9_-]{4,40}$/;
// No look-alikes (0/o, 1/l): people read these out loud in calls.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function isValidRoom(name: string | null | undefined): name is string {
  return !!name && ROOM_RE.test(name);
}

export function randomRoom(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return Array.from(random(9), (b) => ALPHABET[b % ALPHABET.length]).join('');
}
