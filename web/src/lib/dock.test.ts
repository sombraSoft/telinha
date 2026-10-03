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
