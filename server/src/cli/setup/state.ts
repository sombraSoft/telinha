// The setup screens' state: which question is on screen, the answers given so
// far, going back (answers on branches left behind stay stored), jumping to an
// answered step, the read-only lookups and the Review. Framework-free: the
// screens subscribe() and re-read the views, whose strings are already in the
// current language. Secret values never leave it except through values().
import type { Locale } from '../strings.ts';
import { type DiscordSetup, inviteUrl } from './discord.ts';
import type { HostInfo } from './host.ts';
import {
  checkDns,
  checkPort,
  checkRedirect,
  checkSecret,
  checkToken,
  type LookupDeps,
  type LookupState,
  loadChannels,
  loadGuilds,
  loadRoles,
  Runs,
  updateDuckDns,
} from './lookups.ts';
import {
  type AnswerId,
  type Answers,
  addressChoice,
  answered,
  catalogIndex,
  flowIds,
  groupFallback,
  guildName,
  HIDDEN_IDS,
  kindOf,
  type ModelEnv,
  portsValues,
  QUESTIONS,
  type QuestionId,
  type QuestionKind,
  question,
  redirectUri,
  SECRET_ANSWERS,
  type StepId,
  stepsFor,
  type Text,
  trayChoice,
  txt,
} from './model.ts';
import { type QKey, q } from './qstrings.ts';
import { defaultAnswers, keepHidden, type ResolveBase, resolveValues } from './resolve.ts';
import { publicPorts, type Values } from './steps.ts';
import type { TrayChoice } from './tray.ts';

export interface SetupStateInit {
  env: Omit<ModelEnv, 'lookups' | 'host'>;
  host: HostInfo | null;
  base: ResolveBase;
  locale: Locale;
  deps: LookupDeps;
  /** answersFromFlags(..., lenient) answers: the questions' defaults (override defaultAnswers). */
  preset: Answers;
  /** --yes: every question with a default counts as answered. */
  acceptDefaults: boolean;
  /** A file existed: defaults that came from it count as answered (re-run: every step jumpable). */
  rerun: boolean;
  /** Errors of the lenient pre-pass, shown once as a notice. */
  presetErrors: Text[];
}
export type Screen = 'question' | 'review';
/** summary: the answer in a few words; '\n' separates parts a narrow sidebar puts on their own lines. */
export interface StepView {
  id: StepId;
  label: string;
  state: 'done' | 'current' | 'pending';
  jumpable: boolean;
  summary: string;
}
export interface OptionView {
  value: string;
  label: string;
  desc?: string;
  preview?: string;
  subtle: boolean;
  chosen: boolean;
}
export type ActionId = 'retry' | 'keep' | 'quit' | 'open' | 'check';
/** A lookup's state with its texts in the current language. */
export type LookupView =
  | { state: 'idle' }
  | { state: 'running'; label: string }
  | { state: 'ok'; note?: string }
  | { state: 'warn'; note: string }
  | { state: 'rejected'; error: string }
  | { state: 'error'; error: string };
export interface QuestionView {
  id: QuestionId;
  step: StepId;
  kind: QuestionKind;
  title: string;
  question: string;
  hint: string[];
  options: OptionView[];
  placeholder?: string;
  /** text: the prefill (the answer given before); secret: never the value, only whether one is kept. */
  initial: string | string[];
  keepsSecret: boolean;
  /** What an empty Enter takes, e.g. "8443" (the field shows "default: 8443"); never set for a secret. */
  defaultText?: string;
  min?: number;
  optional: boolean;
  lookup: LookupView;
  actions: { id: ActionId; label: string }[];
  /** Why the answer was not taken: a validation error, or a rejected lookup (the same text as lookup.error). */
  error?: string;
  /** "Address · Step 2 of 6" */
  badge: string;
  /** A URL shown on its own line, wrapped and never cut: the redirect to add, the invite link. */
  link?: string;
}
export interface ReviewRow {
  step: string;
  label: string;
  value: string;
  kind: 'plain' | 'secret' | 'url';
}
export interface Notice {
  kind: 'locked' | 'presetErrors' | 'info';
  text: string;
}

interface Slot {
  state: LookupState;
  actions: ActionId[];
  running?: Text;
}

const STEP_LABEL: Record<StepId, QKey> = {
  where: 'stepWhere',
  address: 'stepAddress',
  discord: 'stepDiscord',
  media: 'stepMedia',
  ports: 'stepPorts',
  updates: 'stepUpdates',
  tray: 'stepTray',
  review: 'stepReview',
  install: 'stepInstall',
};
const ACTION_LABEL: Record<ActionId, QKey> = {
  retry: 'actionRetry',
  keep: 'actionKeep',
  quit: 'actionQuit',
  open: 'actionOpen',
  check: 'actionCheck',
};
const str = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '');
const list = (v: string | string[] | undefined): string[] =>
  Array.isArray(v)
    ? v
    : v
      ? v
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
const isHidden = (id: AnswerId) => (HIDDEN_IDS as readonly string[]).includes(id);

