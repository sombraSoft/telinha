// For values the code guarantees but the types can't see (a regex group that
// always matches, a map key set just above). Throws instead of letting
// undefined travel on; real "maybe missing" cases should narrow instead.
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}
