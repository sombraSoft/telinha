// Read-only checks the setup screens run while the questions are answered:
// the bot token, the client secret, the redirect, the server/role/channel
// lists, DuckDNS, the domain's A record and busy media ports. Each returns a
// LookupState; none writes anything except the DuckDNS update (it sets the
// record to the current IP, which the running service does anyway). Run ids
// let the session drop a result the user has moved on from.
import type { Ddns } from '../../ddns.ts';
import {
  type DiscordApplication,
  DiscordError,
  type DiscordRole,
  type DiscordSetup,
  hasIntents,
  sortChannels,
} from './discord.ts';
import type { Text } from './model.ts';
import type { QKey } from './qstrings.ts';

export type LookupId =
  | 'dns'
  | 'duckdns'
  | 'discordApp'
  | 'clientSecret'
  | 'redirect'
  | 'guilds'
  | 'roles'
  | 'channels'
  | 'ports';

/** What the lookups need; SetupDeps satisfies it. */
export interface LookupDeps {
  discord(token: string): DiscordSetup;
  ddns(o: { domain: string; token: string }): Ddns;
  resolveA(host: string): Promise<string[]>;
  portInUse(port: number): Promise<boolean>;
  udpFree(port: number): Promise<boolean>;
  openUrl(url: string): Promise<void>;
}

export type LookupState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; data?: unknown; note?: Text }
  /** Non-blocking: the answer is taken (a DNS mismatch, a busy port, a secret that could not be checked). */
  | { state: 'warn'; note: Text }
  /** The answer is wrong: stay on the question. */
  | { state: 'rejected'; error: Text }
  /** Not the answer's fault (network, Discord down): try again, or keep it where that is allowed. */
  | { state: 'error'; error: Text };

export type Channel = ReturnType<typeof sortChannels>[number];

/** What the Discord lookups found, for the question options; cleared when the token changes. */
export interface LookupCache {
  app?: DiscordApplication;
  guilds?: { id: string; name: string }[];
  roles?: Record<string, DiscordRole[]>;
  channels?: Record<string, Channel[]>;
}

const T = (key: QKey, params?: Record<string, string | number>): Text => (params ? { key, params } : { key });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const unreachable = (e: unknown): LookupState => ({
  state: 'error',
  error: T('discordUnreachable', { error: errMsg(e) }),
});

/** Increasing run ids: a result is used only while its id is still the newest. */
export class Runs {
  #n = 0;
  next(): number {
    return ++this.#n;
  }
  /** Makes every run started so far stale. */
  cancel(): void {
    this.#n++;
  }
  current(id: number): boolean {
    return id === this.#n;
  }
}

/** The bot token: the application behind it (its id is the client id). */
export async function checkToken(
  client: DiscordSetup,
): Promise<{ state: LookupState; app?: DiscordApplication; intentsOff?: boolean }> {
  try {
    const app = await client.application();
    return {
      state: { state: 'ok', data: app, note: T('discordBot', { name: app.name, id: app.id }) },
      app,
      intentsOff: !hasIntents(app.flags),
    };
  } catch (e) {
    if (e instanceof DiscordError && e.status === 401)
      return { state: { state: 'rejected', error: T('discordTokenRejected') } };
    return { state: unreachable(e) };
  }
}

/** A client_credentials grant; an answer that is not a yes or a no keeps the secret (it is checked again at install). */
export async function checkSecret(client: DiscordSetup, appId: string, secret: string): Promise<LookupState> {
  try {
    return (await client.checkClientSecret(appId, secret))
      ? { state: 'ok', note: T('secretOk') }
      : { state: 'rejected', error: T('secretRejected') };
  } catch (e) {
    return { state: 'warn', note: T('secretUnchecked', { error: errMsg(e) }) };
  }
}

/** Reads the app again: the redirect is only added by hand on Discord's site. */
export async function checkRedirect(
  client: DiscordSetup,
  uri: string,
): Promise<{ state: LookupState; app?: DiscordApplication }> {
  try {
    const app = await client.application();
    return app.redirectUris.includes(uri)
      ? { state: { state: 'ok', note: T('redirectOk') }, app }
      : { state: { state: 'warn', note: T('redirectMissing') }, app };
  } catch (e) {
    return { state: unreachable(e) };
  }
}

export async function loadGuilds(
  client: DiscordSetup,
): Promise<{ state: LookupState; guilds?: { id: string; name: string }[] }> {
  try {
    const guilds = await client.guilds();
    return { state: guilds.length ? { state: 'ok', data: guilds } : { state: 'warn', note: T('guildNone') }, guilds };
  } catch (e) {
    return { state: unreachable(e) };
  }
}

export async function loadRoles(
  client: DiscordSetup,
  guildId: string,
): Promise<{ state: LookupState; roles?: DiscordRole[] }> {
  try {
    const roles = await client.roles(guildId);
    return { state: { state: 'ok', data: roles }, roles };
  } catch (e) {
    return { state: unreachable(e) };
  }
}

/** Text channels in Discord's order; none at all is a dead end until the bot gets access to one. */
export async function loadChannels(
  client: DiscordSetup,
  guildId: string,
  guildName: string,
): Promise<{ state: LookupState; channels?: Channel[] }> {
  try {
    const channels = sortChannels(await client.channels(guildId));
    return {
      state: channels.length
        ? { state: 'ok', data: channels }
        : { state: 'rejected', error: T('channelsNone', { guild: guildName }) },
      channels,
    };
  } catch (e) {
    return { state: unreachable(e) };
  }
}

/** Points the name at this network now; an empty ip lets DuckDNS take the caller's address. */
export async function updateDuckDns(
  deps: Pick<LookupDeps, 'ddns'>,
  domain: string,
  token: string,
  ip: string | null,
): Promise<LookupState> {
  const ddns = deps.ddns({ domain, token });
  await ddns.update(ip ?? '');
  const last = ddns.last();
  const name = `${domain}.duckdns.org`;
  return last?.ok
    ? { state: 'ok', note: T('duckOk', { name, ip: ip ?? '?' }) }
    : { state: 'error', error: T('duckFailed', { error: last?.error ?? '?' }) };
}

/** The domain's A record against the public IP; advice only, never blocking. */
export async function checkDns(
  deps: Pick<LookupDeps, 'resolveA'>,
  host: string,
  ip: string | null,
): Promise<LookupState> {
  let ips: string[] = [];
  try {
    ips = await deps.resolveA(host);
  } catch {
    // NXDOMAIN or no resolver: same advice as a wrong record
  }
  const now = ips.join(', ');
  if (ip && ips.includes(ip)) return { state: 'ok', note: T('dnsOk', { host, ip }) };
  if (ip) return { state: 'warn', note: now ? T('dnsWrong', { host, ip, now }) : T('dnsWrongNone', { host, ip }) };
  return now
    ? { state: 'ok', note: T('dnsUnknown', { host, now }) }
    : { state: 'warn', note: T('dnsUnknownNone', { host }) };
}

/** Something else on the media port; a warning only (it may be Telinha itself). */
export async function checkPort(
  deps: Pick<LookupDeps, 'portInUse' | 'udpFree'>,
  proto: 'TCP' | 'UDP',
  port: number,
): Promise<LookupState> {
  const busy =
    proto === 'TCP' ? await deps.portInUse(port).catch(() => false) : !(await deps.udpFree(port).catch(() => true));
  return busy ? { state: 'warn', note: T('mediaBusy', { proto, port }) } : { state: 'ok' };
}
