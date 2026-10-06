// Telinha: the one service. Reads telinha.env, supervises livekit-server (and
// caddy or cloudflared, per INGRESS), gates every page behind the Discord
// login, relays LiveKit signaling at /livekit, serves rooms at /r/<code>, runs
// the slash command and the room lifecycle. See README.md.
import { REST } from 'discord.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { editCard, startBot } from './bot.ts';
import { renderCard, type Card } from './card.ts';
import { childBaseEnv, childSpecs } from './children.ts';
import { KNOWN_KEYS, loadConfig, type Config } from './config.ts';
import { loadEnvFile, mergeEnv } from './envfile.ts';
import { createHandler } from './http.ts';
import { t, type Locale } from './i18n.ts';
import { createIpWatch } from './ipwatch.ts';
import { createLifecycle } from './lifecycle.ts';
import { roomService } from './livekit.ts';
import { createDirectory } from './members.ts';
import { resolvePaths } from './paths.ts';
import { createLivekitProxy, type ProxyData } from './proxy.ts';
import { createRoleChecker, devIsMember, restGetMember, type IsMember } from './roles.ts';
import { openRegistry, type Registry } from './rooms.ts';
import { loadStatic } from './static.ts';
import { createSupervisor, type Supervisor } from './supervisor.ts';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'dev';
  } catch {
    return 'dev';
  }
}

/** telinha.env (+ the real environment over it) -> Config, logging where it came from and every warning. */
function configure(): Config {
  // Where to look comes from the real environment only: the file cannot move itself.
  const path = process.env.TELINHA_ENV || join(resolvePaths(process.env).config, 'telinha.env');
  const file = loadEnvFile(path);
  log(file ? `config: telinha.env from ${path}` : `config: no telinha.env at ${path}, environment only`);
  for (const w of file?.warnings ?? []) log(w);
  // Only the file's keys: the process environment is full of unrelated variables.
  for (const k of Object.keys(file?.vars ?? {})) if (!KNOWN_KEYS.has(k)) log(`config: unknown key ${k} in telinha.env`);
  const config = loadConfig(mergeEnv(file?.vars ?? {}, process.env));
  for (const w of config.warnings) log(w);
  return config;
}

