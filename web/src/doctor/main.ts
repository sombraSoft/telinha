// The phone test page (/doctor), opened from the one-time link `telinha doctor`
// shows. Runs from outside the network (mobile data): HTTPS, LiveKit signaling
// through telinha's /livekit relay, publishing a tiny canvas track, which path
// ICE picked, then TCP forced; posts the result for the terminal. No login: the
// link's cookie opens only these routes and the relay.
import { Room, RoomEvent, Track, type LocalTrackPublication } from 'livekit-client';
import '../styles/themes.css';
import '../styles/base.css';
import { hints, messageOf, selectedPath, tcpFromForced, udpFromInitial, type Path, type Report, type StepResult } from './analyze';
import { pickLocale, tr, type Key } from './strings';

const L = pickLocale(navigator.language);
const s = (key: Key, params?: Record<string, string | number>) => tr(L, key, params);

type Status = 'wait' | 'run' | 'ok' | 'warn' | 'fail' | 'skip';
type StepId = 'https' | 'signaling' | 'publish' | 'initial' | 'udp' | 'tcp' | 'report';
const ICON: Record<Status, string> = { wait: '○', run: '…', ok: '✓', warn: '!', fail: '✗', skip: '–' };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: timed out after ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

// ---------------------------------------------------------------- view

const app = document.getElementById('app')!;
document.documentElement.lang = L;
document.title = s('title');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const main = el('main', 'doctor');
main.append(el('h1', undefined, `📺 ${s('title')}`), el('p', 'muted', s('intro')), el('p', 'muted', s('mobileTip')));
const list = el('ol', 'steps');
main.append(list);
const footer = el('div', 'footer');
main.append(footer);
app.append(main);

const rows = new Map<StepId, { icon: HTMLElement; label: HTMLElement; detail: HTMLElement; li: HTMLElement }>();
const LABELS: Record<StepId, Key> = {
  https: 'stepHttps', signaling: 'stepSignaling', publish: 'stepPublish', initial: 'stepInitial', udp: 'stepUdp', tcp: 'stepTcp', report: 'stepReport',
};
for (const id of Object.keys(LABELS) as StepId[]) {
  const li = el('li', 'step');
  const icon = el('span', 'icon');
  const label = el('span', 'label', s(LABELS[id], { port: '…' }));
  const detail = el('span', 'detail');
  li.append(icon, label, detail);
  list.append(li);
  rows.set(id, { icon, label, detail, li });
  mark(id, 'wait');
}

function mark(id: StepId, status: Status, detail?: string) {
  const r = rows.get(id)!;
  r.li.dataset.status = status;
  r.icon.textContent = ICON[status];
  r.detail.textContent = detail ?? (status === 'run' ? s('running') : status === 'wait' ? s('waiting') : status === 'skip' ? s('skipped') : '');
}

const okText = (ms?: number | null) => (ms !== undefined && ms !== null ? s('okMs', { ms }) : s('ok'));
const stepText = (r: StepResult) => (r.ok ? okText(r.rttMs) : `${s('failed')}${r.error ? `: ${r.error}` : ''}`);
const pathText = (p: Path) =>
  s('path', { protocol: p.protocol.toUpperCase(), ip: p.candidateIp ?? '?', ms: p.rttMs ?? '?' }) + (p.relay ? ` (${s('relayed')})` : '');

function finish(text: string, hintList: string[] = []) {
  footer.replaceChildren();
  for (const h of hintList) footer.append(el('p', 'hint', h));
  footer.append(el('p', 'done', text));
}

// ---------------------------------------------------------------- test

/** Polls the publication's stats until ICE reports a selected pair. */
async function readPath(pub: LocalTrackPublication | undefined, waitMs: number): Promise<Path | null> {
  const end = Date.now() + waitMs;
  for (;;) {
    const report = await pub?.track?.getRTCStatsReport().catch(() => undefined);
    const p = report ? selectedPath(report) : null;
    if (p || Date.now() >= end) return p;
    await sleep(500);
  }
}

/** The canvas track: a 16x16 colour change twice a second is enough for stats to exist. */
function canvasTrack(): { track: MediaStreamTrack; stop: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  let n = 0;
  const paint = () => {
    ctx.fillStyle = `hsl(${(n++ * 47) % 360} 80% 50%)`;
    ctx.fillRect(0, 0, 16, 16);
  };
  paint();
  // A timer: requestAnimationFrame stalls when the phone dims the page.
  const timer = setInterval(paint, 500);
  const track = canvas.captureStream(2).getVideoTracks()[0]!;
  return { track, stop: () => (clearInterval(timer), track.stop()) };
}

/** force-tcp makes the SFU re-offer TCP candidates only and the client reconnect. */
function forceTcp(room: Room): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.off(RoomEvent.Reconnected, onUp).off(RoomEvent.Disconnected, onDown);
      resolve(ok);
    };
    const onUp = () => done(true);
    const onDown = () => done(false);
    const timer = setTimeout(() => done(false), 15_000);
    room.on(RoomEvent.Reconnected, onUp).on(RoomEvent.Disconnected, onDown);
    room.simulateScenario('force-tcp').catch(() => done(false));
  });
}

