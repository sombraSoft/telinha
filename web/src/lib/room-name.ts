// Same rule as Telinha (server/src/codes.ts): a room code is 2+2 or 3+3
// consonant-vowel syllables, "lamo-futi" or "lamofu-tibare". Rooms are named by
// the bot's slash command; the page never makes one up.
const S = '(?:[bdfgjklmnprstvz][aeiou])';
export const ROOM_RE = new RegExp(`^(?:${S}{2}-${S}{2}|${S}{3}-${S}{3})$`);

export function isValidRoom(name: string | null | undefined): name is string {
  return !!name && ROOM_RE.test(name);
}