export class SetupState {
  readonly #init: SetupStateInit;
  readonly #env: ModelEnv;
  readonly #deps: LookupDeps;
  readonly #preset: Answers;
  readonly #user: Answers = {};
  #locale: Locale;
  #screen: Screen = 'question';
  #cur: QuestionId = 'hosting';
  readonly #listeners = new Set<() => void>();
  readonly #slots = new Map<QuestionId, Slot>();
  /** A submitted value waiting on a lookup's retry or "keep anyway". */
  #pending: { id: QuestionId; value: string | string[] } | null = null;
  #error: Text | null = null;
  #notice: { kind: Notice['kind']; text: Text[] } | null = null;
  /** Review notes by the question they are about (dropped when it leaves the flow). */
  readonly #notes = new Map<QuestionId, Text>();
  /** The invite card on the server question: none in the list, a --guild the bot is not in, or "another server". */
  #invite: { url: string; why: 'none' | 'missing' | 'other' } | null = null;
  #opened = false;
  #disposed = false;
  readonly #runs = new Runs();
  /** Bumped when the token changes: list results for the old token are dropped. */
  #gen = 0;
  readonly #loading = new Set<string>();
  readonly #clients = new Map<string, DiscordSetup>();

  constructor(init: SetupStateInit) {
    this.#init = init;
    this.#locale = init.locale;
    this.#env = { ...init.env, host: init.host, lookups: {}, locale: init.locale };
    this.#deps = init.deps;
    this.#preset = { ...init.preset };
    if (init.presetErrors.length) this.#notice = { kind: 'presetErrors', text: [...init.presetErrors] };
    const nav = this.#nav();
    this.#cur = nav[0]!;
    if (init.acceptDefaults) {
      const f = this.frontier();
      if (f >= nav.length) this.#screen = 'review';
      else this.#cur = nav[f]!;
    }
    this.#enter();
  }

  // --- reading

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  get locale(): Locale {
    return this.#locale;
  }

  screen(): Screen {
    return this.#screen;
  }

