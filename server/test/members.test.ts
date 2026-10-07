import { describe, expect, test } from 'bun:test';
import {
  createDirectory,
  devMembers,
  type GuildMemberLike,
  type MemberData,
  memberData,
  sortMembers,
  toStatus,
} from '../src/members.ts';

type GmInput = { id?: string; nickname?: string | null; roles?: string[]; user?: Partial<GuildMemberLike['user']> };
const gm = (o: GmInput = {}): GuildMemberLike => ({
  id: o.id ?? '7',
  nickname: o.nickname ?? null,
  user: { bot: false, avatar: 'hash', globalName: 'Global', username: 'user', ...o.user },
  roles: { cache: new Set(o.roles ?? ['R']) },
});

const md = (id: string, name: string, o: Partial<MemberData> = {}): MemberData => ({
  id,
  name,
  avatar: null,
  bot: false,
  hasRole: true,
  ...o,
});

describe('memberData', () => {
  test('name: guild nick, else global name, else username', () => {
    expect(memberData(gm({ nickname: 'Nick' }), 'R').name).toBe('Nick');
    expect(memberData(gm(), 'R').name).toBe('Global');
    expect(memberData(gm({ user: { globalName: null } }), 'R').name).toBe('user');
  });

  test('user avatar hash, bot flag and the role', () => {
    expect(memberData(gm(), 'R')).toEqual({ id: '7', name: 'Global', avatar: 'hash', bot: false, hasRole: true });
    expect(memberData(gm({ roles: ['X'], user: { avatar: null, bot: true } }), 'R')).toEqual({
      id: '7',
      name: 'Global',
      avatar: null,
      bot: true,
      hasRole: false,
    });
  });
});

test('toStatus: invisible and no presence are offline', () => {
  expect(['online', 'idle', 'dnd', 'invisible', 'offline', null, undefined, 'weird'].map(toStatus)).toEqual([
    'online',
    'idle',
    'dnd',
    'offline',
    'offline',
    'offline',
    'offline',
    'offline',
  ]);
});

test('sortMembers: online > idle > dnd > offline, then name (case and accents ignored)', () => {
  const list = sortMembers([
    { id: '1', name: 'zé', status: 'offline' as const },
    { id: '2', name: 'Bia', status: 'dnd' as const },
    { id: '3', name: 'ana', status: 'idle' as const },
    { id: '4', name: 'Caio', status: 'online' as const },
    { id: '5', name: 'Álvaro', status: 'online' as const },
    { id: '6', name: 'Ana', status: 'offline' as const },
  ]);
  expect(list.map((m) => m.name)).toEqual(['Álvaro', 'Caio', 'ana', 'Bia', 'Ana', 'zé']);
});

describe('directory', () => {
  test('null until the first full fetch', () => {
    const d = createDirectory();
    d.upsert(md('1', 'Ana'));
    expect(d.list()).toBeNull();
    d.reset([], []);
    expect(d.list()).toEqual([]);
  });

  test('reset keeps role members only (no bots), with their status, sorted', () => {
    const d = createDirectory();
    d.reset(
      [
        md('1', 'Ana'),
        md('2', 'Bia', { hasRole: false }),
        md('3', 'Bot', { bot: true }),
        md('4', 'Caio', { avatar: 'h' }),
      ],
      [
        ['4', 'idle'],
        ['2', 'online'],
        ['3', 'online'],
      ],
    );
    expect(d.list()).toEqual([
      { id: '4', name: 'Caio', avatar: 'h', status: 'idle' },
      { id: '1', name: 'Ana', avatar: null, status: 'offline' },
    ]);
    expect(d.size).toBe(2);
  });

  test('reset replaces what was there', () => {
    const d = createDirectory();
    d.reset([md('1', 'Ana')], [['1', 'online']]);
    d.reset([md('2', 'Bia')], []);
    expect(d.list()).toEqual([{ id: '2', name: 'Bia', avatar: null, status: 'offline' }]);
  });

  test('role gained, nick change, role lost', () => {
    const d = createDirectory();
    d.reset([], [['1', 'dnd']]);
    d.upsert(md('1', 'Ana'));
    // keeps the status the presence update gave before the role came
    expect(d.list()).toEqual([{ id: '1', name: 'Ana', avatar: null, status: 'dnd' }]);
    d.upsert(md('1', 'Aninha', { avatar: 'new' }));
    expect(d.list()).toEqual([{ id: '1', name: 'Aninha', avatar: 'new', status: 'dnd' }]);
    d.upsert(md('1', 'Aninha', { hasRole: false }));
    expect(d.list()).toEqual([]);
  });

  test('presence updates move members between statuses and re-sort', () => {
    const d = createDirectory();
    d.reset([md('1', 'Ana'), md('2', 'Bia')], [['1', 'online']]);
    d.presence('2', 'online');
    d.presence('1', 'offline');
    expect(d.list()!.map((m) => [m.name, m.status])).toEqual([
      ['Bia', 'online'],
      ['Ana', 'offline'],
    ]);
    d.presence('2', 'invisible');
    expect(d.list()!.map((m) => m.status)).toEqual(['offline', 'offline']);
  });

  test('leaving the guild drops the member and the status', () => {
    const d = createDirectory();
    d.reset([md('1', 'Ana')], [['1', 'online']]);
    d.remove('1');
    expect(d.list()).toEqual([]);
    d.upsert(md('1', 'Ana'));
    expect(d.list()).toEqual([{ id: '1', name: 'Ana', avatar: null, status: 'offline' }]);
  });
});

test('devMembers: fixed list with the dev user online, sorted, every status present', () => {
  const list = devMembers({ id: '1', name: 'Dev' });
  expect(list).toHaveLength(8);
  expect(list.find((m) => m.id === '1')).toEqual({ id: '1', name: 'Dev', avatar: null, status: 'online' });
  expect(list.map((m) => m.status)).toEqual([
    'online',
    'online',
    'idle',
    'dnd',
    'offline',
    'offline',
    'offline',
    'offline',
  ]);
  expect(sortMembers(list)).toEqual(list);
  expect(devMembers({ id: '1', name: 'Dev' })).toEqual(list);
});
