// The updater that lives inside `run`: resolves the target (the pin, else the
// newest stable release), downloads and stages it, and asks the caller to
// restart. Stable means a tag without `-`; prereleases are only ever installed
// when pinned. Assets that are not downloadable yet are "pending" and retried;
// a verified-bad download or a version that failed to start twice is "failed"
// and skipped until a newer tag exists (`telinha update --now` retries it).
import { join } from 'node:path';
import type { Paths } from '../paths.ts';
import { TRAY_NEW, isStableTag, newExeName } from '../release.ts';
import type { Target } from '../version.ts';
import { isCompiled } from '../version.ts';
import { downloadRelease } from './download.ts';
import { readState, statePath as defaultStatePath, writeState } from './state.ts';
import { finish as finishSwap, stage } from './swap.ts';
import {
  FailedError, PendingError, errorMessage, nodeFs,
  type GitHubReleases, type UpdateCheck, type UpdateFs, type UpdateMode, type UpdateResult, type UpdateState, type UpdateStatus,
} from './types.ts';

export interface UpdaterOptions {
  /** The running version, as version() gives it (no leading v). */
  current: string;
  /** UPDATE_PIN: install exactly this tag, prerelease or not, downgrade or not. */
  pin?: string | null;
  checkMs: number;
  /** How long open rooms may hold back one target before it is applied anyway. */
  maxDeferMs: number;
  /** First check after start(); default 2 min (let the start settle, and never during the start itself). */
  startDelayMs?: number;
  /** While rooms defer an update, how often to look again; default 60 s (no network: the last answer is reused within checkMs). */
  deferPollMs?: number;
  paths: Pick<Paths, 'bin' | 'run'>;
  target: Target;
  platform?: NodeJS.Platform;
  openRooms: () => number;
  github: GitHubReleases;
  fs?: UpdateFs;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log: (...a: unknown[]) => void;
  /** A new version is in place: run.ts exits 3 under `service run`, or logs "restart telinha to apply" from a console. */
  onApplied: (tag: string) => void;
  /** Only the native binary replaces itself; default isCompiled(). */
  compiled?: boolean;
  /** AUTO_UPDATE: the timer. Manual `telinha update` works regardless. Default true. */
  enabled?: boolean;
}

export interface Updater {
  /** Starts the periodic check; returns the stopper. */
  start(): () => void;
  /** Looks, never writes files. */
  check(): Promise<UpdateCheck>;
  /** check: look only; scheduled: apply unless rooms defer it; now: apply. */
  update(mode: UpdateMode): Promise<UpdateResult>;
  applyNow(): Promise<UpdateResult>;
  status(): UpdateStatus;
  /** The current version started fine: clear the staged record, sweep leftovers. Never rejects. */
  finish(): Promise<void>;
}

const norm = (v: string) => v.replace(/^v/, '');

