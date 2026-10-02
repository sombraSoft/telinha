import { expect, test } from 'bun:test';
import { createRoleChecker, devIsMember } from '../src/roles.ts';

const err = (status: number) => Object.assign(new Error(`status ${status}`), { status });

function setup(answers: Array<string[] | number>) {
  let clock = 0;
  let calls = 0;
  const isMember = createRoleChecker({
    roleId: 'R',
    ttlMs: 1000,
    now: () => clock,
    getMember: async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]!;
      if (typeof a === 'number') throw err(a);
      return { roles: a };
    },
  });
  return { isMember, tick: (ms: number) => { clock += ms; }, calls: () => calls };
}

test('caches the answer for the TTL', async () => {
  const s = setup([['R'], []]);
  expect(await s.isMember('1')).toBe(true);
  s.tick(999);
  expect(await s.isMember('1')).toBe(true);
  expect(s.calls()).toBe(1);
  s.tick(1);
  expect(await s.isMember('1')).toBe(false);
  expect(s.calls()).toBe(2);
});

test('404 means not a member (and is cached)', async () => {
  const s = setup([404]);
  expect(await s.isMember('1')).toBe(false);
  expect(await s.isMember('1')).toBe(false);
  expect(s.calls()).toBe(1);
});

test('other errors keep the last answer, or throw without one', async () => {
  const s = setup([['R'], 500]);
  expect(await s.isMember('1')).toBe(true);
  s.tick(2000);
  expect(await s.isMember('1')).toBe(true);
  const fresh = setup([503]);
  expect(fresh.isMember('2')).rejects.toThrow('status 503');
});

test('devIsMember: only the dev user', async () => {
  const m = devIsMember('1');
  expect(await m('1')).toBe(true);
  expect(await m('2')).toBe(false);
});
