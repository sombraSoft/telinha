// `telinha update [--check | --now]`. With the service running the request goes
// to it (it downloads, stages and restarts itself); otherwise this process
// stages the new executable and the next start uses it.
import { statSync } from 'node:fs';
import { loadEnvFile, mergeEnv } from '../envfile.ts';
import { createGitHubReleases } from '../update/github.ts';
import { nodeFs } from '../update/types.ts';
import { createUpdater, type Updater } from '../update/updater.ts';
import { hostTarget, type Target } from '../version.ts';
import { GLOBAL_FLAGS, parseArgs, UsageError, type CliContext, type ParsedArgs } from './args.ts';
import { createControlClient, type ControlClient, type UpdateCheck, type UpdateResult } from './control.ts';
import { defineStrings, ts } from './strings.ts';

export const UPDATE_FLAGS = { check: 'boolean', now: 'boolean' } as const;
export const UPDATE_SPEC = { flags: { ...GLOBAL_FLAGS, ...UPDATE_FLAGS } } as const;

const t = defineStrings({
  current: 'Telinha {version}',
  latest: 'Newest stable release: {tag}',
  latestUnknown: 'Newest stable release: unknown (offline, or none published)',
  pin: 'Pinned to {tag} (UPDATE_PIN)',
  upToDate: 'Up to date.',
  available: '{tag} is available.',
  staged: '{tag} is installed and waits for the next start.',
  failed: '{tag} failed: {reason}. Skipped until a newer release; telinha update --now retries it.',
  pending: '{tag} is not downloadable yet; it will be retried.',
  deferred: '{n} room(s) open; the update to {tag} is applied when they close (telinha update --now skips the wait).',
  installedRestart: '{tag} installed; the service is restarting to apply it.',
  installedStart: '{tag} installed; start Telinha to use it.',
  nativeOnly: 'Updates apply to native installs only. Docker: docker compose pull; from a clone: git pull.',
  viaService: 'Asking the running service...',
  serviceOwned: 'The service updates itself here; it is not running. Start it (sudo telinha service start), then run telinha update again.',
}, {
  current: 'Telinha {version}',
  latest: 'Versão estável mais nova: {tag}',
  latestUnknown: 'Versão estável mais nova: desconhecida (sem internet, ou nenhuma publicada)',
  pin: 'Fixada em {tag} (UPDATE_PIN)',
  upToDate: 'Já está atualizada.',
  available: '{tag} está disponível.',
  staged: '{tag} está instalada e espera o próximo início.',
  failed: '{tag} falhou: {reason}. Ignorada até sair uma versão mais nova; telinha update --now tenta de novo.',
  pending: '{tag} ainda não pode ser baixada; vai ser tentada de novo.',
  deferred: '{n} sala(s) aberta(s); a atualização pra {tag} é aplicada quando elas fecharem (telinha update --now não espera).',
  installedRestart: '{tag} instalada; o serviço está reiniciando pra aplicar.',
  installedStart: '{tag} instalada; inicie a Telinha pra usar.',
  nativeOnly: 'Atualizações valem só pra instalação nativa. Docker: docker compose pull; de um clone: git pull.',
  viaService: 'Pedindo ao serviço em execução...',
  serviceOwned: 'Aqui o serviço se atualiza sozinho, e ele não está rodando. Inicie ele (sudo telinha service start) e rode telinha update de novo.',
});

export interface UpdateCliDeps {
  control?: Pick<ControlClient, 'available' | 'update'>;
  /** Replaces the local updater (tests). */
  updater?: (o: { current: string; pin: string | null }) => Pick<Updater, 'update'>;
  fetch?: typeof fetch;
  target?: Target;
  /** Owner uid of the bin dir, null when it does not exist (tests). */
  binOwner?: (bin: string) => number | null;
  /** process.getuid() (tests). */
  uid?: number | null;
}

const ownerOf = (dir: string): number | null => {
  try {
    return statSync(dir).uid;
  } catch {
    return null;
  }
};

