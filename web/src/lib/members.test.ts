import { describe, expect, test } from 'bun:test';
import { en } from './i18n/en';
import { type Member, parseMembers, poll, splitMembers, statusKey, type Timers, type Visibility } from './members';

const m = (id: string, name: string, status: Member['status'], avatar: string | null = null): Member => ({
  id,
  name,
  avatar,
  status,
});

describe('parseMembers', () => {
  test('a valid body', () => {
    const list = [m('1', 'Ana', 'online', 'h'), m('2', 'Bia', 'offline')];
    expect(parseMembers({ members: list })).toEqual(list);
  });
  test('not a member list: null, so the last good one stays', () => {
    for (const b of [null, undefined, 'x', {}, { members: 'x' }, { error: 'login' }])
      expect(parseMembers(b)).toBeNull();
  });
  test('drops broken entries, unknown status counts as offline', () => {
    expect(
      parseMembers({
        members: [null, { id: 1, name: 'x' }, { id: '3' }, { id: '4', name: 'Duda', avatar: 5, status: 'invisible' }],
      }),
    ).toEqual([m('4', 'Duda', 'offline')]);
  });
  test('a repeated id keeps the first entry', () => {
    expect(
      parseMembers({ members: [m('1', 'Ana', 'online'), m('2', 'Bia', 'idle'), m('1', 'Ana 2', 'offline')] }),
    ).toEqual([m('1', 'Ana', 'online'), m('2', 'Bia', 'idle')]);
  });
});

describe('splitMembers', () => {
  const list = [
    m('1', 'Dev', 'online'),
    m('2', 'zé', 'offline'),
    m('3', 'Carla', 'dnd'),
    m('4', 'bruno', 'idle'),
    m('5', 'Ana', 'online'),
    m('6', 'Álvaro', 'offline'),
    m('7', 'Bia', 'offline'),
  ];
  test('people in the room are left out of both sections', () => {
    const { online, offline } = splitMembers(list, new Set(['1', '7']));
    expect(online.map((x) => x.id)).not.toContain('1');
    expect(offline.map((x) => x.id)).not.toContain('7');
  });
  test('online: online > idle > dnd, then by name; offline by name', () => {
    const { online, offline } = splitMembers(list, new Set(['1']));
    expect(online.map((x) => x.name)).toEqual(['Ana', 'bruno', 'Carla']);
    expect(offline.map((x) => x.name)).toEqual(['Álvaro', 'Bia', 'zé']);
  });
  test('an empty section stays empty (the sidebar hides it)', () => {
    expect(splitMembers(list, new Set(['2', '6', '7'])).offline).toEqual([]);
    expect(splitMembers(list, new Set(['1', '3', '4', '5'])).online).toEqual([]);
    expect(splitMembers([], new Set())).toEqual({ online: [], offline: [] });
  });
  test('does not reorder the list it was given', () => {
    const copy = [...list];
    splitMembers(list, new Set());
    expect(list).toEqual(copy);
  });
});

test('every status has a label', () => {
  for (const s of ['online', 'idle', 'dnd', 'offline'] as const) expect(en[statusKey(s)]).toBeTruthy();
});

describe('poll', () => {
  function harness() {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_: string, f: () => void) => void listeners.add(f),
      removeEventListener: (_: string, f: () => void) => void listeners.delete(f),
    } satisfies Visibility;
    const pending = new Map<number, () => void>();
    let next = 0;
    const timers: Timers = {
      set: (f) => {
        pending.set(++next, f);
        return next;
      },
      clear: (h) => void pending.delete(h as number),
    };
    const signals: AbortSignal[] = [];
    let fail = false;
    let resolveRun: (() => void) | null = null;
    let hold = false;
    const run = async (signal: AbortSignal) => {
      signals.push(signal);
      if (hold) await new Promise<void>((r) => (resolveRun = r));
      if (fail) throw new Error('offline');
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const fire = async () => {
      const [[id, f]] = [...pending];
      pending.delete(id);
      f();
      await flush();
    };
    const setVisible = async (v: boolean) => {
      doc.visibilityState = v ? 'visible' : 'hidden';
      for (const f of listeners) f();
      await flush();
    };
    return {
      doc,
      timers,
      run,
      pending,
      signals,
      listeners,
      fire,
      flush,
      setVisible,
      failing: (v: boolean) => (fail = v),
      holding: (v: boolean) => (hold = v),
      release: async () => {
        resolveRun?.();
        await flush();
      },
    };
  }

  test('runs at once, then once per interval', async () => {
    const h = harness();
    poll(h.run, { everyMs: 15_000, doc: h.doc, timers: h.timers });
    await h.flush();
    expect(h.signals).toHaveLength(1);
    expect(h.pending.size).toBe(1);
    await h.fire();
    expect(h.signals).toHaveLength(2);
    expect(h.pending.size).toBe(1);
  });

  test('a failed run keeps polling', async () => {
    const h = harness();
    h.failing(true);
    poll(h.run, { everyMs: 15_000, doc: h.doc, timers: h.timers });
    await h.flush();
    expect(h.pending.size).toBe(1);
    await h.fire();
    expect(h.signals).toHaveLength(2);
  });

  test('hidden pauses, visible runs again at once', async () => {
    const h = harness();
    poll(h.run, { everyMs: 15_000, doc: h.doc, timers: h.timers });
    await h.flush();
    await h.setVisible(false);
    expect(h.pending.size).toBe(0);
    expect(h.signals).toHaveLength(1);
    await h.setVisible(true);
    expect(h.signals).toHaveLength(2);
    expect(h.pending.size).toBe(1);
  });

  test('starting hidden waits for visible', async () => {
    const h = harness();
    h.doc.visibilityState = 'hidden';
    poll(h.run, { everyMs: 15_000, doc: h.doc, timers: h.timers });
    await h.flush();
    expect(h.signals).toHaveLength(0);
    await h.setVisible(true);
    expect(h.signals).toHaveLength(1);
  });

  test('no overlapping runs when the tab comes back during one', async () => {
    const h = harness();
    h.holding(true);
    poll(h.run, { everyMs: 15_000, doc: h.doc, timers: h.timers });
    await h.flush();
    await h.setVisible(false);
    await h.setVisible(true);
    expect(h.signals).toHaveLength(1);
    await h.release();
    expect(h.pending.size).toBe(1);
  });

  test('teardown aborts the run in flight and stops everything', async () => {
    const h = harness();
    h.holding(true);
    const stop = poll(h.run, { everyMs: 15_000, doc: h.doc, timers: h.timers });
    await h.flush();
    stop();
    expect(h.signals[0]!.aborted).toBe(true);
    expect(h.listeners.size).toBe(0);
    await h.release();
    expect(h.pending.size).toBe(0);
  });
});
