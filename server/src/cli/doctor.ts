// `telinha doctor [--json] [--no-phone] [--local]`: runs the checks with a live
// table, then (with the service running) the phone test: a one-time link and
// QR code the user opens on mobile data, which measures the HTTPS, LiveKit
// signaling, TCP and UDP media paths from outside the network. Exit 1 when
// anything failed.
import { existsSync } from 'node:fs';
import { loadConfig, type Config } from '../config.ts';
import { CHECKS, checkTitle, runChecks } from '../doctor/checks.ts';
import { renderQr } from '../doctor/qr.ts';
import type { Check, CheckContext, CheckResult, CheckStatus, NatProberLike, ServiceStatusFn, UpdateStateLike } from '../doctor/types.ts';
import { loadEnvFile, mergeEnv } from '../envfile.ts';
import * as nat from '../nat/index.ts';
import { serviceManager } from '../service/index.ts';
import { latestStable } from '../update/github.ts';
import { readState, statePath } from '../update/state.ts';
import { nodeFs } from '../update/types.ts';
import { GLOBAL_FLAGS, parseArgs, UsageError, type CliContext, type ParsedArgs } from './args.ts';
import { createControlClient, type ControlClient, type DoctorReport, type DoctorSessionState } from './control.ts';
import { defineStrings, ts } from './strings.ts';
import { createTerm, type Term, type TermOut } from './term.ts';

// --no-phone is the parser's --no-<boolean>.
export const DOCTOR_FLAGS = { json: 'boolean', phone: 'boolean', local: 'boolean' } as const;
export const DOCTOR_SPEC = { flags: { ...GLOBAL_FLAGS, ...DOCTOR_FLAGS } } as const;

/** How long the CLI waits for the phone. */
export const PHONE_WAIT_MS = 10 * 60_000;
// Under Bun.serve's 10 s idle timeout: the service lifts it for control calls (http.ts), this is the margin.
const POLL_MS = 8_000;

const t = defineStrings({
  checking: 'Checking {title}...',
  summary: '{ok} ok, {warn} warning(s), {fail} failure(s), {skip} skipped',
  phoneTitle: 'Phone test',
  phoneOpen: 'Open this on your phone with Wi-Fi OFF (mobile data):',
  phoneWaiting: 'Waiting up to 10 minutes... (Ctrl+C to skip)',
  phoneOpened: 'Opened on the phone, testing...',
  phoneSkipped: 'Phone test skipped.',
  phoneExpired: 'The link expired before the phone finished the test. Run telinha doctor again.',
  phoneNotRunning: 'Start Telinha to run the phone test (telinha service start).',
  phoneNoTty: 'Phone test skipped: it needs an interactive terminal (or pass --no-phone).',
  phoneError: 'Phone test could not start: {error}',
  rowHttps: 'HTTPS',
  rowSignaling: 'LiveKit connection',
  rowPublish: 'Sending video',
  rowInitial: 'First path',
  rowUdp: 'UDP {port}',
  rowTcp: 'TCP {port}',
  latency: '{ms} ms',
  initialPath: '{protocol} to {ip}, {ms} ms',
  initialNone: 'no media path',
  works: 'works',
  worksRtt: 'works, {ms} ms',
  failed: 'failed',
  hintSignaling: 'Telinha is not reachable at PUBLIC_URL from the internet: check the DNS, TLS and router checks above.',
  hintBoth: 'The HTTP side works, but the media ports are closed: open TCP {tcp} and UDP {udp} to this machine (router forwarding at home; the provider\'s firewall or security group on a VPS; and this machine\'s own firewall).',
  hintUdp: 'UDP {udp} is not reachable from the internet: open it to this machine (router forwarding, or the VPS provider\'s firewall); video falls back to TCP, with more delay.',
  hintTcp: 'TCP {tcp} is not reachable from the internet: open it to this machine (router forwarding, or the VPS provider\'s firewall); it is needed where UDP is blocked.',
  hintIp: 'LiveKit advertises {ip}, which is not the public IP {publicIp}: check LIVEKIT_NODE_IP.',
  phoneAllGood: 'The phone reached Telinha over UDP and TCP.',
}, {
  checking: 'Verificando {title}...',
  summary: '{ok} ok, {warn} aviso(s), {fail} falha(s), {skip} pulada(s)',
  phoneTitle: 'Teste no celular',
  phoneOpen: 'Abra isto no celular com o Wi-Fi DESLIGADO (dados móveis):',
  phoneWaiting: 'Esperando até 10 minutos... (Ctrl+C pula)',
  phoneOpened: 'Aberto no celular, testando...',
  phoneSkipped: 'Teste no celular pulado.',
  phoneExpired: 'O link expirou antes de o celular terminar o teste. Rode telinha doctor de novo.',
  phoneNotRunning: 'Inicie a Telinha pra fazer o teste no celular (telinha service start).',
  phoneNoTty: 'Teste no celular pulado: ele precisa de um terminal interativo (ou use --no-phone).',
  phoneError: 'O teste no celular não pôde começar: {error}',
  rowHttps: 'HTTPS',
  rowSignaling: 'Conexão com o LiveKit',
  rowPublish: 'Envio de vídeo',
  rowInitial: 'Primeiro caminho',
  rowUdp: 'UDP {port}',
  rowTcp: 'TCP {port}',
  latency: '{ms} ms',
  initialPath: '{protocol} até {ip}, {ms} ms',
  initialNone: 'nenhum caminho de mídia',
  works: 'funciona',
  worksRtt: 'funciona, {ms} ms',
  failed: 'falhou',
  hintSignaling: 'A Telinha não é acessível pela internet no PUBLIC_URL: veja as verificações de DNS, TLS e roteador acima.',
  hintBoth: 'O lado HTTP funciona, mas as portas de mídia estão fechadas: libere TCP {tcp} e UDP {udp} pra esta máquina (redirecionamento no roteador em casa; o firewall ou security group do provedor numa VPS; e o firewall desta máquina).',
  hintUdp: 'A porta UDP {udp} não é acessível pela internet: libere pra esta máquina (redirecionamento no roteador, ou o firewall do provedor da VPS); o vídeo cai pro TCP, com mais atraso.',
  hintTcp: 'A porta TCP {tcp} não é acessível pela internet: libere pra esta máquina (redirecionamento no roteador, ou o firewall do provedor da VPS); ela é necessária onde o UDP é bloqueado.',
  hintIp: 'O LiveKit anuncia {ip}, que não é o IP público {publicIp}: confira o LIVEKIT_NODE_IP.',
  phoneAllGood: 'O celular chegou na Telinha por UDP e TCP.',
});
type StrKey = Parameters<typeof t>[1];

