// Discord side of setup: a small REST client over an injected fetch, and the
// questions that turn a bot token into DISCORD_*, GUILD_ID, ROLE_ID and
// CHANNEL_IDS. Nobody copies ids: the client id comes from the token, the
// rest is picked from lists the bot can see.
import { COMMAND_RE } from '../../config.ts';
import { askSecret, pause, SetupAbort, type Values, type Wizard } from './steps.ts';

/** Invite rounds before the guild step gives up (a bot that never joins, or --yes answering everything). */
const MAX_INVITE_ROUNDS = 5;

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

export interface DiscordApplication { id: string; name: string; flags: number; redirectUris: string[]; botPublic: boolean }
export interface DiscordRole { id: string; name: string; position: number; managed: boolean }
export interface DiscordChannel { id: string; name: string; type: number; parentId: string | null; position: number }

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
  constructor(readonly status: number, message: string) {
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
    const res = await send(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new DiscordError(res.status, await errorText(res));
    return (await res.json()) as T;
  }

  return {
    async application() {
      const a = await call<{ id: string; name: string; flags?: number; redirect_uris?: string[]; bot_public?: boolean }>('GET', '/applications/@me');
      return { id: a.id, name: a.name, flags: a.flags ?? 0, redirectUris: a.redirect_uris ?? [], botPublic: !!a.bot_public };
    },
    async enableLimitedIntents(current) {
      const a = await call<{ flags?: number }>('PATCH', '/applications/@me', { flags: current | PRESENCE_LIMITED | MEMBERS_LIMITED });
      return a.flags ?? 0;
    },
    async guilds() {
      const list = await call<{ id: string; name: string }[]>('GET', '/users/@me/guilds');
      return list.map((g) => ({ id: g.id, name: g.name }));
    },
    async roles(guildId) {
      const list = await call<{ id: string; name: string; position: number; managed?: boolean }[]>('GET', `/guilds/${guildId}/roles`);
      return list.map((r) => ({ id: r.id, name: r.name, position: r.position, managed: !!r.managed }));
    },
    async channels(guildId) {
      const list = await call<{ id: string; name: string; type: number; parent_id?: string | null; position?: number }[]>('GET', `/guilds/${guildId}/channels`);
      return list.map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id ?? null, position: c.position ?? 0 }));
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
    .sort((a, b) => catPos(a) - catPos(b) || (a.parentId ?? '').localeCompare(b.parentId ?? '') || a.position - b.position)
    .map((channel) => ({ channel, category: channel.parentId ? cats.get(channel.parentId)?.name ?? null : null }));
}