/** semver order on X.Y.Z[-pre]: a prerelease ranks below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', ...pre] = norm(v).split('-');
    return { core: core.split('.').map((n) => Number(n) || 0), pre: pre.join('-') };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xs = x.pre.split('.');
  const ys = y.pre.split('.');
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i];
    const q = ys[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = Number(p);
    const nq = Number(q);
    const c = Number.isInteger(np) && Number.isInteger(nq) ? Math.sign(np - nq) : p < q ? -1 : p > q ? 1 : 0;
    if (c) return c;
  }
  return 0;
}

const sameVersion = (a: string, b: string) => compareVersions(a, b) === 0;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createUpdater(o: UpdaterOptions): Updater {
  const fs = o.fs ?? nodeFs();
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const platform = o.platform ?? process.platform;
  const compiled = o.compiled ?? isCompiled();
  const enabled = o.enabled ?? true;
  const pin = o.pin || null;
  const statePath = defaultStatePath(o.paths);
  const { log } = o;

  let state: UpdateState = {};
  let loaded: Promise<void> | null = null;
  /** The last tag `releases/latest` named (raw) and when; reused while rooms defer so the poll stays local. */
  let latestRaw: { tag: string | null; at: number } | null = null;
  /** Checks and applies run one at a time (timer and CLI may overlap). */
  let chain: Promise<unknown> = Promise.resolve();

  const init = () => (loaded ??= readState(fs, statePath).then((s) => void (state = s)));
  const save = () => writeState(fs, statePath, state);
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  async function latest(fresh: boolean): Promise<string | null> {
    if (!fresh && latestRaw && now() - latestRaw.at < o.checkMs) return latestRaw.tag;
    const tag = await o.github.latestTag();
    latestRaw = { tag, at: now() };
    return tag;
  }

  /** What `releases/latest` (or the pin) says, and whether it means an install. */
  async function resolve(fresh: boolean): Promise<{ latest: string | null; target: string | null }> {
    const raw = await latest(fresh);
    if (pin) {
      // Pinned: the pin is the target whatever latest says; a prerelease latest is still only shown when it is the pin.
      const shown = raw && (isStableTag(raw) || sameVersion(raw, pin)) ? raw : null;
      return { latest: shown, target: sameVersion(pin, o.current) ? null : pin };
    }
    if (raw && !isStableTag(raw)) {
      log(`update: latest release ${raw} is a prerelease; no stable release to install`);
      return { latest: null, target: null };
    }
    return { latest: raw, target: raw && compareVersions(raw, o.current) > 0 ? raw : null };
  }

  async function doCheck(fresh: boolean): Promise<UpdateCheck> {
    await init();
    const { latest: seen, target } = await resolve(fresh);
    // A newer tag supersedes a failed or pending one.
    if (state.failed && target && compareVersions(target, state.failed.tag) > 0) state.failed = undefined;
    if (state.pending && (!target || !sameVersion(state.pending.tag, target))) state.pending = undefined;
    if (state.deferredTag && (!target || !sameVersion(state.deferredTag, target))) {
      state.deferredTag = undefined;
      state.deferredSince = undefined;
    }
    state.lastCheck = now();
    await save();
    return {
      current: o.current, latest: seen, pin, target,
      staged: state.staged ?? null, failed: state.failed ?? null, pending: state.pending ?? null, deferredSince: state.deferredSince ?? null,
    };
  }

  const result = (check: UpdateCheck, action: UpdateResult['action'], message: string): UpdateResult => ({
    ...check, staged: state.staged ?? null, failed: state.failed ?? null, pending: state.pending ?? null, deferredSince: state.deferredSince ?? null,
    action, message,
  });

  /** `fresh` false only for the deferral poll: rooms are checked locally, GitHub's last answer stands within checkMs. */
  async function doUpdate(mode: UpdateMode, fresh = true): Promise<UpdateResult> {
    const check = await doCheck(fresh);
    if (mode === 'check') return result(check, 'none', check.target ? `${check.target} is available` : 'up to date');
    const tag = check.target;
    if (!tag) return result(check, 'none', `up to date (${o.current})`);
    if (!compiled) return result(check, 'none', 'updates apply to native installs only');
    if (state.staged) return result(check, 'staged', `${state.staged.tag} is installed; restart telinha to apply it`);
    if (mode === 'scheduled' && state.failed && sameVersion(state.failed.tag, tag)) {
      return result(check, 'failed', `skipping ${tag}: ${state.failed.reason}; telinha update --now retries it`);
    }
    if (mode === 'scheduled') {
      const open = o.openRooms();
      if (open > 0) {
        if (!state.deferredTag || !sameVersion(state.deferredTag, tag)) {
          state.deferredTag = tag;
          state.deferredSince = now();
        }
        if (now() - (state.deferredSince ?? now()) < o.maxDeferMs) {
          await save();
          return result(check, 'deferred', `${open} room(s) open, will update to ${tag} when they close`);
        }
        log(`update: ${tag} deferred for ${Math.round(o.maxDeferMs / 3_600_000)} h with rooms open; applying now`);
      }
    }
    try {
      log(`update: installing ${tag}`);
      await downloadRelease({ github: o.github, fs, bin: o.paths.bin, tag, target: o.target, log });
      state.staged = await stage({ fs, bin: o.paths.bin, platform, tag, current: o.current, now, log });
      // A retried tag that now verified fine is no longer failed; a failed start would record it again.
      if (state.failed && sameVersion(state.failed.tag, tag)) state.failed = undefined;
      state.pending = undefined;
      state.deferredTag = undefined;
      state.deferredSince = undefined;
      await save();
      o.onApplied(tag);
      return result(check, 'staged', `${tag} installed; restarting to apply it`);
    } catch (e) {
      for (const name of [newExeName(o.target), TRAY_NEW]) await fs.rm(join(o.paths.bin, name)).catch(() => {});
      if (e instanceof FailedError) {
        state.failed = { tag, at: now(), reason: e.message };
        await save();
        log(`update: ${tag} rejected: ${e.message}`);
        return result(check, 'failed', `${tag} rejected: ${e.message}`);
      }
      // 404s, network trouble and anything unexpected: try again at the next check.
      const since = state.pending && sameVersion(state.pending.tag, tag) ? state.pending.since : now();
      state.pending = { tag, since };
      await save();
      const why = e instanceof PendingError ? e.message : `${errorMessage(e)}`;
      log(`update: ${tag} not installed yet: ${why}`);
      return result(check, 'pending', `${tag} is not downloadable yet (${why}); will retry`);
    }
  }

  return {
    start() {
      const ctl = new AbortController();
      const { signal } = ctl;
      void (async () => {
        await init().catch(() => {});
        if (!enabled) return;
        let delay = o.startDelayMs ?? 120_000;
        let deferred = false;
        while (!signal.aborted) {
          await sleep(delay, signal);
          if (signal.aborted) return;
          let r: UpdateResult | null = null;
          try {
            r = await serialize(() => doUpdate('scheduled', !deferred));
          } catch (e) {
            log(`update: check failed: ${errorMessage(e)}`);
          }
          deferred = r?.action === 'deferred';
          delay = deferred ? Math.min(o.checkMs, o.deferPollMs ?? 60_000) : o.checkMs;
        }
      })();
      return () => ctl.abort();
    },
    check: () => serialize(() => doCheck(true)),
    update: (mode) => serialize(() => doUpdate(mode)),
    applyNow: () => serialize(() => doUpdate('now')),
    status() {
      return {
        enabled: enabled && compiled,
        current: o.current,
        latest: latestRaw?.tag && (isStableTag(latestRaw.tag) || (pin && sameVersion(latestRaw.tag, pin))) ? latestRaw.tag : null,
        pin,
        staged: state.staged ?? null,
        applied: state.applied ?? null,
        failed: state.failed ?? null,
        pending: state.pending ?? null,
        deferredSince: state.deferredSince ?? null,
        lastCheck: state.lastCheck ?? null,
      };
    },
    finish: () => serialize(async () => {
      try {
        await init();
        await finishSwap({ fs, bin: o.paths.bin, statePath, now, log });
        state = await readState(fs, statePath);
      } catch (e) {
        log(`update: finish failed: ${errorMessage(e)}`);
      }
    }),
  };
}
