// Role check through the bot's REST client, cached per user for the TTL, so
// removing the role locks someone out without waiting for the cookie to expire.
import { REST, Routes } from 'discord.js';

export type IsMember = (userId: string) => Promise<boolean>;
export type GetMember = (userId: string) => Promise<{ roles: string[] }>;

export function createRoleChecker(opts: {
  getMember: GetMember;
  roleId: string;
  ttlMs: number;
  now?: () => number;
}): IsMember {
  const { getMember, roleId, ttlMs, now = Date.now } = opts;
  const cache = new Map<string, { ok: boolean; at: number }>();
  return async (userId) => {
    const hit = cache.get(userId);
    if (hit && now() - hit.at < ttlMs) return hit.ok;
    let ok = false;
    try {
      ok = (await getMember(userId)).roles.includes(roleId);
    } catch (e) {
      // 404 = not in the guild. Anything else (Discord hiccup): keep the last answer.
      if ((e as { status?: number }).status !== 404) {
        if (hit) return hit.ok;
        throw e;
      }
    }
    cache.set(userId, { ok, at: now() });
    return ok;
  };
}

export function restGetMember(rest: REST, guildId: string): GetMember {
  return async (userId) => (await rest.get(Routes.guildMember(guildId, userId))) as { roles: string[] };
}

// DEV_USER mode: only the fake user is a member.
export const devIsMember = (devId: string): IsMember => async (id) => id === devId;
