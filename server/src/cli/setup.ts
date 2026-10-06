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
import { askIngress, extractTunnelToken, parseDuckDomain, validTunnelToken, type Target } from './setup/domain.ts';
import { MANAGED_KEYS, type PreviousEnv } from './setup/envwrite.ts';
import { defaultOsName, detectHost, guessTarget, routerLabel, type HostInfo } from './setup/host.ts';
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
  'public-url': 'string',
  ingress: 'string',
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

const SSLIP_RE = /\.sslip\.io(:\d+)?\/?$/;
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

/** The re-run's (or the non-interactive run's) idea of where Telinha runs. */
function inferTarget(values: Values, host: HostInfo): Target {
  if (values.LIVEKIT_NODE_IP || SSLIP_RE.test(values.PUBLIC_URL ?? '')) return 'vps';
  if (values.INGRESS === 'tunnel') return 'cloudflare';
  return guessTarget(host);
}

/** Steps 8-11: everything after the file, natively. */
async function afterWrite(w: Wizard, l: Loaded, values: Values, config: Pick<Config, 'media' | 'ingress'>, flags: Flags, target: Target): Promise<number> {
  await downloadBinaries(w, config);
  const wasRunning = await w.deps.control.available().catch(() => false);
  let installed = false;
  if (!flags['no-service']) {
    installed = await serviceStep(w, values, {
      firewall: !flags['no-firewall'],
      rewrite: async (v) => void (await save(w, l, v)),
    });
  }
  if (!flags['no-upnp']) await routerStep(w, values, target);
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
  const guessed = inferTarget(values, host);
  const targets: { value: Target; label: string; hint: string }[] = [
    { value: 'home', label: s('targetHome'), hint: s('targetHomeHint') },
    { value: 'vps', label: s('targetVps'), hint: s('targetVpsHint') },
    { value: 'cloudflare', label: s('targetCloudflare'), hint: s('targetCloudflareHint') },
  ];
  term.step(s('targetTitle'));
  const target = await term.select(s('targetQ'), targets, targets.findIndex((x) => x.value === guessed), { id: 'target' });

  // 3-5. Ingress, media ports, Discord.
  await askIngress(w, values, target);
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
  return afterWrite(w, l, values, config, flags, target);
}

/** Answers from flags over the environment over the file; returns what is missing and what is wrong. */
export async function collectNonInteractive(ctx: CliContext, flags: Flags, values: Values, o: { stdin?: () => Promise<string> } = {}): Promise<{ missing: string[]; errors: string[] }> {
  const s = (key: SKey, params?: Params) => t(ctx.locale, key, params);
  const errors: string[] = [];
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
    }
  }

  assertOneStdin(SECRETS.map(([, f]) => flags[f]), ctx.locale);
  for (const [key, fileFlag] of SECRETS) {
    const v = await readSecretSource({ env: ctx.env[key], file: flags[fileFlag], stdin: o.stdin });
    if (v) values[key] = v;
  }
  // The dashboard's install command, pasted whole into the file, still works.
  if (values.TUNNEL_TOKEN) values.TUNNEL_TOKEN = extractTunnelToken(values.TUNNEL_TOKEN);
  // A pinned IP belongs to sslip.io: switching away (or to DuckDNS, which follows
  // the IP) without --node-ip drops it, or DuckDNS and LiveKit keep a stale one.
  const modeChanged = flags.ingress !== undefined || flags['duckdns-domain'] !== undefined || flags['public-url'] !== undefined;
  if (flags['node-ip'] === undefined && (modeChanged || values.DDNS_PROVIDER === 'duckdns') && !SSLIP_RE.test(values.PUBLIC_URL ?? '')) {
    values.LIVEKIT_NODE_IP = '';
  }

  // Keys the chosen mode does not use go away (a re-run may switch modes).
  const ingress = values.INGRESS || 'direct';
  if (ingress !== 'tunnel') values.TUNNEL_TOKEN = '';
  if (ingress !== 'direct') values.DDNS_PROVIDER = values.DUCKDNS_DOMAIN = values.DUCKDNS_TOKEN = values.HTTP_PORT = values.HTTPS_PORT = '';
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
  if (values.DDNS_PROVIDER === 'duckdns') need('DUCKDNS_TOKEN', secret('DUCKDNS_TOKEN', 'duckdns-token-file'));
  return { missing, errors };
}

async function nonInteractive(ctx: CliContext, deps: SetupDeps, flags: Flags, o: { stdin?: () => Promise<string> }): Promise<number> {
  const docker = !!flags.docker;
  const l = await load(ctx, deps, docker);
  const values = l.values;
  const { missing, errors } = await collectNonInteractive(ctx, flags, values, o);
  if (errors.length || missing.length) {
    for (const e of errors) ctx.stderr(e);
    if (missing.length) ctx.stderr(t(ctx.locale, 'missing', { list: missing.join(', ') }));
    return 2;
  }
  const host = await detect(ctx, deps, docker);
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
  return afterWrite(w, l, values, config, flags, inferTarget(values, host));
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
