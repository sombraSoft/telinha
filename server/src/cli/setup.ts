// `telinha setup`: the questions that make telinha.env, then (natively) the
// binaries, the service, the router probe and doctor. Interactive on a TTY;
// `--non-interactive` takes every answer from flags, the environment and the
// existing file (secrets never from flags); `--docker` runs inside the image
// and only writes the file.
import { constants as fsc, existsSync } from 'node:fs';
import { chmod, copyFile, lchown, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { arch as osArch } from 'node:os';
import { posix } from 'node:path';
import { ensureBinariesForConfig } from '../bins.ts';
import { portInUse } from '../children.ts';
import type { Config } from '../config.ts';
import { createDuckDns } from '../ddns.ts';
import { mergeEnv, parseEnvFile } from '../envfile.ts';
import { probe } from '../nat/index.ts';
import { lookupPublicIp, resolveA, tlsInfo } from '../netinfo.ts';
import { defaultSpawn, serviceManager } from '../service/index.ts';
import { assertOneStdin, GLOBAL_FLAGS, parseArgs, readSecretSource, UsageError, type ArgSpec, type CliContext, type ParsedArgs } from './args.ts';
import { createControlClient } from './control.ts';
import { checkDiscord, askDiscord, askDiscordOffline, createDiscordSetup, SNOWFLAKE_RE, validCommand } from './setup/discord.ts';
import { askAddress, DEFAULT_HOME_HTTPS_PORT, extractTunnelToken, homeChoice, parseDuckDomain, takenPort, validTunnelToken } from './setup/domain.ts';
import { MANAGED_KEYS, type PreviousEnv } from './setup/envwrite.ts';
import { defaultOsName, detectHost, inferHosting, routerLabel, SSLIP_RE, type HostInfo, type Hosting } from './setup/host.ts';
import {
  askMediaPorts, downloadBinaries, generateSecrets, nextSteps, review, routerStep, serviceStep, SetupAbort, startAndDoctor,
  validateValues, writeConfig, type SetupDeps, type SetupFs, type Values, type Wizard,
} from './setup/steps.ts';
import { t, type SKey } from './setup/strings.ts';
import { ts, type Locale, type Params } from './strings.ts';
import { createTerm, NeedsInputError, type Term } from './term.ts';

export type { SetupDeps } from './setup/steps.ts';

export const SETUP_FLAGS = {
  docker: 'boolean',
  host: 'string',
  'public-url': 'string',
  ingress: 'string',
  advanced: 'boolean',
  'http-port': 'string',
  'https-port': 'string',
  'tunnel-token-file': 'string',
  'duckdns-domain': 'string',
  'duckdns-token-file': 'string',
  'media-tcp': 'string',
  'media-udp': 'string',
  'node-ip': 'string',
  'discord-token-file': 'string',
  'client-secret-file': 'string',
  'client-id': 'string',
  guild: 'string',
  role: 'string',
  channels: 'string',
  command: 'string',
  group: 'string',
  upnp: 'string',
  'auto-update': 'string',
  'no-service': 'boolean',
  'no-firewall': 'boolean',
  'no-upnp': 'boolean',
  'no-doctor': 'boolean',
  'no-discord-check': 'boolean',
} as const;
export const SETUP_SPEC = { flags: { ...GLOBAL_FLAGS, ...SETUP_FLAGS } } as const satisfies ArgSpec;
type Flags = ParsedArgs<typeof SETUP_SPEC>['flags'];

/** Secrets: telinha.env key, its -file flag. */
const SECRETS = [
  ['DISCORD_TOKEN', 'discord-token-file'],
  ['DISCORD_CLIENT_SECRET', 'client-secret-file'],
  ['TUNNEL_TOKEN', 'tunnel-token-file'],
  ['DUCKDNS_TOKEN', 'duckdns-token-file'],
] as const;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function nodeFs(): SetupFs {
  return {
    mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
    async createFile(path, data, o) {
      // O_NOFOLLOW does not exist on Windows (and is 0 there in Node's constants).
      const fh = await open(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), o.mode);
      try {
        if (process.platform !== 'win32') {
          // open's mode went through the umask.
          await fh.chmod(o.mode);
          if (o.uid !== undefined && o.gid !== undefined) await fh.chown(o.uid, o.gid);
        }
        await fh.writeFile(data);
      } finally {
        await fh.close();
      }
    },
    rename: (from, to) => rename(from, to),
    chmod: (path, mode) => chmod(path, mode),
    chown: (path, uid, gid) => lchown(path, uid, gid),
    async stat(path) {
      try {
        const st = await lstat(path);
        return { uid: st.uid, gid: st.gid, mode: st.mode, dir: st.isDirectory(), symlink: st.isSymbolicLink() };
      } catch {
        return null;
      }
    },
    rm: (path) => rm(path, { force: true }),
    async readText(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    exists: (path) => stat(path).then(() => true, () => false),
    // Exclusive: never through a symlink someone planted at the target.
    copyFile: (from, to) => copyFile(from, to, fsc.COPYFILE_EXCL),
  };
}

/** A UDP bind test: the port is free when nothing holds it. */
async function udpFree(port: number): Promise<boolean> {
  try {
    const sock = await Bun.udpSocket({ port });
    sock.close();
    return true;
  } catch {
    return false;
  }
}

async function openUrl(url: string, platform: NodeJS.Platform): Promise<void> {
  // rundll32 hands the URL to the default browser without cmd's & parsing.
  const cmd = platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
  const proc = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} exited with ${proc.exitCode}`);
}

export function defaultDeps(ctx: CliContext, o: { tty: boolean }): SetupDeps {
  const platform = process.platform;
  const isRoot = process.getuid?.() === 0;
  return {
    term: (locale) => createTerm({ tty: o.tty, yes: ctx.yes, locale }),
    fetch,
    nat: { probe: () => probe() },
    ddns: ({ domain, token }) => createDuckDns({ domain, token, fetch, log: () => {} }),
    discord: (token) => createDiscordSetup({ token, fetch, version: ctx.version }),
    serviceManager: ({ user }) => serviceManager({ platform, isRoot, user, paths: ctx.paths, envFile: ctx.envFile, env: ctx.env }),
    control: createControlClient({ paths: ctx.paths, envFile: ctx.envFile, env: ctx.env }),
    bins: (config, paths, log) => ensureBinariesForConfig(config, paths, log),
    spawn: defaultSpawn,
    spawnInteractive: async (cmd) => {
      try {
        return (await Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] }).exited) ?? 1;
      } catch {
        return 127;
      }
    },
    openUrl: (url) => openUrl(url, platform),
    fs: nodeFs(),
    platform,
    arch: osArch(),
    isRoot,
    osName: () => defaultOsName(platform),
    existsSync,
    lookupPublicIp: () => lookupPublicIp(fetch, 5000),
    resolveA: (host) => resolveA(host),
    portInUse,
    udpFree,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    // Imported on use: doctor pulls in the checks and the QR renderer.
    doctor: async (c) => (await import('./doctor.ts')).run({ flags: {}, positionals: c.argv.slice(1), rest: [] }, c),
    execPath: process.execPath,
    which: (cmd) => Bun.which(cmd),
    certReady: async (host, port) => (await tlsInfo(host, port, 5000, '127.0.0.1')).authorized,
  };
}

function makeWizard(ctx: CliContext, deps: SetupDeps, locale: Locale, host: HostInfo, o: { interactive: boolean; docker: boolean; term?: Term }): Wizard {
  return {
    ctx,
    deps,
    term: o.term ?? deps.term(locale),
    locale,
    s: (key: SKey, params?: Params) => t(locale, key, params),
    keepCurrent: ts(locale, 'keepCurrent'),
    host,
    interactive: o.interactive,
    docker: o.docker,
  };
}

/** Managed keys from the file, overridden by the environment (the rule `run` applies). */
function currentValues(fileVars: Record<string, string>, env: Record<string, string | undefined>): Values {
  const merged = mergeEnv(fileVars, Object.fromEntries(MANAGED_KEYS.map((k) => [k, env[k]])));
  return Object.fromEntries(MANAGED_KEYS.filter((k) => merged[k]).map((k) => [k, merged[k]!]));
}

function hostLine(w: Wizard): string {
  const h = w.host;
  const parts = [h.docker ? `${h.osName} (Docker)` : h.osName, h.arch];
  parts.push(h.publicIp ? w.s('hostPublicIp', { ip: h.publicIp }) : w.s('hostNoPublicIp'));
  const router = h.nat && routerLabel(h.nat);
  const line = w.s('hostLine', { what: parts.join(', ') });
  return router ? `${line} ${w.s('hostRouter', { router })}` : line;
}

async function detect(ctx: CliContext, deps: SetupDeps, docker: boolean): Promise<HostInfo> {
  return detectHost({
    platform: deps.platform,
    arch: deps.arch,
    isRoot: deps.isRoot,
    env: ctx.env,
    dockerFlag: docker,
    exists: deps.existsSync,
    osName: deps.osName,
    lookupPublicIp: deps.lookupPublicIp,
    probe: () => deps.nat.probe(),
  });
}

/** Where the file is, as its reader sees it: inside the image, the host's path (install-docker.sh passes it). */
interface Loaded { file: string; shown: string; previous: PreviousEnv | null; values: Values }

/** install-docker.sh's layout, for an image run without TELINHA_HOST_ENV. */
const DOCKER_HOST_ENV = '/opt/telinha/config/telinha.env';

async function load(ctx: CliContext, deps: SetupDeps, docker: boolean): Promise<Loaded> {
  // Inside the image only the mounted config dir is the host's.
  const file = docker ? posix.join(ctx.paths.config, 'telinha.env') : ctx.envFile;
  const text = await deps.fs.readText(file);
  const previous = text === null ? null : { vars: parseEnvFile(text).vars, text };
  const shown = docker ? ctx.env.TELINHA_HOST_ENV || DOCKER_HOST_ENV : file;
  return { file, shown, previous, values: currentValues(previous?.vars ?? {}, ctx.env) };
}

/** Validates, renders and writes; a config loadConfig rejects is never written. */
async function save(w: Wizard, l: Loaded, values: Values) {
  const { text, config } = validateValues(values, l.previous, w.ctx.paths.home, { compiled: w.ctx.compiled });
  await writeConfig(w, l.file, text, l.shown);
  return config;
}

/** Steps 8-11: everything after the file, natively. */
async function afterWrite(w: Wizard, l: Loaded, values: Values, config: Pick<Config, 'media' | 'ingress'>, flags: Flags, hosting: Hosting): Promise<number> {
  await downloadBinaries(w, config);
  const wasRunning = await w.deps.control.available().catch(() => false);
  let installed = false;
  if (!flags['no-service']) installed = await serviceStep(w, values, { firewall: !flags['no-firewall'] });
  if (!flags['no-upnp']) await routerStep(w, values, hosting);
  const code = await startAndDoctor(w, { installed, wasRunning, doctor: !flags['no-doctor'], values });
  nextSteps(w, values, { file: l.shown });
  return code;
}

async function interactive(ctx: CliContext, deps: SetupDeps, flags: Flags): Promise<number> {
  const docker = !!flags.docker;
  const l = await load(ctx, deps, docker);
  const values = l.values;
  // Flags given next to a TTY become the defaults of their questions.
  const pre = await collectNonInteractive(ctx, flags, values);
  if (pre.errors.length) {
    for (const e of pre.errors) ctx.stderr(e);
    return 2;
  }
  let locale = ctx.locale;
  let term = deps.term(locale);
  term.line(term.style.bold(t(locale, 'welcome')));
  for (const line of t(locale, 'welcomeHelp', { file: l.shown }).split('\n')) term.info(line);

  // 1. Language: asked once, then LOCALE remembers it.
  if (flags.lang) {
    values.LOCALE = locale;
  } else if (!values.LOCALE) {
    locale = await term.select<Locale>('Language / Idioma', [
      { value: 'en', label: 'English' },
      { value: 'pt-BR', label: 'Português (Brasil)' },
    ], locale === 'pt-BR' ? 1 : 0, { id: 'lang' });
    values.LOCALE = locale;
  }

  // 2. The machine.
  const spin = term.spinner(t(locale, 'hostChecking'));
  const host = await detect(ctx, deps, docker);
  spin.stop(t(locale, 'hostChecked'));
  // One terminal for the whole run (keys typed ahead stay buffered); a new one only for a new language.
  const w = makeWizard(ctx, deps, locale, host, { interactive: true, docker, term: locale === ctx.locale ? term : undefined });
  term = w.term;
  const { s } = w;
  term.info(hostLine(w));
  // 3. Home or a rented server: the machine only suggests, the file's answer wins.
  const hostings: { value: Hosting; label: string; hint: string }[] = [
    { value: 'home', label: s('hostingHome'), hint: s('hostingHomeHint') },
    { value: 'vps', label: s('hostingVps'), hint: s('hostingVpsHint') },
  ];
  term.step(s('hostingTitle'));
  const guessed = inferHosting(values, host);
  const hosting = await term.select(s('hostingQ'), hostings, hostings.findIndex((x) => x.value === guessed), { id: 'hosting' });

  // 4-6. Address, media ports, Discord.
  await askAddress(w, values, hosting, { httpsPort: flags['https-port'] });
  await askMediaPorts(w, values);
  if (flags['no-discord-check']) await askDiscordOffline(w, values);
  else await askDiscord(w, values, { publicUrl: values.PUBLIC_URL!, presetGuild: flags.guild, presetRole: flags.role, presetChannels: flags.channels?.split(',') });

  // Updates are the native binary's business; Docker has telinha-update.
  if (ctx.compiled && !docker) {
    term.step(s('updatesTitle'));
    term.info(s('updatesHelp'));
    values.AUTO_UPDATE = (await term.confirm(s('autoUpdateQ'), values.AUTO_UPDATE !== 'off', { id: 'auto-update' })) ? 'on' : 'off';
  }

  // 6-7. Secrets, review, write.
  const made = generateSecrets(values, deps.random);
  if (await review(w, values, { made, previous: l.previous })) generateSecrets(values, deps.random, true);
  const config = await save(w, l, values);
  if (docker) {
    nextSteps(w, values, { file: l.shown });
    return 0;
  }
  return afterWrite(w, l, values, config, flags, hosting);
}

/** The hostname of a URL; '' when it does not parse. */
function urlHost(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
}

/** host:port of a URL for comparing; '' when it does not parse. */
function urlOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '443'}`;
  } catch {
    return '';
  }
}