async function run() {
  let config: Config;
  let supervisor: Supervisor;
  let registry: Registry;
  let files: ReturnType<typeof loadStatic>;
  try {
    config = configure();
    const { paths } = config;
    mkdirSync(paths.data, { recursive: true });
    mkdirSync(paths.run, { recursive: true });
    files = loadStatic(config.webDir, { command: config.commandName });
    registry = openRegistry(join(config.dataDir, 'telinha.sqlite'));
    supervisor = createSupervisor({
      specs: childSpecs(config, paths),
      log,
      // Children never see telinha's secrets or the LIVEKIT_*/TUNNEL_* their binaries read as flags.
      baseEnv: childBaseEnv(process.env),
      pidfile: join(paths.run, 'children.json'),
    });
  } catch (e) {
    // A config mistake, not a crash: one line, no stack.
    console.error(`telinha: ${message(e)}`);
    process.exit(1);
  }
  log(`telinha ${version()} starting (ingress=${config.ingress}, media=${config.media})`);

  let server: ReturnType<typeof Bun.serve<ProxyData>> | undefined;
  const stoppers: (() => void)[] = [];
  let shutdown: Promise<void> | null = null;
  // Signals and fatal errors all end here. Children first (graceful), then HTTP and the registry.
  const exit = (code: number, why: string) => {
    if (shutdown) {
      // A second Ctrl+C: stop waiting; the 'exit' handler still kills the children.
      if (code === 130) process.exit(code);
      return;
    }
    log(`${why}, stopping`);
    shutdown = (async () => {
      for (const stop of stoppers) stop();
      await supervisor.stop().catch((e: unknown) => log('stopping children failed', message(e)));
      void server?.stop(true);
      registry.closeDb();
    })().finally(() => process.exit(code));
  };
  // Windows (Bun 1.4.2, see supervisor.ts): closing the console sends SIGHUP and
  // leaves ~5 s, Ctrl+C reaches the children too; stop() copes with both.
  process.on('SIGINT', () => exit(130, 'SIGINT'));
  process.on('SIGTERM', () => exit(0, 'SIGTERM'));
  process.on('SIGHUP', () => exit(0, 'SIGHUP'));
  // Last resort (process.exit from anywhere, a hard error): never leave LiveKit holding the ports.
  process.on('exit', () => supervisor.stopSync());
  process.on('uncaughtException', (e) => {
    log('uncaught exception', e);
    exit(1, 'uncaught exception');
  });
  process.on('unhandledRejection', (e) => {
    log('unhandled rejection', e);
    exit(1, 'unhandled rejection');
  });

  try {
    await supervisor.start();
  } catch (e) {
    // A signal during start-up: its handler is already stopping and exits.
    if (shutdown) return;
    // A broken config or binary: exit and let compose (or the operator) see it;
    // backoff is for crashes of a running service. Siblings stop gracefully first.
    log(`start-up failed: ${message(e)}`);
    await supervisor.stop().catch(() => {});
    process.exit(1);
  }

  const rooms = roomService({
    url: config.livekitApiUrl, key: config.livekitKey, secret: config.livekitSecret, closeEmptySeconds: config.closeEmptySeconds,
  });

  let isMember: IsMember;
  let discordReady = () => false;
  // Filled by the bot; stays "not ready" (an empty list) in dev, where http.ts serves a fixed one.
  const directory = createDirectory();
  let guildName = (): string | undefined => undefined;
  // GROUP_NAME, else the guild's name once the bot sees it, else "members".
  const group = (l: Locale) => config.groupName ?? guildName() ?? t(l, 'members');
  const render = (rec: Parameters<typeof renderCard>[0], live: Parameters<typeof renderCard>[1] = { streamers: [], viewers: [] }) =>
    renderCard(rec, live, { publicUrl: config.publicUrl, group: group(rec.locale) });
  // Dev rooms have no Discord message; the lifecycle still opens and closes them.
  let editMessage = async (_c: string, _m: string, _card: Card) => {};

  if (config.dev) {
    log(`!!! DEV_USER fake login enabled: everyone on ${config.publicUrl} is "${config.dev.name}" (${config.dev.id}); Discord bot not started !!!`);
    isMember = devIsMember(config.dev.id);
  } else {
    const rest = new REST().setToken(config.discordToken);
    isMember = createRoleChecker({ getMember: restGetMember(rest, config.guildId), roleId: config.roleId, ttlMs: config.roleTtlMs });
    const client = startBot({ config, rest, group, log, registry, rooms, render: (rec) => render(rec), directory });
    discordReady = () => client.isReady();
    guildName = () => client.guilds.cache.get(config.guildId)?.name;
    editMessage = editCard(rest);
  }

  stoppers.push(createLifecycle({
    registry, rooms, render, editMessage: (c, m, card) => editMessage(c, m, card), closeEmptyMs: config.closeEmptySeconds * 1000, log,
  }).start(config.pollSeconds * 1000));

  // LiveKit picks the public IP once at start; a residential IP change needs a restart.
  if (config.media === 'self' && config.ipWatchSeconds > 0 && !config.livekitNodeIp) {
    stoppers.push(createIpWatch({
      fetch, intervalMs: config.ipWatchSeconds * 1000, log,
      onChange: () => supervisor.restart('livekit'),
      statePath: join(config.paths.run, 'public-ip'),
    }).start());
  }

  const proxy = createLivekitProxy({ apiUrl: config.livekitApiUrl, log });
  const handler = createHandler({
    config, isMember, files, group, registry, rooms, discordReady: () => discordReady(), members: () => directory.list(), log,
    proxy,
    upgrade: (req, data) => server?.upgrade(req, { data }) ?? false,
    openRooms: () => registry.open().length,
    children: () => Object.fromEntries(supervisor.status().map((s) => [s.name, s.state])),
  });
  server = Bun.serve<ProxyData>({
    hostname: config.host,
    port: config.port,
    fetch: handler,
    websocket: proxy.websocket,
  });
  log(`listening on ${server.hostname}:${server.port}; data in ${config.dataDir}`);
}

// Phase 2 adds setup, doctor and update here (server/src/cli/*.ts).
const command = process.argv[2] ?? 'run';
if (command === 'run') {
  await run();
} else {
  console.error(`telinha: unknown command "${command}" (phase 2 adds setup, doctor, update)`);
  process.exit(2);
}