export type DoctorControl = Pick<ControlClient, 'available' | 'status' | 'doctorSession' | 'doctorWait'>;

export interface DoctorCliDeps {
  checks?: readonly Check[];
  /** Overrides parts of the CheckContext built from ctx (tests). */
  context?: Partial<CheckContext>;
  control?: DoctorControl;
  /** Where the table and the phone test are written; JSON goes to ctx.stdout. */
  out?: TermOut;
  now?: () => number;
  qr?: (url: string) => string;
  /** Registers a Ctrl+C handler for the phone wait; returns its remover. */
  onInterrupt?: (fn: () => void) => () => void;
  checkTimeoutMs?: number;
}

export interface PhoneOutcome {
  status: CheckStatus;
  report?: DoctorReport;
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };

function readUpdateState(path: string): Promise<UpdateStateLike | null> {
  if (!existsSync(path)) return Promise.resolve(null);
  return readState(nodeFs(), path).then((s) => (Object.keys(s).length ? (s as UpdateStateLike) : null));
}

/** The checks' context from the merged environment (telinha.env, then the process environment over it). */
export async function buildCheckContext(ctx: CliContext, o: { local: boolean; control: DoctorControl }): Promise<CheckContext> {
  let fileVars: Record<string, string> = {};
  let configError: string | null = null;
  try {
    fileVars = loadEnvFile(ctx.envFile)?.vars ?? {};
  } catch (e) {
    configError = `${ctx.envFile}: ${(e as Error).message}`;
  }
  const env = mergeEnv(fileVars, ctx.env);
  let config: Config | null = null;
  if (!configError) {
    try {
      config = loadConfig(env, { compiled: ctx.compiled });
    } catch (e) {
      configError = (e as Error).message;
    }
  }
  const manager = serviceManager({
    platform: process.platform, isRoot: process.getuid?.() === 0, paths: ctx.paths, envFile: ctx.envFile, env: ctx.env,
  });
  // Only a native install has a service to report on: Docker and dev skip the check.
  const service: ServiceStatusFn | null = ctx.compiled && manager ? () => manager.status() : null;
  const natProbe: NatProberLike = { probe: () => nat.probe() };
  return {
    env, envFile: ctx.envFile, paths: ctx.paths, config, configError, fetch, locale: ctx.locale, local: o.local,
    nat: natProbe, service, control: o.control, compiled: ctx.compiled, version: ctx.version,
    latestTag: () => latestStable(),
    updateState: await readUpdateState(statePath(ctx.paths)),
  };
}