async function runTest(): Promise<void> {
  const startedAt = Date.now();
  const report: Report = {
    https: { ok: false, latencyMs: null },
    signaling: { ok: false },
    initial: null,
    tcp: { ok: false, error: 'not run' },
    udp: { ok: false, error: 'not run' },
    publish: { ok: false, error: 'not run' },
    client: { ua: navigator.userAgent },
    startedAt,
    finishedAt: startedAt,
  };
  let ports: { tcp: number; udp: number } | null = null;

  // 1. HTTPS
  mark('https', 'run');
  try {
    const t0 = performance.now();
    const r = await withTimeout(fetch('/doctor/api/ping', { cache: 'no-store' }), 15_000, 'ping');
    const latencyMs = Math.round(performance.now() - t0);
    const secure = location.protocol === 'https:';
    report.https = { ok: r.ok && secure, latencyMs };
    if (!r.ok) mark('https', 'fail', `${s('failed')}: HTTP ${r.status}`);
    else if (!secure) mark('https', 'fail', s('notHttps'));
    else mark('https', 'ok', okText(latencyMs));
  } catch (e) {
    mark('https', 'fail', `${s('failed')}: ${messageOf(e)}`);
  }

  // 2. Signaling
  mark('signaling', 'run');
  let room: Room | null = null;
  try {
    const r = await withTimeout(fetch('/doctor/api/token', { method: 'POST', cache: 'no-store' }), 15_000, 'token');
    if (r.status === 429) {
      for (const id of rows.keys()) mark(id, 'skip');
      finish(s('used'));
      return;
    }
    if (!r.ok) throw new Error(`token: HTTP ${r.status}`);
    const tok = (await r.json()) as { url: string; token: string; ports?: { tcp: number; udp: number } };
    ports = tok.ports ?? null;
    rows.get('udp')!.label.textContent = s('stepUdp', { port: ports?.udp ?? '?' });
    rows.get('tcp')!.label.textContent = s('stepTcp', { port: ports?.tcp ?? '?' });
    room = new Room({ adaptiveStream: false, dynacast: false });
    await withTimeout(room.connect(tok.url, tok.token), 20_000, 'connect');
    report.signaling = { ok: true };
    mark('signaling', 'ok', s('ok'));
  } catch (e) {
    report.signaling = { ok: false, error: messageOf(e) };
    mark('signaling', 'fail', `${s('failed')}: ${messageOf(e)}`);
  }

  if (room && report.signaling.ok) {
    // 3. Publish
    mark('publish', 'run');
    const canvas = canvasTrack();
    let pub: LocalTrackPublication | undefined;
    try {
      pub = await withTimeout(
        room.localParticipant.publishTrack(canvas.track, { source: Track.Source.ScreenShare, simulcast: false }),
        20_000,
        'publish',
      );
      report.publish = { ok: true };
      mark('publish', 'ok', s('ok'));
    } catch (e) {
      report.publish = { ok: false, error: messageOf(e) };
      mark('publish', 'fail', `${s('failed')}: ${messageOf(e)}`);
    }

    // 4. Initial path, and UDP from it
    mark('initial', 'run');
    mark('udp', 'run');
    await sleep(2000);
    const initial = pub ? await readPath(pub, 8000) : null;
    report.initial = initial ? { protocol: initial.protocol, candidateIp: initial.candidateIp, rttMs: initial.rttMs } : null;
    if (initial) mark('initial', 'ok', pathText(initial));
    else mark('initial', 'fail', s('failed'));
    report.udp = udpFromInitial(initial, true);
    mark('udp', report.udp.ok ? 'ok' : 'fail', stepText(report.udp));

    // 5. TCP: already on it, or forced
    mark('tcp', 'run');
    if (initial?.protocol === 'tcp') {
      report.tcp = { ok: true, ...(initial.rttMs !== null ? { rttMs: initial.rttMs } : {}) };
    } else if (pub) {
      const reconnected = await forceTcp(room);
      await sleep(2000);
      // A full reconnect republishes the track: look it up again.
      const again = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const path = reconnected ? await readPath(again, 8000) : null;
      report.tcp = tcpFromForced(path, reconnected);
    } else {
      report.tcp = { ok: false, error: 'nothing published' };
    }
    mark('tcp', report.tcp.ok ? 'ok' : report.tcp.error?.startsWith('could not force') ? 'warn' : 'fail', stepText(report.tcp));
    canvas.stop();
  } else {
    for (const id of ['publish', 'initial', 'udp', 'tcp'] as const) mark(id, 'skip');
    report.tcp = { ok: false, error: 'no connection' };
    report.udp = { ok: false, error: 'no connection' };
    report.publish = { ok: false, error: 'no connection' };
  }

  // 6. Report
  mark('report', 'run');
  report.finishedAt = Date.now();
  const hintText = hints(report, ports).map((h) => s(h.key, h.params));
  try {
    const r = await withTimeout(
      fetch('/doctor/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) }),
      15_000,
      'report',
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    mark('report', 'ok', s('ok'));
    finish(s('done'), hintText);
  } catch (e) {
    mark('report', 'fail', `${s('failed')}: ${messageOf(e)}`);
    finish(s('doneNoReport', { error: messageOf(e) }), hintText);
  }
  await room?.disconnect().catch(() => {});
}

void runTest().catch((e) => {
  console.error(e);
  finish(`${s('failed')}: ${messageOf(e)}`);
});