function pinFrom(ctx: CliContext): string | null {
  let vars: Record<string, string> = {};
  try {
    vars = loadEnvFile(ctx.envFile)?.vars ?? {};
  } catch {
    // unreadable file: the environment alone
  }
  return mergeEnv(vars, ctx.env).UPDATE_PIN || null;
}

function describe(ctx: CliContext, c: UpdateCheck): void {
  const s = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => ctx.stdout(t(ctx.locale, key, params));
  s('current', { version: c.current });
  if (c.pin) s('pin', { tag: c.pin });
  if (c.latest) s('latest', { tag: c.latest });
  else s('latestUnknown');
  if (c.staged) s('staged', { tag: c.staged.tag });
  if (c.failed) s('failed', { tag: c.failed.tag, reason: c.failed.reason });
  if (c.pending) s('pending', { tag: c.pending.tag });
}

/** Lines for the outcome; the exit code says whether something is installed or up to date (0) or not (1). */
function report(ctx: CliContext, r: UpdateResult, viaService: boolean): number {
  describe(ctx, r);
  const s = (key: Parameters<typeof t>[1], params?: Record<string, string | number>) => ctx.stdout(t(ctx.locale, key, params));
  switch (r.action) {
    case 'none':
      if (r.target) s('available', { tag: r.target });
      else s('upToDate');
      return 0;
    case 'staged':
      if (r.target && !r.staged) s('available', { tag: r.target });
      s(viaService ? 'installedRestart' : 'installedStart', { tag: r.staged?.tag ?? r.target ?? '' });
      return 0;
    case 'deferred': {
      const n = /^(\d+)/.exec(r.message)?.[1] ?? '?';
      s('deferred', { n, tag: r.target ?? '' });
      return 0;
    }
    case 'pending':
      return 1;
    case 'failed':
      return 1;
  }
}

export async function run(args: ParsedArgs, ctx: CliContext, deps: UpdateCliDeps = {}): Promise<number> {
  let flags: { check?: boolean; now?: boolean };
  try {
    flags = parseArgs(ctx.argv, UPDATE_SPEC, { locale: ctx.locale }).flags;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.stderr(e.message);
    ctx.stderr(ts(ctx.locale, 'helpUpdate'));
    return 2;
  }
  const mode = flags.check ? 'check' : flags.now ? 'now' : 'scheduled';
  const control = deps.control ?? createControlClient({ paths: ctx.paths, envFile: ctx.envFile, env: ctx.env });

  if (await control.available()) {
    if (mode !== 'check') ctx.stdout(t(ctx.locale, 'viaService'));
    return report(ctx, await control.update(mode), true);
  }

  if (mode !== 'check' && !ctx.compiled) {
    ctx.stderr(t(ctx.locale, 'nativeOnly'));
    return 1;
  }
  // A root install's bin/ belongs to the service user: root writing there
  // could be steered (a planted symlink) onto any file of the system.
  const uid = deps.uid !== undefined ? deps.uid : (process.getuid?.() ?? null);
  const binOwner = (deps.binOwner ?? ownerOf)(ctx.paths.bin);
  if (mode !== 'check' && uid === 0 && binOwner !== null && binOwner !== 0) {
    ctx.stderr(t(ctx.locale, 'serviceOwned'));
    return 1;
  }
  const pin = pinFrom(ctx);
  const updater = deps.updater?.({ current: ctx.version, pin }) ?? createUpdater({
    current: ctx.version,
    pin,
    checkMs: 60_000,
    maxDeferMs: 0,
    paths: ctx.paths,
    target: deps.target ?? hostTarget(),
    openRooms: () => 0,
    github: createGitHubReleases({ fetch: deps.fetch }),
    fs: nodeFs(),
    log: (...a) => ctx.stderr(a.map(String).join(' ')),
    onApplied: () => {},
    compiled: ctx.compiled,
  });
  // Nothing runs, so nothing to defer: a plain `telinha update` installs right away.
  return report(ctx, await updater.update(mode === 'scheduled' ? 'now' : mode), false);
}