/** Plain-language hints for a phone report (keys of this file's dictionary with their params). */
export function phoneHints(r: DoctorReport, ports: { tcp: number; udp: number }, publicIp?: string | null): { key: StrKey; params: Record<string, string | number> }[] {
  const p = { tcp: ports.tcp, udp: ports.udp };
  if (!r.signaling.ok) return [{ key: 'hintSignaling', params: p }];
  const out: { key: StrKey; params: Record<string, string | number> }[] = [];
  if (!r.tcp.ok && !r.udp.ok) out.push({ key: 'hintBoth', params: p });
  else if (!r.udp.ok) out.push({ key: 'hintUdp', params: p });
  else if (!r.tcp.ok) out.push({ key: 'hintTcp', params: p });
  const ip = r.initial?.candidateIp;
  if (ip && publicIp && ip !== publicIp && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) out.push({ key: 'hintIp', params: { ip, publicIp } });
  return out;
}

export function phoneStatus(r: DoctorReport): CheckStatus {
  if (!r.signaling.ok || !r.https.ok || (!r.tcp.ok && !r.udp.ok)) return 'fail';
  if (!r.tcp.ok || !r.udp.ok || !r.publish.ok) return 'warn';
  return 'ok';
}

export async function run(args: ParsedArgs, ctx: CliContext, deps: DoctorCliDeps = {}): Promise<number> {
  let flags: { json?: boolean; phone?: boolean; local?: boolean };
  try {
    flags = parseArgs(ctx.argv, DOCTOR_SPEC, { locale: ctx.locale }).flags;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    ctx.stderr(e.message);
    ctx.stderr(ts(ctx.locale, 'helpDoctor'));
    return 2;
  }
  const json = !!flags.json;
  const local = !!flags.local;
  const now = deps.now ?? Date.now;
  const L = ctx.locale;
  const s = (key: StrKey, params?: Record<string, string | number>) => t(L, key, params);
  // JSON owns stdout; the human side (phone link, QR) goes to stderr then.
  const out: TermOut = deps.out ?? (json ? process.stderr : process.stdout);
  const term = createTerm({ stdout: out, tty: ctx.tty, yes: ctx.yes, locale: L, env: ctx.env });
  const control = deps.control ?? createControlClient({ paths: ctx.paths, envFile: ctx.envFile, env: ctx.env });

  const checkCtx: CheckContext = { ...(await buildCheckContext(ctx, { local, control })), ...deps.context, local };
  const checks = deps.checks ?? CHECKS;

  // Live table: a "Checking ..." line that the result replaces (TTY with colours only).
  const width = Math.max(0, ...checks.map((c) => checkTitle(c.id, L).length));
  const live = !json && term.colors;
  const paintPending = (i: number) => {
    const c = checks[i];
    if (live && c) out.write(`  ${term.style.dim(s('checking', { title: checkTitle(c.id, L) }))}`);
  };
  let index = 0;
  paintPending(index);
  const results = await runChecks(checks, checkCtx, (r) => {
    if (!json) {
      if (live) out.write('\r\x1b[2K');
      printResult(term, r, width);
    }
    paintPending(++index);
  }, deps.checkTimeoutMs ? { timeoutMs: deps.checkTimeoutMs } : {});

  const count = (st: CheckStatus) => results.filter((r) => r.status === st).length;
  if (!json) {
    term.line();
    term.info(s('summary', { ok: count('ok'), warn: count('warn'), fail: count('fail'), skip: count('skip') }));
  }

  let phone: PhoneOutcome | null = null;
  if (flags.phone !== false && !local) {
    if (!ctx.tty) {
      if (!json) term.info(s('phoneNoTty'));
    } else {
      phone = await phoneTest({ term, s, control, now, qr: deps.qr ?? ((u) => renderQr(u, { env: ctx.env })), onInterrupt: deps.onInterrupt ?? sigint, config: checkCtx.config });
    }
  }

  if (json) {
    ctx.stdout(JSON.stringify({ checks: results, ...(phone?.report ? { phone: phone.report } : {}) }, null, 2));
  }
  return count('fail') > 0 || phone?.status === 'fail' ? 1 : 0;
}

function printResult(term: Term, r: CheckResult, width: number) {
  const st = term.style;
  const paint = { ok: st.green, warn: st.yellow, fail: st.red, skip: st.dim }[r.status];
  term.line(`${paint(ICON[r.status])} ${r.title.padEnd(width)}  ${r.status === 'skip' ? st.dim(r.summary) : r.summary}`);
  const pad = ' '.repeat(width + 4);
  for (const d of r.detail ?? []) term.line(`${pad}${st.dim(d)}`);
  if (r.fix && r.status !== 'ok') term.line(`${pad}${st.cyan('→')} ${r.fix}`);
}

