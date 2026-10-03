// Where the floating share dock sits over the stage. Pure geometry (no DOM),
// so it is unit-tested. Positions are the dock's centre in stage pixels; what
// is stored is that centre as a fraction of the stage size (survives resizes),
// or null for "home" (bottom-centre), which also follows the dock's own size.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

/** Gap kept between the dock and the stage edges. */
export const DOCK_MARGIN = 16;
/** Released this close to home, the dock snaps back there. */
export const SNAP_RADIUS = 24;

export function homeOf(dock: Size, stage: Size, margin = DOCK_MARGIN): Point {
  return clampTo({ x: stage.width / 2, y: stage.height - margin - dock.height / 2 }, dock, stage, margin);
}

/** Keeps the whole dock inside the stage; centred on an axis the stage is too small for. */
export function clampTo(p: Point, dock: Size, stage: Size, margin = DOCK_MARGIN): Point {
  const axis = (v: number, size: number, room: number) => {
    const min = margin + size / 2;
    const max = room - margin - size / 2;
    return max < min ? room / 2 : Math.min(max, Math.max(min, v));
  };
  return { x: axis(p.x, dock.width, stage.width), y: axis(p.y, dock.height, stage.height) };
}

export function nearHome(p: Point, home: Point, radius = SNAP_RADIUS): boolean {
  return Math.hypot(p.x - home.x, p.y - home.y) <= radius;
}

/** The pixel position for a stored fraction (null = home), clamped to the stage. */
export function placeDock(frac: Point | null, dock: Size, stage: Size): Point {
  if (!frac) return homeOf(dock, stage);
  return clampTo({ x: frac.x * stage.width, y: frac.y * stage.height }, dock, stage);
}

export function toFraction(p: Point, stage: Size): Point {
  return { x: stage.width ? p.x / stage.width : 0.5, y: stage.height ? p.y / stage.height : 1 };
}

/** A stored position: {x, y} fractions within 0..1, else null (home). */
export function parseDockPos(v: unknown): Point | null {
  if (!v || typeof v !== 'object') return null;
  const { x, y } = v as { x?: unknown; y?: unknown };
  const ok = (n: unknown): n is number => typeof n === 'number' && n >= 0 && n <= 1;
  return ok(x) && ok(y) ? { x, y } : null;
}