/**
 * Answers from flags over the environment over the file; returns what is
 * missing and what is wrong. `o.host`, the detected machine, comes with a
 * non-interactive run: it settles home vs VPS and enforces the home rules
 * (no 80/443 without --advanced). The interactive pre-pass passes none: there
 * the flags are the questions' defaults and the questions decide.
 */
export async function collectNonInteractive(ctx: CliContext, flags: Flags, values: Values, o: { stdin?: () => Promise<string>; host?: HostInfo } = {}): Promise<{ missing: string[]; errors: string[] }> {
  const s = (key: SKey, params?: Params) => t(ctx.locale, key, params);
  const errors: string[] = [];
  // The file as loaded, before any flag lands: a re-run on the same path keeps
  // its ports and an advanced home file counts as confirmed; a switch starts
  // from the new path's defaults.
  const before: Values = { ...values };
  const was = {
    advanced: homeChoice(before) === 'advanced',
    highPort: before.ACME_DNS === 'duckdns',
    vps: before.HOSTING === 'vps',
    vpsDirect: before.HOSTING === 'vps' && (before.INGRESS || 'direct') === 'direct',
    ingress: before.INGRESS || 'direct',
  };
  const set = (key: string, v: string | undefined) => {
    if (v !== undefined) values[key] = v.trim();
  };
  const oneOf = (flag: string, v: string | undefined, allowed: string[]) => {
    if (v !== undefined && !allowed.includes(v)) errors.push(s('badFlagValue', { flag: `--${flag}`, value: v, allowed: allowed.join(' | ') }));
    return v;
  };
  const port = (flag: string, key: string, v: string | undefined) => {
    if (v === undefined) return;
    if (!/^\d+$/.test(v) || Number(v) > 65535) errors.push(s('badFlagValue', { flag: `--${flag}`, value: v, allowed: '0-65535' }));
    values[key] = v;
  };

  set('HOSTING', oneOf('host', flags.host, ['home', 'vps']));
  set('PUBLIC_URL', flags['public-url']?.replace(/\/$/, ''));
  set('INGRESS', oneOf('ingress', flags.ingress, ['direct', 'tunnel', 'external']));
  port('http-port', 'HTTP_PORT', flags['http-port']);
  port('https-port', 'HTTPS_PORT', flags['https-port']);
  port('media-tcp', 'MEDIA_TCP_PORT', flags['media-tcp']);
  port('media-udp', 'MEDIA_UDP_PORT', flags['media-udp']);
  set('LIVEKIT_NODE_IP', flags['node-ip']);
  set('DISCORD_CLIENT_ID', flags['client-id']);
  set('GUILD_ID', flags.guild);
  set('ROLE_ID', flags.role);
  set('CHANNEL_IDS', flags.channels?.split(',').map((c) => c.trim()).filter(Boolean).join(','));
  set('COMMAND_NAME', flags.command);
  set('GROUP_NAME', flags.group);
  set('UPNP', oneOf('upnp', flags.upnp, ['auto', 'off']));
  set('AUTO_UPDATE', oneOf('auto-update', flags['auto-update'], ['on', 'off']));
  if (flags.lang) values.LOCALE = ctx.locale;
  if (flags['duckdns-domain'] !== undefined) {
    const d = parseDuckDomain(flags['duckdns-domain']);
    if (!d) errors.push(s('badFlagValue', { flag: '--duckdns-domain', value: flags['duckdns-domain'], allowed: 'a-z 0-9 -' }));
    else {
      values.DDNS_PROVIDER = 'duckdns';
      values.DUCKDNS_DOMAIN = d;
      if (!flags['public-url']) values.PUBLIC_URL = `https://${d}.duckdns.org`;
      // DuckDNS lives in direct mode only: a tunnel or proxy file switching to it becomes direct.
      if (flags.ingress === undefined) values.INGRESS = 'direct';
      else if (flags.ingress === 'tunnel' || flags.ingress === 'external') {
        errors.push(s('badFlagValue', { flag: '--ingress', value: flags.ingress, allowed: 'direct (with --duckdns-domain)' }));
      }
      // At home the name means the high port unless --advanced says 80/443 (the
      // interactive pre-pass reads this as the "no domain on Cloudflare" default).
      if (!flags.advanced) values.ACME_DNS = 'duckdns';
    }
  }

  assertOneStdin(SECRETS.map(([, f]) => flags[f]), ctx.locale);
  for (const [key, fileFlag] of SECRETS) {
    const v = await readSecretSource({ env: ctx.env[key], file: flags[fileFlag], stdin: o.stdin });
    if (v) values[key] = v;
  }
  // The dashboard's install command, pasted whole into the file, still works.
  if (values.TUNNEL_TOKEN) values.TUNNEL_TOKEN = extractTunnelToken(values.TUNNEL_TOKEN);
  // A --public-url on another host leaves DuckDNS: its keys go, or the updater
  // keeps writing the old name and the rules below take the file's name as given.
  if (flags['public-url'] !== undefined && flags['duckdns-domain'] === undefined && values.DUCKDNS_DOMAIN && urlHost(values.PUBLIC_URL) !== `${values.DUCKDNS_DOMAIN}.duckdns.org`) {
    values.DDNS_PROVIDER = values.DUCKDNS_DOMAIN = values.DUCKDNS_TOKEN = values.ACME_DNS = '';
  }
  // A switch to a tunnel or a proxy needs that path's own address: the old one
  // (a DuckDNS name, an IP) is not what Cloudflare or the proxy serves.
  if ((values.INGRESS === 'tunnel' || values.INGRESS === 'external') && values.INGRESS !== was.ingress && flags['public-url'] === undefined) values.PUBLIC_URL = '';
  // Where it runs: --host or HOSTING, else the VPS-only keys (the file's or the
  // flags', read before the node IP below may go), else the machine.
  const hosting = o.host ? inferHosting(values, o.host) : null;
  // A pinned IP belongs to sslip.io: switching away (or to DuckDNS, which follows
  // the IP) without --node-ip drops it, or DuckDNS and LiveKit keep a stale one.
  const modeChanged = flags.ingress !== undefined || flags['duckdns-domain'] !== undefined || flags['public-url'] !== undefined;
  if (flags['node-ip'] === undefined && (modeChanged || values.DDNS_PROVIDER === 'duckdns') && !SSLIP_RE.test(values.PUBLIC_URL ?? '')) {
    values.LIVEKIT_NODE_IP = '';
  }

  const ingress = values.INGRESS || 'direct';
  if (hosting) {
    values.HOSTING = hosting;
    values.INGRESS = ingress;
    if (hosting === 'home') {
      // A plain re-run of an advanced home file (--guild, a new token) is already
      // confirmed; a run that changes the address or the ports must say so again.
      const advanced = flags.advanced || (was.advanced && !modeChanged && flags['https-port'] === undefined && flags['http-port'] === undefined);
      if (ingress === 'direct' && values.DUCKDNS_DOMAIN && !advanced) {
        // Home connections block 80/443: HTTPS on a high port that the URL carries, the certificate through the DuckDNS API.
        const https = flags['https-port'] ?? (was.highPort ? before.HTTPS_PORT || undefined : undefined) ?? DEFAULT_HOME_HTTPS_PORT;
        const taken = takenPort(values, Number(https));
        if (Number(https) < 1024 || (flags['http-port'] !== undefined && flags['http-port'] !== '0')) errors.push(s('homeNeedsAdvanced'));
        else if (taken) errors.push(s('badFlagValue', { flag: '--https-port', value: https, allowed: `1024-65535, != ${taken}` }));
        const url = `https://${values.DUCKDNS_DOMAIN}.duckdns.org:${https}`;
        if (flags['public-url'] !== undefined && urlOrigin(values.PUBLIC_URL ?? '') !== urlOrigin(url)) {
          errors.push(s('badFlagValue', { flag: '--public-url', value: flags['public-url'], allowed: url }));
        }
        values.HTTPS_PORT = https;
        values.HTTP_PORT = '0';
        values.ACME_DNS = 'duckdns';
        values.DDNS_PROVIDER = 'duckdns';
        values.PUBLIC_URL = url;
      } else if (ingress !== 'tunnel' && !advanced) {
        // Direct without DuckDNS or an own proxy: both lean on 80/443 or on the user's own setup.
        errors.push(s('homeNeedsAdvanced'));
      } else if (ingress === 'direct') {
        // Confirmed: the certificate comes over 80/443 (or the ports given), as on a VPS.
        values.HTTPS_PORT = flags['https-port'] ?? ((was.advanced && values.HTTPS_PORT) || '443');
        values.HTTP_PORT = flags['http-port'] ?? ((was.advanced && values.HTTP_PORT) || '80');
        values.ACME_DNS = '';
        if (values.DUCKDNS_DOMAIN && flags['public-url'] === undefined) values.PUBLIC_URL = `https://${values.DUCKDNS_DOMAIN}.duckdns.org`;
      }
    } else if (ingress === 'direct') {
      // A VPS has 80/443: the certificate comes over them, DuckDNS included.
      values.HTTPS_PORT = flags['https-port'] ?? ((was.vpsDirect && values.HTTPS_PORT) || '443');
      values.HTTP_PORT = flags['http-port'] ?? ((was.vpsDirect && values.HTTP_PORT) || '80');
      values.ACME_DNS = '';
      if (values.DUCKDNS_DOMAIN && flags['public-url'] === undefined) values.PUBLIC_URL = `https://${values.DUCKDNS_DOMAIN}.duckdns.org`;
    }
  }
  if (flags.upnp === undefined) {
    // A VPS has no router to ask; at home the media ports (and the HTTPS port) need it.
    // The VPS path wrote off by itself, so a VPS file moving home starts from auto again
    // (the interactive pre-pass too: --host home makes it the question's default).
    const leftVps = was.vps && (hosting ?? values.HOSTING) === 'home' && ctx.env.UPNP === undefined;
    if (hosting === 'vps') values.UPNP = 'off';
    else if (leftVps) values.UPNP = 'auto';
    else if (hosting) values.UPNP = values.UPNP || 'auto';
  }

  // Keys the chosen mode does not use go away (a re-run may switch modes).
  if (ingress !== 'tunnel') values.TUNNEL_TOKEN = '';
  if (ingress !== 'direct') values.DDNS_PROVIDER = values.DUCKDNS_DOMAIN = values.DUCKDNS_TOKEN = values.HTTP_PORT = values.HTTPS_PORT = values.ACME_DNS = '';
  if (values.ACME_DNS !== 'duckdns') values.ACME_DNS = '';
  if (values.COMMAND_NAME && !validCommand(values.COMMAND_NAME)) errors.push(s('commandBad'));
  if (values.TUNNEL_TOKEN && !validTunnelToken(values.TUNNEL_TOKEN)) errors.push(s('tunnelTokenBad'));
  for (const [key, flag] of [['DISCORD_CLIENT_ID', 'client-id'], ['GUILD_ID', 'guild'], ['ROLE_ID', 'role']] as const) {
    if (values[key] && !SNOWFLAKE_RE.test(values[key]!)) errors.push(s('badFlagValue', { flag: `--${flag}`, value: values[key]!, allowed: s('idAllowed') }));
  }
  if (values.CHANNEL_IDS && !values.CHANNEL_IDS.split(',').every((c) => SNOWFLAKE_RE.test(c))) {
    errors.push(s('badFlagValue', { flag: '--channels', value: values.CHANNEL_IDS, allowed: s('idAllowed') }));
  }

  const missing: string[] = [];
  const need = (key: string, what: string) => {
    if (!values[key]) missing.push(what);
  };
  const secret = (key: string, flag: string) => s('missingSecret', { env: key, flag: `--${flag}` });
  need('PUBLIC_URL', '--public-url');
  need('DISCORD_TOKEN', secret('DISCORD_TOKEN', 'discord-token-file'));
  need('DISCORD_CLIENT_SECRET', secret('DISCORD_CLIENT_SECRET', 'client-secret-file'));
  if (flags['no-discord-check']) need('DISCORD_CLIENT_ID', '--client-id');
  need('GUILD_ID', '--guild');
  need('ROLE_ID', '--role');
  need('CHANNEL_IDS', '--channels');
  if (ingress === 'tunnel') need('TUNNEL_TOKEN', secret('TUNNEL_TOKEN', 'tunnel-token-file'));
  // The same token serves the DNS record and the certificate.
  if (values.DDNS_PROVIDER === 'duckdns' || values.ACME_DNS === 'duckdns') need('DUCKDNS_TOKEN', secret('DUCKDNS_TOKEN', 'duckdns-token-file'));
  return { missing, errors };
}