function sigint(fn: () => void): () => void {
  process.on('SIGINT', fn);
  return () => void process.off('SIGINT', fn);
}

async function phoneTest(o: {
  term: Term;
  s: (key: StrKey, params?: Record<string, string | number>) => string;
  control: DoctorControl;
  now: () => number;
  qr: (url: string) => string;
  onInterrupt: (fn: () => void) => () => void;
  config: Config | null;
}): Promise<PhoneOutcome | null> {
  const { term, s, control } = o;
  term.step(s('phoneTitle'));
  if (!(await control.available())) {
    term.warn(s('phoneNotRunning'));
    return null;
  }
  let session: { id: string; url: string; expiresAt: number };
  try {
    session = await control.doctorSession();
  } catch (e) {
    term.warn(s('phoneError', { error: (e as Error).message }));
    return null;
  }
  term.line(s('phoneOpen'));
  term.line(`  ${term.link(session.url)}`);
  term.line();
  term.line(o.qr(session.url));
  term.info(s('phoneWaiting'));

  let skipped = false;
  let wake: () => void = () => {};
  const interrupted = new Promise<null>((resolve) => {
    wake = () => resolve(null);
  });
  const remove = o.onInterrupt(() => {
    skipped = true;
    wake();
  });
  const deadline = o.now() + PHONE_WAIT_MS;
  let state: DoctorSessionState = { state: 'pending' };
  try {
    while (!skipped && o.now() < deadline) {
      const next = await Promise.race([control.doctorWait(session.id, Math.min(POLL_MS, deadline - o.now())), interrupted]);
      if (!next) break;
      if (next.state === 'opened' && state.state === 'pending') term.info(s('phoneOpened'));
      state = next;
      if (state.state === 'done' || state.state === 'expired') break;
    }
  } catch (e) {
    term.warn(s('phoneError', { error: (e as Error).message }));
    return null;
  } finally {
    remove();
  }

  if (state.state !== 'done' || !state.report) {
    if (skipped || state.state !== 'expired') term.info(s('phoneSkipped'));
    else term.warn(s('phoneExpired'));
    return { status: skipped ? 'skip' : 'warn' };
  }
  const r = state.report;
  const ports = { tcp: o.config?.mediaTcpPort ?? 7881, udp: o.config?.mediaUdpPort ?? 7882 };
  const ok = (v: boolean, rtt?: number) => (v ? (rtt !== undefined ? s('worksRtt', { ms: rtt }) : s('works')) : s('failed'));
  const rows: [boolean, string, string][] = [
    [r.https.ok, s('rowHttps'), r.https.ok ? (r.https.latencyMs !== null ? s('latency', { ms: r.https.latencyMs }) : s('works')) : s('failed')],
    [r.signaling.ok, s('rowSignaling'), r.signaling.ok ? s('works') : `${s('failed')}${r.signaling.error ? `: ${r.signaling.error}` : ''}`],
    [r.publish.ok, s('rowPublish'), r.publish.ok ? s('works') : `${s('failed')}${r.publish.error ? `: ${r.publish.error}` : ''}`],
    [!!r.initial, s('rowInitial'), r.initial
      ? s('initialPath', { protocol: r.initial.protocol.toUpperCase(), ip: r.initial.candidateIp ?? '?', ms: r.initial.rttMs ?? '?' })
      : s('initialNone')],
    [r.udp.ok, s('rowUdp', { port: ports.udp }), `${ok(r.udp.ok, r.udp.rttMs)}${!r.udp.ok && r.udp.error ? `: ${r.udp.error}` : ''}`],
    [r.tcp.ok, s('rowTcp', { port: ports.tcp }), `${ok(r.tcp.ok, r.tcp.rttMs)}${!r.tcp.ok && r.tcp.error ? `: ${r.tcp.error}` : ''}`],
  ];
  const w = Math.max(...rows.map(([, label]) => label.length));
  for (const [good, label, value] of rows) {
    term.line(`${good ? term.style.green('✓') : term.style.red('✗')} ${label.padEnd(w)}  ${value}`);
  }
  const hints = phoneHints(r, ports, o.config?.livekitNodeIp ?? null);
  const status = phoneStatus(r);
  if (!hints.length && status === 'ok') term.ok(s('phoneAllGood'));
  for (const h of hints) (status === 'fail' ? term.fail : term.warn)(s(h.key, h.params));
  return { status, report: r };
}
