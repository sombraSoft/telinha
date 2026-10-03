import { describe, expect, test } from 'bun:test';
import { DOCK_MARGIN, clampTo, homeOf, nearHome, parseDockPos, placeDock, toFraction } from './dock';

const stage = { width: 1000, height: 600 };
const dock = { width: 200, height: 52 };

describe('homeOf', () => {
  test('bottom-centre, a margin above the edge', () => {
    expect(homeOf(dock, stage)).toEqual({ x: 500, y: 600 - DOCK_MARGIN - 26 });
  });
  test('follows the dock size (idle vs live)', () => {
    expect(homeOf({ width: 400, height: 60 }, stage)).toEqual({ x: 500, y: 600 - DOCK_MARGIN - 30 });
  });
});

describe('homeOf on the screen centre', () => {
  const y = 600 - DOCK_MARGIN - 26;
  test('people list open: centred on the window, not the stage', () => {
    // 1260 px window, stage from 0 to 1000, the list takes the other 260.
    expect(homeOf(dock, stage, { stageLeft: 0, width: 1260 })).toEqual({ x: 630, y });
  });
  test('people list collapsed: window centre is the stage centre', () => {
    expect(homeOf(dock, stage, { stageLeft: 0, width: 1000 })).toEqual(homeOf(dock, stage));
  });
  test('a stage that does not start at the window edge', () => {
    expect(homeOf(dock, stage, { stageLeft: 100, width: 1200 })).toEqual({ x: 500, y });
  });
  test('a narrow stage shifts only as far as it stays inside', () => {
    // Window centre 450 would put the dock's right edge past 400 - margin.
    const narrow = { width: 400, height: 600 };
    expect(homeOf(dock, narrow, { stageLeft: 0, width: 900 })).toEqual({ x: 400 - DOCK_MARGIN - 100, y });
    // Partly: wanted 260, still fits (260 + 100 <= 384).
    expect(homeOf(dock, narrow, { stageLeft: 0, width: 520 })).toEqual({ x: 260, y });
  });
  test('a stage narrower than the dock still centres it in the stage', () => {
    expect(homeOf(dock, { width: 180, height: 600 }, { stageLeft: 0, width: 440 }).x).toBe(90);
  });
  test('placeDock(null) uses it; dragged positions ignore it', () => {
    const screen = { stageLeft: 0, width: 1260 };
    expect(placeDock(null, dock, stage, screen)).toEqual({ x: 630, y });
    expect(placeDock({ x: 0.25, y: 0.5 }, dock, stage, screen)).toEqual({ x: 250, y: 300 });
  });
});

describe('clampTo', () => {
  test('inside positions are left alone', () => {
    expect(clampTo({ x: 300, y: 200 }, dock, stage)).toEqual({ x: 300, y: 200 });
  });
  test('the whole dock stays inside, margin included', () => {
    expect(clampTo({ x: -50, y: -50 }, dock, stage)).toEqual({ x: DOCK_MARGIN + 100, y: DOCK_MARGIN + 26 });
    expect(clampTo({ x: 5000, y: 5000 }, dock, stage)).toEqual({ x: 1000 - DOCK_MARGIN - 100, y: 600 - DOCK_MARGIN - 26 });
  });
  test('a stage narrower than the dock centres it on that axis', () => {
    expect(clampTo({ x: 10, y: 200 }, dock, { width: 180, height: 600 })).toEqual({ x: 90, y: 200 });
  });
});

describe('nearHome', () => {
  const home = { x: 500, y: 540 };
  test('within the snap radius', () => {
    expect(nearHome({ x: 510, y: 530 }, home)).toBe(true);
    expect(nearHome({ x: 524, y: 540 }, home)).toBe(true);
  });
  test('outside it', () => {
    expect(nearHome({ x: 520, y: 520 }, home)).toBe(false);
    expect(nearHome({ x: 100, y: 100 }, home)).toBe(false);
  });
});

describe('placeDock', () => {
  test('null is home', () => {
    expect(placeDock(null, dock, stage)).toEqual(homeOf(dock, stage));
  });
  test('a fraction scales with the stage', () => {
    expect(placeDock({ x: 0.25, y: 0.5 }, dock, stage)).toEqual({ x: 250, y: 300 });
    expect(placeDock({ x: 0.25, y: 0.5 }, dock, { width: 2000, height: 1200 })).toEqual({ x: 500, y: 600 });
  });
  test('re-clamps when the stage shrinks', () => {
    expect(placeDock({ x: 0.99, y: 0.01 }, dock, { width: 400, height: 300 })).toEqual({ x: 400 - DOCK_MARGIN - 100, y: DOCK_MARGIN + 26 });
  });
  test('toFraction is its inverse', () => {
    const p = { x: 250, y: 300 };
    expect(placeDock(toFraction(p, stage), dock, stage)).toEqual(p);
  });
  test('toFraction of an unmeasured stage is home-ish, not NaN', () => {
    expect(toFraction({ x: 10, y: 10 }, { width: 0, height: 0 })).toEqual({ x: 0.5, y: 1 });
  });
});

describe('parseDockPos', () => {
  test('valid fractions', () => {
    expect(parseDockPos({ x: 0.5, y: 0.2 })).toEqual({ x: 0.5, y: 0.2 });
    expect(parseDockPos({ x: 0, y: 1 })).toEqual({ x: 0, y: 1 });
  });
  test('anything else is home', () => {
    for (const v of [null, undefined, 'top', 3, [0.5, 0.5], { x: 0.5 }, { x: '0.5', y: 0.5 }, { x: 1.5, y: 0.5 }, { x: -0.1, y: 0.5 }, { x: NaN, y: 0.5 }]) {
      expect(parseDockPos(v)).toBeNull();
    }
  });
});
