// Discord side of setup: a small REST client over an injected fetch, the
// helpers that turn its lists into choices, and the check the install runs:
// the client id comes from the token, the intents are switched on, and the
// server, role and channels must be ones the bot can see.
import { COMMAND_RE } from '../../config.ts';
import type { Values, Wizard } from './steps.ts';

const API = 'https://discord.com/api/v10';
/** VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY: card edits need view + history. */
export const INVITE_PERMISSIONS = (1 << 10) + (1 << 11) + (1 << 16);
export const PRESENCE_LIMITED = 1 << 13;
export const MEMBERS_LIMITED = 1 << 15;
// Verified apps carry the full flags instead of the limited ones.
const PRESENCE_ANY = (1 << 12) | PRESENCE_LIMITED;
const MEMBERS_ANY = (1 << 14) | MEMBERS_LIMITED;
/** Text and announcement channels; categories (4) only group them. */
const TEXT_TYPES = new Set([0, 5]);
const CATEGORY = 4;
export const SNOWFLAKE_RE = /^\d{17,20}$/;

export interface DiscordApplication {
  id: string;
  name: string;
  flags: number;
  redirectUris: string[];
  botPublic: boolean;
}
export interface DiscordRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}
export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
}

export interface DiscordSetup {
  application(): Promise<DiscordApplication>;
  /** PATCH flags | presence | members (the only intent flags the API may set); returns the new flags. */
  enableLimitedIntents(current: number): Promise<number>;
  guilds(): Promise<{ id: string; name: string }[]>;
  roles(guildId: string): Promise<DiscordRole[]>;
  channels(guildId: string): Promise<DiscordChannel[]>;
  /** client_credentials grant with Basic auth: true when Discord accepts the pair. */
  checkClientSecret(clientId: string, secret: string): Promise<boolean>;
  inviteUrl(clientId: string, guildId?: string): string;
}

/** A 4xx/5xx from Discord; `message` is Discord's own when it sent one. */
export class DiscordError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DiscordError';
  }
}

export function inviteUrl(clientId: string, guildId?: string): string {
  const q = `client_id=${encodeURIComponent(clientId)}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;
  return `https://discord.com/oauth2/authorize?${q}${guildId ? `&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true` : ''}`;
}

export const hasIntents = (flags: number): boolean => (flags & PRESENCE_ANY) !== 0 && (flags & MEMBERS_ANY) !== 0;

export function createDiscordSetup(o: {
  token: string;
  fetch: typeof fetch;
  version: string;
  sleep?: (ms: number) => Promise<void>;
}): DiscordSetup {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const agent = `DiscordBot (https://github.com/sombraSoft/telinha, ${o.version})`;

  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await o.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      if (res.status !== 429 || attempt > 0) return res;
      // One retry after Discord's own delay (seconds, may be fractional).
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const wait = Number(body.retry_after ?? res.headers.get('retry-after') ?? 1);
      await sleep(Math.min(Math.max(wait, 0), 30) * 1000);
    }
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bot ${o.token}`, 'User-Agent': agent };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await send(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new DiscordError(res.status, await errorText(res));
    return (await res.json()) as T;
  }

  return {
    async application() {
      const a = await call<{
        id: string;
        name: string;
        flags?: number;
        redirect_uris?: string[];
        bot_public?: boolean;
      }>('GET', '/applications/@me');
      return {
        id: a.id,
        name: a.name,
        flags: a.flags ?? 0,
        redirectUris: a.redirect_uris ?? [],
        botPublic: !!a.bot_public,
      };
    },
    async enableLimitedIntents(current) {
      const a = await call<{ flags?: number }>('PATCH', '/applications/@me', {
        flags: current | PRESENCE_LIMITED | MEMBERS_LIMITED,
      });
      return a.flags ?? 0;
    },
    async guilds() {
      const list = await call<{ id: string; name: string }[]>('GET', '/users/@me/guilds');
      return list.map((g) => ({ id: g.id, name: g.name }));
    },
    async roles(guildId) {
      const list = await call<{ id: string; name: string; position: number; managed?: boolean }[]>(
        'GET',
        `/guilds/${guildId}/roles`,
      );
      return list.map((r) => ({ id: r.id, name: r.name, position: r.position, managed: !!r.managed }));
    },
    async channels(guildId) {
      const list = await call<
        { id: string; name: string; type: number; parent_id?: string | null; position?: number }[]
      >('GET', `/guilds/${guildId}/channels`);
      return list.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        parentId: c.parent_id ?? null,
        position: c.position ?? 0,
      }));
    },
    async checkClientSecret(clientId, secret) {
      const res = await send(`${API}/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': agent,
        },
        body: 'grant_type=client_credentials&scope=identify',
      });
      if (res.ok) return true;
      if (res.status === 400 || res.status === 401) return false;
      throw new DiscordError(res.status, await errorText(res));
    },
    inviteUrl,
  };
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text) as { message?: string; error_description?: string; error?: string };
    const m = j.message ?? j.error_description ?? j.error;
    if (m) return `${m} (HTTP ${res.status})`;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

