// Same rule as Telinha (server/src/codes.ts): a room code is 2+2 or 3+3
// consonant-vowel syllables, "lamo-futi" or "lamofu-tibare". Room codes come from
// the bot's slash command; the page never makes one up.
const S = '(?:[bdfgjklmnprstvz][aeiou])';
export const ROOM_RE = new RegExp(`^(?:${S}{2}-${S}{2}|${S}{3}-${S}{3})$`);

export function isRoomCode(code: string | null | undefined): code is string {
  return !!code && ROOM_RE.test(code);
}
