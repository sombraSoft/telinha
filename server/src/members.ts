// The member directory behind /auth/members: everyone with ROLE_ID (no bots),
// with the Discord status, kept current from gateway events in bot.ts. Pure
// (plain data in, plain data out) so the mapping and the event handling are
// unit tested without a gateway.
import type { DevUser } from './config.ts';

export type Status = 'online' | 'idle' | 'dnd' | 'offline';

export interface DirMember {
  id: string;
  /** Guild nick, else global name, else username. */
  name: string;
  /** User avatar hash (not the per-guild one), like the session's; null = default avatar. */
  avatar: string | null;
  status: Status;
}

/** What the directory needs from a guild member. */
export interface MemberData {
  id: string;
  name: string;
  avatar: string | null;
  bot: boolean;
  hasRole: boolean;
}

/** The parts of a discord.js GuildMember the mapping reads (structural, so tests pass plain objects). */
export interface GuildMemberLike {
  id: string;
  nickname: string | null;
  user: { bot: boolean; avatar: string | null; globalName: string | null; username: string };
  roles: { cache: { has(id: string): boolean } };
}

export function memberData(m: GuildMemberLike, roleId: string): MemberData {
  return {
    id: m.id,
    name: m.nickname || m.user.globalName || m.user.username,
    avatar: m.user.avatar ?? null,
    bot: m.user.bot,
    hasRole: m.roles.cache.has(roleId),
  };
}

/** Discord's presence status; "invisible" (only ever seen for ourselves) and none count as offline. */
export function toStatus(s: string | null | undefined): Status {
  return s === 'online' || s === 'idle' || s === 'dnd' ? s : 'offline';
}

const RANK: Record<Status, number> = { online: 0, idle: 1, dnd: 2, offline: 3 };
const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/** Online, then idle, then do-not-disturb, then offline; by name inside each. */
export function sortMembers<T extends Pick<DirMember, 'id' | 'name' | 'status'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) =>
    RANK[a.status] - RANK[b.status] || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface Directory {
  /** Replaces everything with a full member fetch; the list is served from then on. */
  reset(members: Iterable<MemberData>, statuses: Iterable<[string, string | null | undefined]>): void;
  /** Join, role gained or lost, nick or avatar change: in or out by the role rule. */
  upsert(m: MemberData): void;
  remove(id: string): void;
  presence(id: string, status: string | null | undefined): void;
  /** Sorted members, or null until the first reset (the bot is not ready yet). */
  list(): DirMember[] | null;
  readonly size: number;
}

export function createDirectory(): Directory {
  const members = new Map<string, Omit<DirMember, 'status'>>();
  // Everyone's status, not only the role's: someone gaining the role keeps the
  // status the last presence update gave. Offline is the default, so not stored.
  const statuses = new Map<string, Status>();
  let ready = false;

  const setStatus = (id: string, s: string | null | undefined) => {
    const st = toStatus(s);
    if (st === 'offline') statuses.delete(id);
    else statuses.set(id, st);
  };

  const dir: Directory = {
    reset(list, st) {
      members.clear();
      statuses.clear();
      for (const [id, s] of st) setStatus(id, s);
      for (const m of list) dir.upsert(m);
      ready = true;
    },
    upsert(m) {
      if (!m.hasRole || m.bot) {
        members.delete(m.id);
        return;
      }
      members.set(m.id, { id: m.id, name: m.name, avatar: m.avatar });
    },
    remove(id) {
      members.delete(id);
      statuses.delete(id);
    },
    presence: setStatus,
    list() {
      if (!ready) return null;
      return sortMembers([...members.values()].map((m) => ({ ...m, status: statuses.get(m.id) ?? 'offline' })));
    },
    get size() {
      return members.size;
    },
  };
  return dir;
}

/** DEV_USER mode has no Discord: a fixed list (the dev user online among them) to preview the page with. */
export function devMembers(dev: DevUser): DirMember[] {
  const fake: Array<[string, string, Status]> = [
    ['175928847299117063', 'Ana', 'online'],
    ['190837245600120832', 'Bruno', 'idle'],
    ['204255221017214977', 'Carla', 'dnd'],
    ['222078108977594368', 'Diego', 'offline'],
    ['235148962103951360', 'Elis', 'offline'],
    ['248987832411389954', 'Fábio', 'offline'],
    ['272937604339466240', 'Gabi', 'offline'],
  ];
  return sortMembers([
    { id: dev.id, name: dev.name, avatar: null, status: 'online' as Status },
    ...fake.filter(([id]) => id !== dev.id).map(([id, name, status]) => ({ id, name, avatar: null, status })),
  ]);
}