/** Roles a member can be gated on: not @everyone (id = guild id), not a bot's own role; top of the list first. */
export function pickableRoles(roles: DiscordRole[], guildId: string): DiscordRole[] {
  return roles.filter((r) => r.id !== guildId && !r.managed).sort((a, b) => b.position - a.position);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Retry or give up after an error that is not the user's answer (network, Discord down). */
async function retryOrAbort(w: Wizard, e: unknown): Promise<void> {
  w.term.fail(w.s('discordUnreachable', { error: errMsg(e) }));
  if (!(await w.term.confirm(w.s('tryAgain'), true, { id: 'retry' }))) throw new SetupAbort(w.s('discordGiveUp'), 1);
}

/**
 * The interactive Discord step. `values` holds the current answers (re-run:
 * the existing file) and receives the new ones.
 */
export async function askDiscord(w: Wizard, values: Values, o: { publicUrl: string; presetGuild?: string; presetRole?: string; presetChannels?: string[] }): Promise<void> {
  const { term, s } = w;
  term.step(s('discordTitle'));
  for (const l of s('discordTokenHelp').split('\n')) term.info(l);

  // 1. Token -> application (client id, flags, redirects).
  let current: string | undefined = values.DISCORD_TOKEN || undefined;
  let client: DiscordSetup;
  let app: DiscordApplication;
  for (;;) {
    const token = await askSecret(w, { id: 'DISCORD_TOKEN', question: s('discordTokenQ'), current });
    client = w.deps.discord(token);
    const spin = term.spinner(s('discordChecking'));
    try {
      app = await client.application();
      spin.stop(s('discordBot', { name: app.name, id: app.id }));
      values.DISCORD_TOKEN = token;
      values.DISCORD_CLIENT_ID = app.id;
      break;
    } catch (e) {
      if (e instanceof DiscordError && e.status === 401) {
        spin.fail(s('discordTokenRejected'));
        current = undefined;
        continue;
      }
      spin.fail(s('discordChecking'));
      await retryOrAbort(w, e);
    }
  }

  // 2. Privileged intents: the API may switch on the limited ones.
  if (hasIntents(app.flags)) {
    term.ok(s('intentsOk'));
  } else {
    let on = false;
    try {
      app.flags = await client.enableLimitedIntents(app.flags);
      on = hasIntents(app.flags);
    } catch (e) {
      term.warn(s('intentsApiFailed', { error: errMsg(e) }));
    }
    if (on) term.ok(s('intentsOn'));
    // The Bot page toggles by hand, re-checked up to three times.
    for (let tries = 0; !on && tries < 3; tries++) {
      for (const l of s('intentsManual').split('\n')) term.info(l);
      await pause(w, s('pressEnterDone'), 'intents');
      try {
        app = await client.application();
      } catch (e) {
        term.warn(errMsg(e));
      }
      on = hasIntents(app.flags);
      if (on) term.ok(s('intentsOk'));
    }
    if (!on) term.warn(s('intentsGiveUp'));
  }

  // 3. Client secret, checked with a client_credentials grant.
  for (const l of s('secretHelp').split('\n')) term.info(l);
  let secretCurrent: string | undefined = values.DISCORD_CLIENT_SECRET || undefined;
  for (;;) {
    const secret = await askSecret(w, { id: 'DISCORD_CLIENT_SECRET', question: s('secretQ'), current: secretCurrent });
    let ok: boolean;
    try {
      ok = await client.checkClientSecret(app.id, secret);
    } catch (e) {
      term.warn(s('secretUnchecked', { error: errMsg(e) }));
      ok = true;
    }
    if (ok) {
      values.DISCORD_CLIENT_SECRET = secret;
      term.ok(s('secretOk'));
      break;
    }
    term.fail(s('secretRejected'));
    secretCurrent = undefined;
  }

  // 4. Redirect URI: the API cannot add it, so show it and re-read until it is there.
  const redirect = `${o.publicUrl.replace(/\/$/, '')}/auth/callback`;
  if (app.redirectUris.includes(redirect)) {
    term.ok(s('redirectOk'));
  } else {
    for (const l of s('redirectHelp').split('\n')) term.info(l);
    term.line(`    ${term.style.bold(term.link(redirect))}`);
    let found = false;
    for (let i = 0; i < 5 && !found; i++) {
      const next = await term.select(s('redirectQ'), [
        { value: 'check', label: s('redirectCheck') },
        { value: 'skip', label: s('redirectSkip') },
      ], 0, { id: 'redirect' });
      if (next === 'skip') break;
      try {
        found = (await client.application()).redirectUris.includes(redirect);
      } catch (e) {
        term.warn(errMsg(e));
      }
      if (!found) term.warn(s('redirectMissing'));
    }
    if (found) term.ok(s('redirectOk'));
    else term.warn(s('redirectSkipped', { uri: redirect }));
  }

  // 5. Guild: one the bot is in; invite it when needed. The browser opens at
  // most once per run, and a bot still in no server after a few rounds ends
  // the wizard with the link instead of asking forever.
  let browserOpened = false;
  let inviteRounds = 0;
  const invite = async (guildId?: string) => {
    const url = client.inviteUrl(app.id, guildId);
    if (++inviteRounds > MAX_INVITE_ROUNDS) throw new SetupAbort(s('guildGiveUp', { url }), 1);
    for (const l of s('inviteHelp').split('\n')) term.info(l);
    term.line(`    ${term.link(url)}`);
    if (!browserOpened && (await term.confirm(s('openBrowser'), true, { id: 'open-browser' }))) {
      browserOpened = true;
      try {
        await w.deps.openUrl(url);
      } catch {
        term.warn(s('openFailed'));
      }
    }
    await pause(w, s('pressEnterInvited'), 'invite');
  };
  let guild: { id: string; name: string };
  let wanted = o.presetGuild ?? values.GUILD_ID;
  for (;;) {
    let guilds: { id: string; name: string }[];
    try {
      guilds = await client.guilds();
    } catch (e) {
      await retryOrAbort(w, e);
      continue;
    }
    if (!guilds.length) {
      term.warn(s('guildNone'));
      await invite();
      continue;
    }
    if (o.presetGuild && !guilds.some((g) => g.id === o.presetGuild)) {
      term.warn(s('guildMissing', { id: o.presetGuild }));
      await invite(o.presetGuild);
      wanted = undefined;
      o.presetGuild = undefined;
      continue;
    }
    const items = guilds.map((g) => ({ value: g.id, label: g.name }));
    items.push({ value: '', label: s('guildOther') });
    const def = Math.max(0, guilds.findIndex((g) => g.id === wanted));
    const id = await term.select(s('guildQ'), items, def, { id: 'guild' });
    if (!id) {
      await invite();
      continue;
    }
    guild = guilds.find((g) => g.id === id)!;
    break;
  }
  values.GUILD_ID = guild.id;

  // 6. Role.
  let roles: DiscordRole[] = [];
  for (;;) {
    try {
      roles = pickableRoles(await client.roles(guild.id), guild.id);
      break;
    } catch (e) {
      await retryOrAbort(w, e);
    }
  }
  const roleItems = roles.map((r) => ({ value: r.id, label: `@${r.name}` }));
  roleItems.push({ value: guild.id, label: s('roleEveryone') });
  const prevRole = o.presetRole ?? values.ROLE_ID;
  term.info(s('roleHelp'));
  values.ROLE_ID = await term.select(s('roleQ'), roleItems, Math.max(0, roleItems.findIndex((r) => r.value === prevRole)), { id: 'role' });

  // 7. Channels, grouped under their category.
  let channels: { channel: DiscordChannel; category: string | null }[] = [];
  for (;;) {
    try {
      channels = sortChannels(await client.channels(guild.id));
      break;
    } catch (e) {
      await retryOrAbort(w, e);
    }
  }
  if (!channels.length) throw new SetupAbort(s('channelsNone', { guild: guild.name }), 1);
  const prevChannels = (o.presetChannels ?? (values.CHANNEL_IDS ?? '').split(',')).map((c) => c.trim()).filter((c) => channels.some((x) => x.channel.id === c));
  term.info(s('channelsHelp'));
  const picked = await term.multiselect(s('channelsQ'), channels.map(({ channel, category }) => ({
    value: channel.id,
    label: category ? `${category} › #${channel.name}` : `#${channel.name}`,
  })), { min: 1, preselected: prevChannels, id: 'channels' });
  values.CHANNEL_IDS = picked.join(',');

  // 8. Command and group names.
  values.COMMAND_NAME = await term.text(s('commandQ'), {
    default: values.COMMAND_NAME || 'telinha',
    id: 'command',
    validate: (v) => (validCommand(v) ? null : s('commandBad')),
  });
  values.GROUP_NAME = await term.text(s('groupQ', { name: guild.name }), { default: values.GROUP_NAME || '', id: 'group' });
}

/** --no-discord-check: the ids are typed, nothing is looked up. */
export async function askDiscordOffline(w: Wizard, values: Values): Promise<void> {
  const { term, s } = w;
  term.step(s('discordTitle'));
  term.warn(s('discordOffline'));
  const snowflake = (v: string) => (SNOWFLAKE_RE.test(v) ? null : s('idBad'));
  values.DISCORD_TOKEN = await askSecret(w, { id: 'DISCORD_TOKEN', question: s('discordTokenQ'), current: values.DISCORD_TOKEN || undefined });
  values.DISCORD_CLIENT_ID = await term.text(s('clientIdQ'), { default: values.DISCORD_CLIENT_ID || undefined, validate: snowflake, required: true, id: 'client-id' });
  values.DISCORD_CLIENT_SECRET = await askSecret(w, { id: 'DISCORD_CLIENT_SECRET', question: s('secretQ'), current: values.DISCORD_CLIENT_SECRET || undefined });
  values.GUILD_ID = await term.text(s('guildIdQ'), { default: values.GUILD_ID || undefined, validate: snowflake, required: true, id: 'guild' });
  values.ROLE_ID = await term.text(s('roleIdQ'), { default: values.ROLE_ID || undefined, validate: snowflake, required: true, id: 'role' });
  values.CHANNEL_IDS = await term.text(s('channelIdsQ'), {
    default: values.CHANNEL_IDS || undefined,
    required: true,
    id: 'channels',
    validate: (v) => (v.split(',').map((c) => c.trim()).every((c) => SNOWFLAKE_RE.test(c)) ? null : s('idBad')),
  });
  values.COMMAND_NAME = await term.text(s('commandQ'), { default: values.COMMAND_NAME || 'telinha', id: 'command', validate: (v) => (validCommand(v) ? null : s('commandBad')) });
  values.GROUP_NAME = await term.text(s('groupQ', { name: '-' }), { default: values.GROUP_NAME || '', id: 'group' });
}

/**
 * Non-interactive: the same checks without questions. Fills the client id
 * from the token and switches the intents on; returns the problems found
 * (empty = all good). The redirect URI is only a warning (doctor re-checks).
 */
export async function checkDiscord(w: Wizard, values: Values, publicUrl: string): Promise<string[]> {
  const { term, s } = w;
  const client = w.deps.discord(values.DISCORD_TOKEN!);
  let app: DiscordApplication;
  try {
    app = await client.application();
  } catch (e) {
    return [e instanceof DiscordError && e.status === 401 ? s('discordTokenRejected') : s('discordUnreachable', { error: errMsg(e) })];
  }
  term.ok(s('discordBot', { name: app.name, id: app.id }));
  if (values.DISCORD_CLIENT_ID && values.DISCORD_CLIENT_ID !== app.id) term.warn(s('clientIdMismatch', { given: values.DISCORD_CLIENT_ID, id: app.id }));
  values.DISCORD_CLIENT_ID = app.id;
  const problems: string[] = [];
  if (!hasIntents(app.flags)) {
    try {
      app.flags = await client.enableLimitedIntents(app.flags);
    } catch (e) {
      term.warn(s('intentsApiFailed', { error: errMsg(e) }));
    }
    if (hasIntents(app.flags)) term.ok(s('intentsOn'));
    else term.warn(s('intentsGiveUp'));
  }
  try {
    if (!(await client.checkClientSecret(app.id, values.DISCORD_CLIENT_SECRET!))) problems.push(s('secretRejected'));
  } catch (e) {
    term.warn(s('secretUnchecked', { error: errMsg(e) }));
  }
  const redirect = `${publicUrl.replace(/\/$/, '')}/auth/callback`;
  if (!app.redirectUris.includes(redirect)) term.warn(s('redirectSkipped', { uri: redirect }));
  try {
    const guilds = await client.guilds();
    const guild = guilds.find((g) => g.id === values.GUILD_ID);
    if (!guild) {
      problems.push(s('guildMissingInvite', { id: values.GUILD_ID!, url: client.inviteUrl(app.id, values.GUILD_ID) }));
      return problems;
    }
    const roles = await client.roles(guild.id);
    if (values.ROLE_ID !== guild.id && !roles.some((r) => r.id === values.ROLE_ID)) problems.push(s('roleMissing', { id: values.ROLE_ID! }));
    const text = new Set(sortChannels(await client.channels(guild.id)).map((c) => c.channel.id));
    for (const c of (values.CHANNEL_IDS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!text.has(c)) problems.push(s('channelMissing', { id: c }));
    }
  } catch (e) {
    problems.push(s('discordUnreachable', { error: errMsg(e) }));
  }
  return problems;
}
