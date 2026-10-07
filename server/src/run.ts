// `telinha run`: the service. Reads telinha.env, supervises livekit-server (with
// MEDIA=self; MEDIA=cloud uses LiveKit Cloud) and caddy or cloudflared (per
// INGRESS), gates every page behind the Discord login, relays LiveKit signaling
// at /livekit (self only), serves rooms at /r/<code>, runs
// the slash command and the room lifecycle, keeps the router's port mappings
// and the DuckDNS record fresh, answers the local control endpoint and, in the
// native binary, updates itself. See README.md.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WebSocketHandler } from 'bun';
import { REST } from 'discord.js';
import { ensureBinariesForConfig } from './bins.ts';
import { editCard, startBot } from './bot.ts';
import { type Card, renderCard } from './card.ts';
import { childBaseEnv, childSpecs } from './children.ts';
import type { CliContext } from './cli/args.ts';
import type { ControlStatus } from './cli/control.ts';
import { ts } from './cli/strings.ts';
import { waitForEnter } from './cli/term.ts';
import { type Config, KNOWN_KEYS, loadConfig, upnpMappings } from './config.ts';
import { type Control, createControl } from './control.ts';
import { createDuckDns, type Ddns, startDdnsLoop } from './ddns.ts';
import { createPhoneTestStore } from './doctor/phone-test-store.ts';
import { createDoctorRoutes } from './doctor/routes.ts';
import { loadEnvFile, mergeEnv } from './envfile.ts';
import { footprintOf } from './footprint.ts';
import { createHandler } from './http.ts';
import { type Locale, t } from './i18n.ts';
import { createIpWatch, type IpWatch } from './ipwatch.ts';
import { createLifecycle } from './lifecycle.ts';
import { type RoomService, roomService } from './livekit.ts';
import { AlreadyRunningError, acquireLock, type Lock } from './lock.ts';
import { createLogger } from './log.ts';
import { createDirectory } from './members.ts';
import { createPortMapper, type PortMapper } from './nat/index.ts';
import { lookupPublicIp } from './netinfo.ts';
import { createLivekitProxy, type ProxyData } from './proxy.ts';
import { createRoleChecker, devIsMember, type IsMember, restGetMember } from './roles.ts';
import { createRooms, type Rooms } from './rooms.ts';
import { loadStatic } from './static.ts';
import { createSupervisor, type Supervisor } from './supervisor.ts';
import { createGitHubReleases } from './update/github.ts';
import { createUpdater, type Updater } from './update/updater.ts';
import { hostTarget, type Target } from './version.ts';

/** Exit code asking `service run` to start us again at once (an update was staged, a restart requested). */
export const EXIT_RESTART = 3;
const PARENT_POLL_MS = 5000;
const MAPPER_START_MS = 5000;
const MAPPER_STOP_MS = 3000;
/** The answer to /internal/update gets out before the listener closes. */
const RESTART_DELAY_MS = 500;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface RunOptions {
  /** Started by double-click (a console of its own, no arguments): wait for Enter before exiting on an error, or the window vanishes. */
  pauseOnError: boolean;
}

/** The Room module for this config; dev has no slash command, so admit opens a room for any code. */
export function roomModuleFor(
  config: Pick<Config, 'dataDir' | 'closeEmptySeconds' | 'dev'>,
  livekit: RoomService,
  log: (...a: unknown[]) => void,
): Rooms {
  return createRooms({
    path: join(config.dataDir, 'telinha.sqlite'),
    livekit,
    closeEmptySeconds: config.closeEmptySeconds,
    devAutoOpen: Boolean(config.dev),
    log,
  });
}

/** telinha.env (+ the environment over it) -> Config, logging where it came from and every warning. */
function configure(ctx: CliContext, log: (...a: unknown[]) => void): Config {
  const file = loadEnvFile(ctx.envFile);
  log(file ? `config: telinha.env from ${ctx.envFile}` : `config: no telinha.env at ${ctx.envFile}, environment only`);
  for (const w of file?.warnings ?? []) log(w);
  // Only the file's keys: the process environment is full of unrelated variables.
  for (const k of Object.keys(file?.vars ?? {})) if (!KNOWN_KEYS.has(k)) log(`config: unknown key ${k} in telinha.env`);
  const config = loadConfig(mergeEnv(file?.vars ?? {}, ctx.env), { compiled: ctx.compiled });
  for (const w of config.warnings) log(w);
  return config;
}