async function nonInteractive(ctx: CliContext, deps: SetupDeps, flags: Flags, o: { stdin?: () => Promise<string> }): Promise<number> {
  const docker = !!flags.docker;
  const l = await load(ctx, deps, docker);
  const values = l.values;
  // The machine first: without --host it is what tells home from VPS.
  const host = await detect(ctx, deps, docker);
  const { missing, errors } = await collectNonInteractive(ctx, flags, values, { ...o, host });
  if (errors.length || missing.length) {
    for (const e of errors) ctx.stderr(e);
    if (missing.length) ctx.stderr(t(ctx.locale, 'missing', { list: missing.join(', ') }));
    return 2;
  }
  const w = makeWizard(ctx, deps, ctx.locale, host, { interactive: false, docker });
  const { term, s } = w;
  term.info(hostLine(w));

  if (!flags['no-discord-check']) {
    term.step(s('discordTitle'));
    const problems = await checkDiscord(w, values, values.PUBLIC_URL!);
    if (problems.length) {
      for (const p of problems) term.fail(p);
      return 1;
    }
  }
  if (values.DDNS_PROVIDER === 'duckdns') {
    const ddns = deps.ddns({ domain: values.DUCKDNS_DOMAIN!, token: values.DUCKDNS_TOKEN! });
    await ddns.update(host.publicIp ?? '');
    const last = ddns.last();
    if (!last?.ok) {
      term.fail(s('duckFailed', { error: last?.error ?? '?' }));
      return 1;
    }
    term.ok(s('duckOk', { name: `${values.DUCKDNS_DOMAIN}.duckdns.org`, ip: host.publicIp ?? '?' }));
  }
  generateSecrets(values, deps.random);
  let config;
  try {
    config = await save(w, l, values);
  } catch (e) {
    term.fail(s('configInvalid', { error: errMsg(e) }));
    return 1;
  }
  if (docker) {
    nextSteps(w, values, { file: l.shown });
    return 0;
  }
  return afterWrite(w, l, values, config, flags, inferHosting(values, host));
}