  /** Index of the first unanswered question; everything up to it is reachable. */
  frontier(): number {
    const eff = this.#effective();
    const nav = this.#navOf(eff);
    const i = nav.findIndex((id) => !this.#counted(id, eff));
    return i === -1 ? nav.length : i;
  }

  allAnswered(): boolean {
    return this.frontier() >= this.#nav().length;
  }

  /** What the file will hold; secrets included (for apply, never for the screen). */
  answers(): Answers {
    return structuredClone(this.#effective());
  }

  values(): Values {
    return resolveValues(this.#effective(), this.#env, this.#init.base);
  }

  webAddress(): string {
    return this.values().PUBLIC_URL ?? '';
  }

  notice(): Notice | null {
    return this.#notice && { kind: this.#notice.kind, text: this.#notice.text.map((t) => this.#t(t)).join('\n') };
  }

  /** Apply options that are not telinha.env keys. */
  applyOptions(): { sysctl: 'sudo' | 'manual' | null; canRotateCookie: boolean; tray: TrayChoice | null } {
    const eff = this.#effective();
    const sysctl = this.#navOf(eff).includes('sysctl') ? (eff.sysctl === 'manual' ? 'manual' : 'sudo') : null;
    return { sysctl, canRotateCookie: !!this.#init.base.file.COOKIE_SECRET, tray: trayChoice(eff, this.#env) };
  }

  current(): QuestionView {
    const env = this.#env;
    const eff = this.#effective();
    const id = this.#cur;
    const qd = question(id);
    const kind = kindOf(qd, env);
    const value = eff[id];
    const counted = this.#counted(id, eff);
    const opts = kind === 'select' || kind === 'multi' ? (qd.options?.(eff, env) ?? []) : [];
    const options: OptionView[] = opts.map((o) => ({
      value: o.value,
      label: this.#t(o.label),
      desc: o.desc && this.#t(o.desc),
      preview: o.preview && this.#t(o.preview),
      subtle: !!o.subtle,
      chosen: counted && (Array.isArray(value) ? value.includes(o.value) : value === o.value),
    }));
    let initial: string | string[] = '';
    if (kind === 'select')
      initial = typeof value === 'string' && opts.some((o) => o.value === value) ? value : (opts[0]?.value ?? '');
    else if (kind === 'multi') initial = list(value).filter((v) => opts.some((o) => o.value === v));
    else if (kind === 'text') {
      const given = this.#user[id];
      initial = given === undefined ? '' : Array.isArray(given) ? given.join(',') : given;
    }
    const shown = Array.isArray(value) ? value.join(',') : str(value);
    const hint = (qd.hint?.(eff, env) ?? []).map((t) => this.#t(t));
    let link = qd.link?.(eff, env) ?? undefined;
    const slot = this.#slots.get(id);
    let actions = slot?.actions ?? [];
    if (id === 'guild' && this.#invite && !env.offline) {
      hint.push('', this.#t(txt('inviteHelp')));
      link = this.#invite.url;
      actions = [...(this.#opened ? [] : (['open'] as const)), 'check'];
    }
    const lookup = this.#lookupView(slot);
    const placeholder = qd.placeholderFor?.(eff, env) ?? qd.placeholder;
    const steps = stepsFor(env);
    return {
      id,
      step: qd.step,
      kind,
      title: this.#t(qd.title),
      question: this.#t(qd.question),
      hint,
      options,
      placeholder: placeholder && this.#t(placeholder),
      initial,
      keepsSecret: kind === 'secret' && !!shown,
      defaultText: kind === 'text' && shown ? shown : undefined,
      min: qd.min,
      optional: !!qd.optional,
      lookup,
      actions: actions.map((a) => ({ id: a, label: this.#actionLabel(id, a) })),
      error: this.#error ? this.#t(this.#error) : lookup.state === 'rejected' ? lookup.error : undefined,
      badge: this.#t(
        txt('badge', { step: this.#t(txt(STEP_LABEL[qd.step])), n: steps.indexOf(qd.step) + 1, total: steps.length }),
      ),
      link: link || undefined,
    };
  }

  steps(): StepView[] {
    const eff = this.#effective();
    const counted = this.#countedAnswers(eff);
    const nav = this.#navOf(eff);
    const f = this.frontier();
    const all = f >= nav.length;
    const curStep = question(this.#cur).step;
    return stepsFor(this.#env).map((id): StepView => {
      let state: StepView['state'] = 'pending';
      let jumpable = false;
      if (id === 'review') {
        state = this.#screen === 'review' ? 'current' : 'pending';
        jumpable = all;
      } else if (id !== 'install') {
        const ids = nav.filter((x) => question(x).step === id);
        const first = ids.length ? nav.indexOf(ids[0]!) : -1;
        jumpable = first !== -1 && first <= f;
        if (this.#screen === 'review') state = 'done';
        else if (curStep === id) state = 'current';
        else if (first !== -1 && first < f && ids.every((x) => this.#counted(x, eff))) state = 'done';
      }
      return { id, label: this.#t(txt(STEP_LABEL[id])), state, jumpable, summary: this.#summary(id, counted) };
    });
  }

  reviewRows(): ReviewRow[] {
    const eff = this.#effective();
    const nav = this.#navOf(eff);
    const vals = resolveValues(eff, this.#env, this.#init.base);
    const rows: ReviewRow[] = [];
    let last: StepId | null = null;
    const push = (step: StepId, label: string, value: string, kind: ReviewRow['kind']) => {
      rows.push({ step: step === last ? '' : this.#t(txt(STEP_LABEL[step])), label, value, kind });
      last = step;
    };
    const lastAddress = nav.filter((id) => question(id).step === 'address').at(-1);
    for (const id of nav) {
      const qd = question(id);
      push(qd.step, this.#t(qd.title), this.#display(id, eff), kindOf(qd, this.#env) === 'secret' ? 'secret' : 'plain');
      if (id !== lastAddress) continue;
      push('address', this.#t(txt('reviewWeb')), vals.PUBLIC_URL ?? '', 'url');
      // Hidden answers that differ from the defaults (kept from the file or given as flags).
      if (vals.INGRESS === 'direct' && vals.ACME_DNS !== 'duckdns') {
        if (vals.HTTPS_PORT && vals.HTTPS_PORT !== '443')
          push('address', this.#t(txt('reviewHttpsPort')), vals.HTTPS_PORT, 'plain');
        if (vals.HTTP_PORT && vals.HTTP_PORT !== '80')
          push('address', this.#t(txt('reviewHttpPort')), vals.HTTP_PORT, 'plain');
      }
      if (vals.LIVEKIT_NODE_IP && addressChoice(eff) !== 'sslip')
        push('address', this.#t(txt('reviewNodeIp')), vals.LIVEKIT_NODE_IP, 'plain');
    }
    return rows;
  }

  /** Warnings for the Review: a redirect skipped, DuckDNS kept anyway, a DNS mismatch, intents off... */
  reviewNotes(): string[] {
    const nav = this.#nav();
    return [...this.#notes]
      .filter(([id]) => nav.includes(id))
      .sort(([a], [b]) => catalogIndex(a) - catalogIndex(b))
      .map(([, t]) => this.#t(t));
  }

  // --- changing

  setLocale(l: Locale): void {
    if (l === this.#locale) return;
    this.#locale = l;
    this.#env.locale = l;
    this.#cancel();
    this.#emit();
  }

  /** The machine is known: defaults of unanswered questions follow it. */
  setHost(h: HostInfo): void {
    this.#env.host = h;
    this.#normalize();
    this.#emit();
  }

  /** Submit for the current question: validate, then the lookup; resolves when settled. */
  async submit(value: string | string[]): Promise<'advanced' | 'stayed'> {
    if (this.#disposed || this.#screen !== 'question') return 'stayed';
    this.#clearNotice();
    this.#error = null;
    const env = this.#env;
    const id = this.#cur;
    const qd = question(id);
    const kind = kindOf(qd, env);
    const eff = this.#effective();
    let v: string | string[];
    if (kind === 'select') {
      const s = str(value);
      if (!(qd.options?.(eff, env) ?? []).some((o) => o.value === s)) return this.#stay(txt('notOffered'));
      if (id === 'guild' && s === '+invite') {
        // "Another server": the bot must be invited there first, then the list is read again.
        const appId = await this.#appId();
        if (this.#disposed) return 'stayed';
        this.#invite = { url: inviteUrl(appId ?? str(eff.clientId)), why: 'other' };
        this.#emit();
        return 'stayed';
      }
      v = s;
    } else if (kind === 'multi') {
      const offered = new Set((qd.options?.(eff, env) ?? []).map((o) => o.value));
      v = list(value).filter((x) => offered.has(x));
    } else {
      let s = (Array.isArray(value) ? value.join(',') : value).trim();
      // An empty Enter takes the default; for a secret, keeps the current one.
      if (!s) s = Array.isArray(eff[id]) ? (eff[id] as string[]).join(',') : str(eff[id]);
      if (!s && !qd.optional) return this.#stay(txt('required'));
      v = s;
    }
    if (!(v === '' && qd.optional)) {
      const bad = qd.validate?.(v, eff, env) ?? null;
      if (bad) return this.#stay(bad);
    }
    if (typeof v === 'string' && v !== '' && qd.normalize) v = qd.normalize(v, env);
    return this.#lookupAndAccept(id, v, eff);
  }

  async action(id: ActionId): Promise<void> {
    if (this.#disposed || this.#screen !== 'question') return;
    this.#clearNotice();
    const cur = this.#cur;
    const eff = this.#effective();
    const guild = str(eff.guild);
    if (id === 'quit') return; // the screens end the run
    if (id === 'open') {
      if (!this.#invite || this.#opened) return;
      // At most once: a browser tab per click is not what anyone wants.
      this.#opened = true;
      this.#emit();
      try {
        await this.#deps.openUrl(this.#invite.url);
      } catch {
        if (!this.#disposed) this.#notice = { kind: 'info', text: [txt('openFailed')] };
      }
      this.#emit();
      return;
    }
    if (id === 'keep' && cur === 'turn') {
      // The record is not there yet: TURN stays on, the doctor's turn check says when it works.
      const p = this.#pending;
      if (!p || p.id !== cur) return;
      this.#notes.set(cur, txt('turnKept', { host: `turn.${str(eff.domain)}` }));
      this.#slots.delete(cur);
      this.#accept(cur, p.value);
      this.#emit();
      return;
    }
    if (id === 'keep') {
      // DuckDNS refused the token: keep it anyway (the running service retries), noted for the Review.
      const p = this.#pending;
      if (cur !== 'duckToken' || !p || p.id !== cur) return;
      this.#notes.set(cur, txt('duckKept', { name: `${str(eff.duckName)}.duckdns.org` }));
      this.#slots.delete(cur);
      this.#accept(cur, p.value);
      this.#emit();
      return;
    }
    if (id === 'retry' && cur === 'duckToken') {
      // "Type the token again": back to an empty field.
      this.#pending = null;
      this.#slots.delete(cur);
      this.#emit();
      return;
    }
    if (cur === 'guild') {
      if (id === 'check') this.#env.lookups.guilds = undefined;
      return this.#loadGuilds();
    }
    if (cur === 'role') {
      if (this.#env.lookups.roles) delete this.#env.lookups.roles[guild];
      return this.#loadRoles(guild);
    }
    if (cur === 'channels') {
      if (this.#env.lookups.channels) delete this.#env.lookups.channels[guild];
      return this.#loadChannels(guild);
    }
    if (id === 'retry' && this.#pending?.id === cur) await this.submit(this.#pending.value);
  }

  /** Previous question in the flow; from the Review, the last one. False on the first question. */
  back(): boolean {
    if (this.#disposed) return false;
    this.#cancel();
    this.#clearNotice();
    const nav = this.#nav();
    if (this.#screen === 'review') {
      this.#moveTo(nav[nav.length - 1]!);
      this.#emit();
      return true;
    }
    const i = nav.indexOf(this.#cur);
    if (i <= 0) {
      this.#emit();
      return false;
    }
    this.#moveTo(nav[i - 1]!);
    this.#emit();
    return true;
  }

  /** The first question of an answered step (or the Review once everything is answered). */
  jump(step: StepId): boolean {
    if (this.#disposed) return false;
    if (step === 'review') return this.toReview();
    const nav = this.#nav();
    const first = step === 'install' ? -1 : nav.findIndex((id) => question(id).step === step);
    if (first === -1 || first > this.frontier()) return this.#locked();
    this.#cancel();
    this.#clearNotice();
    this.#moveTo(nav[first]!);
    this.#emit();
    return true;
  }

  toReview(): boolean {
    if (this.#disposed) return false;
    if (!this.allAnswered()) return this.#locked();
    this.#cancel();
    this.#clearNotice();
    this.#error = null;
    this.#screen = 'review';
    this.#emit();
    return true;
  }

  /** Stops listening and drops every lookup still running. */
  dispose(): void {
    this.#disposed = true;
    this.#runs.cancel();
    this.#listeners.clear();
  }

  // --- answers

  /** Every question's value: given > flags > the file's (or the code's) default; hidden ones while they fit. */
  #effective(): Answers {
    const a: Answers = {};
    for (const qd of QUESTIONS) {
      const v = this.#user[qd.id] ?? this.#preset[qd.id] ?? qd.default(a, this.#env);
      if (v !== undefined) a[qd.id] = v;
    }
    const defaults = defaultAnswers(this.#env);
    const presetSource: Answers = { ...defaults };
    for (const id of HIDDEN_IDS) delete presetSource[id];
    Object.assign(a, keepHidden(a, defaults), keepHidden(a, { ...presetSource, ...this.#preset }));
    return a;
  }

  /** Answered: given here, or a default that counts (--yes; a re-run's value from the file or the flags). */
  #counted(id: AnswerId, eff: Answers): boolean {
    if (answered(this.#user, id)) return true;
    if (!answered(eff, id)) return false;
    if (isHidden(id) || this.#init.acceptDefaults) return true;
    if (!this.#init.rerun) return false;
    if (this.#preset[id] !== undefined) return true;
    return question(id as QuestionId).fromFile?.(eff, this.#env) ?? true;
  }

  #countedAnswers(eff: Answers): Answers {
    const a: Answers = {};
    for (const id of Object.keys(eff) as AnswerId[]) if (this.#counted(id, eff)) a[id] = eff[id];
    return a;
  }

  /** The flow as far as it is decided: a branch opens once its question is answered. */
  #navOf(eff: Answers): QuestionId[] {
    return flowIds(this.#countedAnswers(eff), this.#env);
  }

  #nav(): QuestionId[] {
    return this.#navOf(this.#effective());
  }

  async #lookupAndAccept(id: QuestionId, v: string | string[], eff: Answers): Promise<'advanced' | 'stayed'> {
    const env = this.#env;
    const online = !env.offline;
    const s = str(v);
    if (id === 'discordToken' && online) {
      if (s !== str(eff.discordToken) || !env.lookups.app) this.#forgetDiscord();
      if (env.lookups.app) return this.#accepted(id, v);
      return this.#run(id, v, txt('discordChecking'), async () => {
        const r = await checkToken(this.#client(s));
        return {
          state: r.state,
          actions: r.state.state === 'error' ? ['retry', 'quit'] : [],
          // The PATCH that switches them on is a write: the install does it.
          more: r.intentsOff ? [txt('intentsOff')] : [],
          apply: () => {
            env.lookups.app = r.app;
            // Online the client id comes from the token: counted although not asked.
            this.#user.clientId = r.app!.id;
            if (r.intentsOff) this.#notes.set(id, txt('intentsOff'));
            else this.#notes.delete(id);
            void this.#loadGuilds(s);
          },
        };
      });
    }
    if (id === 'clientSecret' && online) {
      return this.#run(id, v, txt('secretChecking'), async () => {
        const app = await this.#app();
        const state: LookupState = app
          ? await checkSecret(this.#client(str(eff.discordToken)), app.id, s)
          : { state: 'warn', note: txt('secretUnchecked', { error: '?' }) };
        return {
          state,
          actions: [],
          apply: () => (state.state === 'warn' ? this.#notes.set(id, state.note) : this.#notes.delete(id)),
        };
      });
    }
    if (id === 'redirect') {
      const uri = redirectUri(eff, env);
      if (s === 'skip') {
        this.#notes.set(id, txt('redirectSkipped', { uri }));
        return this.#accepted(id, v);
      }
      return this.#run(id, v, txt('redirectChecking'), async () => {
        const r = await checkRedirect(this.#client(str(eff.discordToken)), uri);
        if (r.app) env.lookups.app = r.app;
        return {
          state: r.state,
          actions: r.state.state === 'error' ? ['retry'] : [],
          stay: r.state.state === 'warn',
          apply: () => this.#notes.delete(id),
        };
      });
    }
    if (id === 'duckToken') {
      const name = str(eff.duckName);
      return this.#run(id, v, txt('duckChecking', { name: `${name}.duckdns.org` }), async () => {
        const state = await updateDuckDns(this.#deps, name, s, env.host?.publicIp ?? null);
        return {
          state,
          actions: state.state === 'error' ? ['retry', 'keep'] : [],
          apply: () => this.#notes.delete(id),
        };
      });
    }
    if (id === 'domain') {
      return this.#run(id, v, txt('dnsChecking', { host: s }), async () => {
        const state = await checkDns(this.#deps, s, env.host?.publicIp ?? null);
        return {
          state,
          actions: [],
          apply: () => (state.state === 'warn' ? this.#notes.set(id, state.note) : this.#notes.delete(id)),
        };
      });
    }
    if (id === 'turn' && s === 'on' && addressChoice(eff) === 'domain') {
      // turn.<host> must resolve to this server before Caddy can get its certificate.
      const host = `turn.${str(eff.domain)}`;
      return this.#run(id, v, txt('turnChecking', { host }), async () => {
        const state = await checkDns(this.#deps, host, env.host?.publicIp ?? null);
        return {
          state,
          actions: state.state === 'warn' ? ['retry', 'keep'] : [],
          stay: state.state === 'warn',
          apply: () => this.#notes.delete(id),
        };
      });
    }
    if ((id === 'mediaTcp' || id === 'mediaUdp') && !env.docker) {
      return this.#run(id, v, null, async () => {
        const state = await checkPort(this.#deps, id === 'mediaTcp' ? 'TCP' : 'UDP', Number(s));
        return {
          state,
          actions: [],
          apply: () => (state.state === 'warn' ? this.#notes.set(id, state.note) : this.#notes.delete(id)),
        };
      });
    }
    return this.#accepted(id, v);
  }

  /**
   * Runs one lookup for a submitted value. ok and warn take the answer (warn stays where
   * `stay` says so: the redirect is still missing); rejected and error stay on the question.
   * A result whose run is no longer the newest is dropped.
   */
  async #run(
    id: QuestionId,
    v: string | string[],
    running: Text | null,
    fn: () => Promise<{ state: LookupState; actions: ActionId[]; stay?: boolean; more?: Text[]; apply(): void }>,
  ): Promise<'advanced' | 'stayed'> {
    const run = this.#runs.next();
    this.#pending = { id, value: v };
    this.#slots.set(id, { state: { state: 'running' }, actions: [], running: running ?? undefined });
    this.#emit();
    const r = await fn();
    if (this.#disposed || !this.#runs.current(run) || this.#cur !== id || this.#screen !== 'question') return 'stayed';
    this.#slots.set(id, { state: r.state, actions: r.actions });
    const ok = r.state.state === 'ok' || (r.state.state === 'warn' && !r.stay);
    if (!ok) {
      this.#emit();
      return 'stayed';
    }
    r.apply();
    const note = r.state.state === 'ok' ? r.state.note : r.state.state === 'warn' ? r.state.note : undefined;
    this.#accept(id, v);
    if (note) this.#notice = { kind: 'info', text: [note, ...(r.more ?? [])] };
    this.#emit();
    return 'advanced';
  }

  #accepted(id: QuestionId, v: string | string[]): 'advanced' {
    this.#accept(id, v);
    this.#emit();
    return 'advanced';
  }

  /** Stores the answer and moves on to the next question in the flow (or the Review). */
  #accept(id: QuestionId, v: string | string[]): void {
    const before = this.#effective()[id];
    this.#user[id] = v;
    this.#pending = null;
    this.#error = null;
    const slot = this.#slots.get(id);
    if (slot && slot.state.state !== 'ok') this.#slots.delete(id);
    if (id === 'guild' && before !== v) this.#invite = null;
    if (id === 'lang' && (v === 'en' || v === 'pt-BR')) {
      // The whole screen switches at once.
      this.#locale = v;
      this.#env.locale = v;
    }
    const nav = this.#nav();
    const i = nav.indexOf(id);
    const next = i >= 0 ? nav[i + 1] : nav.find((x) => catalogIndex(x) > catalogIndex(id));
    if (next) this.#moveTo(next);
    else {
      this.#screen = 'review';
      this.#cancel();
    }
  }

  #moveTo(id: QuestionId): void {
    if (this.#cur === 'guild' && id !== 'guild' && this.#invite?.why === 'other') this.#invite = null;
    this.#cur = id;
    this.#screen = 'question';
    this.#error = null;
    this.#pending = null;
    for (const [qid, s] of this.#slots)
      if (s.state.state === 'error' || s.state.state === 'rejected') this.#slots.delete(qid);
    this.#enter();
  }

  /** On entering a list question: read the list it needs. */
  #enter(): void {
    if (this.#env.offline || this.#screen !== 'question') return;
    const guild = str(this.#effective().guild);
    if (this.#cur === 'guild' && !this.#env.lookups.guilds) void this.#loadGuilds();
    if (this.#cur === 'role' && guild && !this.#env.lookups.roles?.[guild]) void this.#loadRoles(guild);
    if (this.#cur === 'channels' && guild && !this.#env.lookups.channels?.[guild]) void this.#loadChannels(guild);
  }

  /** The current question left the flow (the machine changed what is asked): the nearest one after it. */
  #normalize(): void {
    if (this.#screen !== 'question') return;
    const nav = this.#nav();
    if (nav.includes(this.#cur)) return;
    const next = nav.find((x) => catalogIndex(x) > catalogIndex(this.#cur)) ?? nav[nav.length - 1]!;
    this.#moveTo(next);
  }

  // --- Discord

  #client(token: string): DiscordSetup {
    let c = this.#clients.get(token);
    if (!c) {
      c = this.#deps.discord(token);
      this.#clients.set(token, c);
    }
    return c;
  }

  /** A new token: what the old one found no longer applies. */
  #forgetDiscord(): void {
    this.#gen++;
    this.#env.lookups = {};
    this.#loading.clear();
    delete this.#user.clientId;
    this.#invite = null;
    for (const id of ['discordToken', 'clientSecret', 'redirect', 'guild', 'role', 'channels'] as const) {
      this.#slots.delete(id);
      this.#notes.delete(id);
    }
  }

  /** The application behind the token, read once (a re-run that kept the token never checked it). */
  async #app() {
    if (this.#env.lookups.app) return this.#env.lookups.app;
    const gen = this.#gen;
    const r = await checkToken(this.#client(str(this.#effective().discordToken)));
    if (r.app && gen === this.#gen) this.#env.lookups.app = r.app;
    return r.app ?? null;
  }

  async #appId(): Promise<string | null> {
    return (await this.#app())?.id ?? (str(this.#effective().clientId) || null);
  }

  async #load(key: string, slot: QuestionId, running: Text, fn: () => Promise<Slot | null>): Promise<void> {
    if (this.#loading.has(key) || this.#disposed) return;
    const gen = this.#gen;
    this.#loading.add(key);
    this.#slots.set(slot, { state: { state: 'running' }, actions: [], running });
    this.#emit();
    try {
      const s = await fn();
      if (this.#disposed || gen !== this.#gen) return;
      if (s) this.#slots.set(slot, s);
      else this.#slots.delete(slot);
    } finally {
      if (gen === this.#gen) this.#loading.delete(key);
    }
    this.#emit();
  }

  #loadGuilds(token = str(this.#effective().discordToken)): Promise<void> {
    if (!token) return Promise.resolve();
    return this.#load('guilds', 'guild', txt('guildsLoading'), async () => {
      const gen = this.#gen;
      const r = await loadGuilds(this.#client(token));
      if (gen !== this.#gen) return null;
      if (r.state.state === 'error') return { state: r.state, actions: ['retry'] };
      this.#env.lookups.guilds = r.guilds;
      const appId = await this.#appId();
      if (gen !== this.#gen) return null;
      const wanted = str(this.#preset.guild);
      if (!r.guilds!.length) {
        this.#invite = { url: inviteUrl(appId ?? ''), why: 'none' };
        return { state: r.state, actions: [] };
      }
      if (wanted && !this.#user.guild && !r.guilds!.some((g) => g.id === wanted)) {
        // --guild names a server the bot is not in: the invite goes straight there.
        this.#invite = { url: inviteUrl(appId ?? '', wanted), why: 'missing' };
        return { state: { state: 'warn', note: txt('guildMissing', { id: wanted }) }, actions: [] };
      }
      this.#invite = null;
      return null;
    });
  }

  #loadRoles(guild: string): Promise<void> {
    const token = str(this.#effective().discordToken);
    if (!token || !guild) return Promise.resolve();
    return this.#load(`roles:${guild}`, 'role', txt('rolesLoading'), async () => {
      const r = await loadRoles(this.#client(token), guild);
      if (r.state.state === 'error') return { state: r.state, actions: ['retry'] };
      this.#env.lookups.roles ??= {};
      this.#env.lookups.roles[guild] = r.roles!;
      return null;
    });
  }

  #loadChannels(guild: string): Promise<void> {
    const eff = this.#effective();
    const token = str(eff.discordToken);
    if (!token || !guild) return Promise.resolve();
    return this.#load(`channels:${guild}`, 'channels', txt('channelsLoading'), async () => {
      const r = await loadChannels(this.#client(token), guild, guildName(eff, this.#env) || guild);
      if (r.state.state === 'error') return { state: r.state, actions: ['retry'] };
      this.#env.lookups.channels ??= {};
      this.#env.lookups.channels[guild] = r.channels!;
      return r.state.state === 'rejected' ? { state: r.state, actions: ['check'] } : null;
    });
  }

  // --- small helpers

  #t(t: Text): string {
    return 'raw' in t ? t.raw : q(this.#locale, t.key, t.params);
  }

  #actionLabel(qid: QuestionId, a: ActionId): string {
    if (qid === 'duckToken' && a === 'retry') return this.#t(txt('actionTypeAgain'));
    if (qid === 'guild' && a === 'check') return this.#t(txt('actionAdded'));
    if (qid === 'turn' && a === 'retry') return this.#t(txt('actionTurnCheck'));
    if (qid === 'turn' && a === 'keep') return this.#t(txt('actionTurnKeep'));
    return this.#t(txt(ACTION_LABEL[a]));
  }

  #lookupView(slot: Slot | undefined): LookupView {
    const s = slot?.state;
    if (!s || s.state === 'idle') return { state: 'idle' };
    if (s.state === 'running') return { state: 'running', label: slot.running ? this.#t(slot.running) : '' };
    if (s.state === 'ok') return s.note ? { state: 'ok', note: this.#t(s.note) } : { state: 'ok' };
    if (s.state === 'warn') return { state: 'warn', note: this.#t(s.note) };
    return { state: s.state, error: this.#t(s.error) };
  }

  /** What the Review and the sidebar show for an answer: labels, never a secret's characters. */
  #display(id: QuestionId, eff: Answers): string {
    const env = this.#env;
    const qd = question(id);
    const kind = kindOf(qd, env);
    const v = eff[id];
    if (kind === 'secret') {
      const key = SECRET_ANSWERS[id];
      return this.#t(txt(key && this.#init.base.file[key] === v ? 'reviewKept' : 'reviewSet'));
    }
    if (id === 'group' && !str(v)) return groupFallback(eff, env) || this.#t(txt('groupDefault'));
    if (kind === 'text') return Array.isArray(v) ? v.join(',') : str(v);
    const opts = qd.options?.(eff, env) ?? [];
    const label = (x: string) => {
      const o = opts.find((p) => p.value === x);
      return o ? this.#t(o.label) : x;
    };
    return Array.isArray(v) ? v.map(label).join(', ') : label(str(v));
  }

  #summary(step: StepId, a: Answers): string {
    const env = this.#env;
    switch (step) {
      case 'where':
        return a.hosting === 'home' ? this.#t(txt('sumHome')) : a.hosting === 'vps' ? this.#t(txt('sumVps')) : '';
      case 'address': {
        const choice = addressChoice(a);
        if (choice === 'tunnel') return this.#t(txt('sumTunnel'));
        if (choice === 'duckdns-home') return this.#t(txt('sumDuckHome', { port: str(a.httpsPort) || '8443' }));
        if (choice === 'duckdns') return this.#t(txt('sumDuck'));
        if (choice === 'sslip') return this.#t(txt('sumSslip'));
        if (choice === 'external') return this.#t(txt('sumProxy'));
        return choice === 'domain' ? str(a.domain) : '';
      }
      case 'discord': {
        if (!str(a.command) && !str(a.guild)) return '';
        // The server by name once Discord listed it (an id means nothing in a sidebar).
        const name = guildName(a, env);
        return `/${str(a.command) || 'telinha'}${name ? ` · ${name}` : ''}`;
      }
      case 'media':
        if (a.media === 'cloud') return this.#t(txt('sumMediaCloud'));
        if (a.media !== 'self') return '';
        return this.#t(txt(a.turn === 'on' ? 'sumTurn' : 'sumMediaSelf'));
      case 'ports': {
        if (!a.mediaPorts) return '';
        // Grouped by protocol, one group per line ("TCP 7881, 8443" / "UDP 7882"): the sidebar joins them when they fit.
        const groups = new Map<string, string[]>();
        for (const p of publicPorts(portsValues(a, env))) {
          const [proto = '', port = ''] = p.split(' ');
          groups.set(proto, [...(groups.get(proto) ?? []), port]);
        }
        return [...groups]
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([proto, ports]) => `${proto} ${ports.join(', ')}`)
          .join('\n');
      }
      case 'updates':
        return a.autoUpdate === 'on' ? this.#t(txt('sumOn')) : a.autoUpdate === 'off' ? this.#t(txt('sumOff')) : '';
      case 'tray':
        if (a.tray === 'no') return this.#t(txt('sumTrayOff'));
        if (a.tray !== 'yes') return '';
        return this.#t(txt(a.trayAutostart === 'yes' ? 'sumTrayAuto' : 'sumTrayOn'));
      default:
        return '';
    }
  }

  #stay(error: Text): 'stayed' {
    this.#error = error;
    this.#emit();
    return 'stayed';
  }

  #locked(): false {
    this.#notice = { kind: 'locked', text: [txt('locked')] };
    this.#emit();
    return false;
  }

  /** The presetErrors notice shows until the first thing the user does; info notices as long. */
  #clearNotice(): void {
    this.#notice = null;
  }

  /** Drops running lookups (the user moved on or switched the language). */
  #cancel(): void {
    this.#runs.cancel();
    for (const [id, s] of this.#slots) if (s.state.state === 'running' && !this.#loadingFor(id)) this.#slots.delete(id);
  }

  #loadingFor(id: QuestionId): boolean {
    return (
      (id === 'guild' && this.#loading.has('guilds')) ||
      [...this.#loading].some((k) => k.startsWith(`${id === 'role' ? 'roles' : id}:`))
    );
  }

  #emit(): void {
    if (this.#disposed) return;
    for (const fn of [...this.#listeners]) fn();
  }
}

export type { LookupDeps };
