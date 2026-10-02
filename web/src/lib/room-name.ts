// Same rule as the server. Rooms are named by /tela; the page never makes one up.
export const ROOM_RE = /^[A-Za-z0-9_-]{4,40}$/;

export function isValidRoom(name: string | null | undefined): name is string {
  return !!name && ROOM_RE.test(name);
}