export async function run(ctx: CliContext, o: RunOptions): Promise<void> {
  const logger = createLogger({ stdout: true });
  const log = logger.log;
  const supervised = ctx.env.TELINHA_SUPERVISED === '1';
  const startedAt = Date.now();

  /** Before anything runs: one line, no stack (a config mistake is not a crash). */
  const fail = async (line: string): Promise<never> => {
    console.error(line);
    if (o.pauseOnError) await waitForEnter(ts(ctx.locale, 'pressEnter'));
    process.exit(1);
  };

  let config: Config;
  try {
    config = configure(ctx, log);
    mkdirSync(config.paths.data, { recursive: true });
    mkdirSync(config.paths.run, { recursive: true });
  } catch (e) {
    return fail(`telinha: ${message(e)}`);
  }
  const { paths } = config;

  // Before anything that touches children.json or the control token: a second
  // instance on this home must not kill the first one's children as stale.
  let lock: Lock;
  try {
    lock = acquireLock(join(paths.run, 'telinha.pid'));
  } catch (e) {
    if (e instanceof AlreadyRunningError) return fail(ts(ctx.locale, 'alreadyRunning', { pid: e.pid || '?' }));
    return fail(`telinha: ${message(e)}`);
  }

  let supervisor: Supervisor | undefined;
  let roomModule: Rooms | undefined;
  let server: ReturnType<typeof Bun.serve<ProxyData>> | undefined;
  let mapper: PortMapper | null = null;
  let control: Control | undefined;
  const stoppers: (() => void)[] = [];
  let shutdown: Promise<void> | null = null;

  // Signals, fatal errors, the control endpoint and the updater all end here.
  const exit = (code: number, why: string) => {
    if (shutdown) {
      // A second Ctrl+C: stop waiting; the 'exit' handler still kills the children.
      if (code === 130) process.exit(code);
      return;
    }
    log(`${why}, stopping`);
    shutdown = (async () => {
      for (const stop of stoppers) stop();
      // Side by side: closing the console leaves ~5 s, the router must not eat the children's share.
      await Promise.all([
        mapper
          ? Promise.race([
              mapper.stop().catch((e: unknown) => log('upnp: removing the mappings failed', message(e))),
              Bun.sleep(MAPPER_STOP_MS),
            ])
          : null,
        supervisor?.stop().catch((e: unknown) => log('stopping children failed', message(e))),
      ]);
      void server?.stop(true);
      roomModule?.closeDb();
      control?.removeToken();
      lock.release();
      logger.close();
    })().finally(() => process.exit(code));
  };
  // Windows (Bun 1.4.2, see supervisor.ts): closing the console sends SIGHUP and
  // leaves ~5 s, Ctrl+C reaches the children too; stop() copes with both.
  process.on('SIGINT', () => exit(130, 'SIGINT'));
  process.on('SIGTERM', () => exit(0, 'SIGTERM'));
  process.on('SIGHUP', () => exit(0, 'SIGHUP'));
  // Last resort (process.exit from anywhere, a hard error): never leave LiveKit holding the ports.
  process.on('exit', () => {
    supervisor?.stopSync();
    control?.removeToken();
    lock.release();
  });
  process.on('uncaughtException', (e) => {
    log('uncaught exception', e);
    exit(1, 'uncaught exception');
  });
  process.on('unhandledRejection', (e) => {
    log('unhandled rejection', e);
    exit(1, 'unhandled rejection');
  });

  // Under `telinha service run`: the loop holds our stdin open and never writes;
  // EOF means it is gone (on Linux a kill -9 of it would otherwise orphan us).
  if (supervised) {
    const gone = () => exit(0, 'supervisor gone');
    process.stdin.on('end', gone);
    process.stdin.on('close', gone);
    process.stdin.resume();
    const parent = Number(ctx.env.TELINHA_SUPERVISOR_PID);
    if (Number.isInteger(parent) && parent > 0) {
      const timer = setInterval(() => {
        try {
          process.kill(parent, 0);
        } catch (e) {
          // EPERM: it exists, it is just not ours to signal.
          if ((e as NodeJS.ErrnoException).code !== 'EPERM') gone();
        }
      }, PARENT_POLL_MS);
      timer.unref();
      stoppers.push(() => clearInterval(timer));
    }
  }

  // The doctor's phone test asks LiveKit for its own room through it too.
  const livekit = roomService({ url: config.livekitApiUrl, key: config.livekitKey, secret: config.livekitSecret });
  let files: ReturnType<typeof loadStatic>;
  try {
    // The native binary fetches its own livekit/caddy/cloudflared (a new pin after an update lands here).
    if (ctx.compiled) {
      const r = await ensureBinariesForConfig(config, paths, (m) => log(m));
      if (r.changed.length) log(`binaries updated: ${r.changed.join(', ')}`);
    }
    files = loadStatic(config.webDir, { command: config.commandName });
    roomModule = roomModuleFor(config, livekit, log);
    supervisor = createSupervisor({
      specs: childSpecs(config, paths),
      log,
      // Children never see telinha's secrets or the LIVEKIT_*/TUNNEL_* their binaries read as flags.
      baseEnv: childBaseEnv(ctx.env),
      pidfile: join(paths.run, 'children.json'),
    });
  } catch (e) {
    lock.release();
    return fail(`telinha: ${message(e)}`);
  }
  log(
    `telinha ${ctx.version} starting (ingress=${config.ingress}, media=${config.media}, turn=${config.turn?.host ?? 'off'}${supervised ? ', supervised' : ''})`,
  );

  try {
    await supervisor.start();
  } catch (e) {
    // A signal during start-up: its handler is already stopping and exits.
    if (shutdown) return;
    // A broken config or binary: exit and let the service loop, compose or the
    // operator see it; backoff is for crashes of a running service. Siblings stop
    // gracefully first. A staged update counts this exit as a failed start.
    log(`start-up failed: ${message(e)}`);
    await supervisor.stop().catch(() => {});
    lock.release();
    if (o.pauseOnError) await waitForEnter(ts(ctx.locale, 'pressEnter'));
    process.exit(1);
  }
  const rooms = roomModule;
  const sup = supervisor;

  let isMember: IsMember;
  let discordReady = () => false;
  // Filled by the bot; stays "not ready" (an empty list) in dev, where http.ts serves a fixed one.
  const directory = createDirectory();
  let guildName = (): string | undefined => undefined;
  // GROUP_NAME, else the guild's name once the bot sees it, else "members".
  const group = (l: Locale) => config.groupName ?? guildName() ?? t(l, 'members');
  const render = (
    rec: Parameters<typeof renderCard>[0],
    live: Parameters<typeof renderCard>[1] = { streamers: [], viewers: [] },
  ) => renderCard(rec, live, { publicUrl: config.publicUrl, group: group(rec.locale) });
  // Dev rooms have no Discord message; rooms.ts still opens and closes them.
  let editMessage = async (_c: string, _m: string, _card: Card) => {};

  if (config.dev) {
    log(
      `!!! DEV_USER fake login enabled: everyone on ${config.publicUrl} is "${config.dev.name}" (${config.dev.id}); Discord bot not started !!!`,
    );
    isMember = devIsMember(config.dev.id);
  } else {
    const rest = new REST().setToken(config.discordToken);
    isMember = createRoleChecker({
      getMember: restGetMember(rest, config.guildId),
      roleId: config.roleId,
      ttlMs: config.roleTtlMs,
    });
    const client = startBot({ config, rest, group, log, rooms, render: (rec) => render(rec), directory });
    discordReady = () => client.isReady();
    guildName = () => client.guilds.cache.get(config.guildId)?.name;
    editMessage = editCard(rest);
  }

  stoppers.push(
    createLifecycle({
      rooms,
      render,
      editMessage: (c, m, card) => editMessage(c, m, card),
      log,
    }).start(config.pollSeconds * 1000),
  );

  const ddns: Ddns | null = config.ddns
    ? createDuckDns({ domain: config.ddns.domain, token: config.ddns.token, fetch, log })
    : null;
  // With nothing to map (LiveKit Cloud behind a tunnel) the mapper only drops what a previous run left.
  if (config.upnp)
    mapper = createPortMapper({ mappings: upnpMappings(config), statePath: join(paths.run, 'upnp.json'), log });

  const footprint = footprintOf(config);
  // LiveKit picks the public IP once at start; a residential IP change needs a
  // restart. Cloud has no local LiveKit but still wants the mappings and DuckDNS renewed.
  let ipWatch: IpWatch | null = null;
  if (footprint.ipWatch) {
    const self = footprint.helpers.some((h) => h.name === 'livekit');
    ipWatch = createIpWatch({
      fetch,
      intervalMs: config.ipWatchSeconds * 1000,
      log,
      labels: self
        ? { changed: 'restarting livekit', startedWith: 'livekit started with the new one' }
        : { changed: 'nothing to restart', startedWith: 'nothing to restart' },
      onChange: async (ip) => {
        // Routers often drop mappings on a WAN reconnect.
        await mapper?.refresh().catch((e: unknown) => log('upnp: refresh failed', message(e)));
        if (self) await sup.restart('livekit');
        // The DDNS loop is authoritative; this only saves it up to one interval.
        void ddns?.update(ip);
      },
      statePath: join(paths.run, 'public-ip'),
    });
    stoppers.push(ipWatch.start());
  }

  if (mapper) {
    // Bounded: a router that never answers must not hold up the listener.
    const started = mapper.start().catch((e: unknown) => log('upnp: start failed', message(e)));
    await Promise.race([started, Bun.sleep(MAPPER_START_MS)]);
  }
  if (ddns) {
    stoppers.push(startDdnsLoop({ ddns, lookupIp: () => lookupPublicIp(fetch), fixedIp: config.livekitNodeIp, log }));
  }

  const makeUpdater = (): Updater | null => {
    let target: Target;
    try {
      target = hostTarget();
    } catch (e) {
      // No release is built for this host: nothing to update.
      log(`update: not available here (${message(e)})`);
      return null;
    }
    return createUpdater({
      current: ctx.version,
      pin: config.updatePin,
      checkMs: config.updateCheckHours * 3_600_000,
      maxDeferMs: config.updateMaxDeferHours * 3_600_000,
      paths,
      target,
      openRooms: () => rooms.openRooms().length,
      github: createGitHubReleases(),
      log,
      compiled: ctx.compiled,
      enabled: config.autoUpdate,
      onApplied: (tag) => {
        if (supervised)
          setTimeout(() => exit(EXIT_RESTART, `update to ${tag} installed, restarting`), RESTART_DELAY_MS);
        else log(`update to ${tag} installed; restart telinha to apply it`);
      },
    });
  };
  const updater = makeUpdater();

  const phoneTestStore = createPhoneTestStore({ cookieSecret: config.cookieSecret });
  const doctor = createDoctorRoutes({ store: phoneTestStore, config, files, rooms: livekit, log });
  const children = () => Object.fromEntries(sup.status().map((s) => [s.name, s.state]));
  const childStatus = () =>
    Object.fromEntries(
      sup
        .status()
        .map((s) => [
          s.name,
          { state: s.state, pid: s.pid, restarts: s.restarts, recentRestarts: s.recentRestarts, since: s.since },
        ]),
    );
  const status = (): ControlStatus => ({
    version: ctx.version,
    startedAt,
    pid: process.pid,
    ingress: config.ingress,
    media: config.media,
    rooms: rooms.openRooms().length,
    children: children(),
    childStatus: childStatus(),
    publicIp: ipWatch?.current() ?? config.livekitNodeIp ?? ddns?.last()?.ip ?? null,
    upnp: mapper?.status() ?? null,
    ddns: ddns?.last() ?? null,
    update: updater?.status() ?? null,
    supervised,
    turn: config.turn ? { host: config.turn.host, port: config.turn.port } : null,
  });
  control = createControl({
    tokenFile: join(paths.run, 'control.token'),
    status,
    doctor: {
      create: () => {
        const s = phoneTestStore.create();
        return { id: s.id, url: `${config.publicUrl}/doctor?t=${s.token}`, expiresAt: s.expiresAt };
      },
      wait: (id, ms) => phoneTestStore.wait(id, ms),
    },
    update: updater ? (mode) => updater.update(mode) : null,
    shutdown: (reason) => exit(reason === 'restart' ? EXIT_RESTART : 0, `${reason} requested`),
    log,
  });

  // Cloud: browsers reach LiveKit Cloud directly, so /livekit/* stays a 404.
  const proxy = footprint.relay ? createLivekitProxy({ apiUrl: config.livekitApiUrl, log }) : undefined;
  // Bun.serve wants a handler even when nothing ever upgrades.
  const noSockets: WebSocketHandler<ProxyData> = { message() {} };
  const handler = createHandler({
    config,
    isMember,
    files,
    group,
    rooms,
    discordReady: () => discordReady(),
    members: () => directory.list(),
    log,
    proxy,
    upgrade: (req, data) => server?.upgrade(req, { data }) ?? false,
    timeout: (req, seconds) => server?.timeout(req, seconds),
    openRooms: () => rooms.openRooms().length,
    children,
    version: ctx.version,
    control,
    doctor,
    doctorCookie: (value, now) => phoneTestStore.verifyCookie(value, now),
  });
  try {
    server = Bun.serve<ProxyData>({
      hostname: config.host,
      port: config.port,
      fetch: handler,
      websocket: proxy?.websocket ?? noSockets,
    });
  } catch (e) {
    log(`start-up failed: cannot listen on ${config.host}:${config.port}: ${message(e)}`);
    exit(1, 'no listener');
    return;
  }
  // Only now: a start that failed on a busy port must not replace a running instance's token.
  control.writeToken();

  if (ctx.compiled && updater) {
    if (config.autoUpdate) stoppers.push(updater.start());
    // HTTP is up and the children are ready: a staged update has proven itself.
    void updater.finish();
  }
  log(`listening on ${server.hostname}:${server.port}; data in ${config.dataDir}; version ${ctx.version}`);
}