export function validCommand(v: string): boolean {
  return COMMAND_RE.test(v) && v === v.toLocaleLowerCase();
}

/** Text/announcement channels in Discord's order: uncategorised first, then each category's. */
export function sortChannels(all: DiscordChannel[]): { channel: DiscordChannel; category: string | null }[] {
  const cats = new Map(all.filter((c) => c.type === CATEGORY).map((c) => [c.id, c]));
  const catPos = (c: DiscordChannel) => (c.parentId && cats.has(c.parentId) ? cats.get(c.parentId)!.position : -1);
  return all
    .filter((c) => TEXT_TYPES.has(c.type))
    .sort(
      (a, b) => catPos(a) - catPos(b) || (a.parentId ?? '').localeCompare(b.parentId ?? '') || a.position - b.position,
    )
    .map((channel) => ({ channel, category: channel.parentId ? (cats.get(channel.parentId)?.name ?? null) : null }));
}

/** Roles a member can be gated on: not @everyone (id = guild id), not a bot's own role; top of the list first. */
export function pickableRoles(roles: DiscordRole[], guildId: string): DiscordRole[] {
  return roles.filter((r) => r.id !== guildId && !r.managed).sort((a, b) => b.position - a.position);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The install's Discord check (read-only except the intents). Fills the client id
 * from the token and switches the intents on; returns the problems found
 * (empty = all good). The redirect URI is only a warning (doctor re-checks).
 */
export async function checkDiscord(w: Wizard, values: Values, publicUrl: string): Promise<string[]> {
  const { out, s } = w;
  const client = w.deps.discord(values.DISCORD_TOKEN!);
  let app: DiscordApplication;
  try {
    app = await client.application();
  } catch (e) {
    return [
      e instanceof DiscordError && e.status === 401
        ? s('discordTokenRejected')
        : s('discordUnreachable', { error: errMsg(e) }),
    ];
  }
  out.ok(s('discordBot', { name: app.name, id: app.id }));
  if (values.DISCORD_CLIENT_ID && values.DISCORD_CLIENT_ID !== app.id)
    out.warn(s('clientIdMismatch', { given: values.DISCORD_CLIENT_ID, id: app.id }));
  values.DISCORD_CLIENT_ID = app.id;
  const problems: string[] = [];
  if (!hasIntents(app.flags)) {
    try {
      app.flags = await client.enableLimitedIntents(app.flags);
    } catch (e) {
      out.warn(s('intentsApiFailed', { error: errMsg(e) }));
    }
    if (hasIntents(app.flags)) out.ok(s('intentsOn'));
    else out.warn(s('intentsGiveUp'));
  }
  try {
    if (!(await client.checkClientSecret(app.id, values.DISCORD_CLIENT_SECRET!))) problems.push(s('secretRejected'));
  } catch (e) {
    out.warn(s('secretUnchecked', { error: errMsg(e) }));
  }
  const redirect = `${publicUrl.replace(/\/$/, '')}/auth/callback`;
  if (!app.redirectUris.includes(redirect)) out.warn(s('redirectSkipped', { uri: redirect }));
  try {
    const guilds = await client.guilds();
    const guild = guilds.find((g) => g.id === values.GUILD_ID);
    if (!guild) {
      problems.push(s('guildMissingInvite', { id: values.GUILD_ID!, url: client.inviteUrl(app.id, values.GUILD_ID) }));
      return problems;
    }
    const roles = await client.roles(guild.id);
    if (values.ROLE_ID !== guild.id && !roles.some((r) => r.id === values.ROLE_ID))
      problems.push(s('roleMissing', { id: values.ROLE_ID! }));
    const text = new Set(sortChannels(await client.channels(guild.id)).map((c) => c.channel.id));
    for (const c of (values.CHANNEL_IDS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)) {
      if (!text.has(c)) problems.push(s('channelMissing', { id: c }));
    }
  } catch (e) {
    problems.push(s('discordUnreachable', { error: errMsg(e) }));
  }
  return problems;
}