export async function run(_args: ParsedArgs, ctx: CliContext, deps: Partial<SetupDeps> = {}, o: { stdin?: () => Promise<string> } = {}): Promise<number> {
  let flags: Flags;
  try {
    flags = parseArgs(ctx.argv, SETUP_SPEC, { locale: ctx.locale }).flags;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.stderr(e.message);
    ctx.stderr(ts(ctx.locale, 'helpSetup'));
    return 2;
  }
  // ctx.tty is false with --non-interactive or without a terminal.
  const isInteractive = ctx.tty && !flags['non-interactive'];
  const d: SetupDeps = { ...defaultDeps(ctx, { tty: isInteractive }), ...deps };
  try {
    return isInteractive ? await interactive(ctx, d, flags) : await nonInteractive(ctx, d, flags, o);
  } catch (e) {
    if (e instanceof UsageError) {
      ctx.stderr(e.message);
      return 2;
    }
    if (e instanceof NeedsInputError) {
      ctx.stderr(t(ctx.locale, 'missing', { list: e.questionId }));
      return 2;
    }
    if (e instanceof SetupAbort) {
      ctx.stderr(e.message);
      return e.code;
    }
    ctx.stderr(t(ctx.locale, 'failed', { error: errMsg(e) }));
    return 1;
  }
}

/**
 * `telinha` with no arguments on a TTY and no telinha.env: offer the wizard.
 * Resolves with setup's exit code, or null when the user declined.
 */
export async function offerSetup(ctx: CliContext, deps: Partial<SetupDeps> = {}): Promise<number | null> {
  const term = (deps.term ?? ((locale: Locale) => createTerm({ tty: ctx.tty, yes: ctx.yes, locale })))(ctx.locale);
  term.warn(ts(ctx.locale, 'noConfig', { path: ctx.envFile }));
  if (!(await term.confirm(ts(ctx.locale, 'offerSetup'), true, { id: 'setup' }))) return null;
  return run({ flags: {}, positionals: ['setup'], rest: [] }, { ...ctx, argv: ['setup'] }, deps);
}
