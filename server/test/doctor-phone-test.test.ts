import { describe, expect, test } from 'bun:test';
import type { DoctorReport, PhoneTestPoll } from '../src/cli/control.ts';
import type { Locale } from '../src/cli/strings.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { PHONE_POLL_MS, PhoneTest, type DoctorControl, type PhoneTestState } from '../src/doctor/phone-test.ts';
import { PROD_ENV } from './helpers.ts';

const URL = 'https://telinha.example.com/doctor?t=TOKEN';

const REPORT: DoctorReport = {
  https: { ok: true, latencyMs: 80 },
  signaling: { ok: true },
  initial: { protocol: 'udp', candidateIp: '203.0.113.7', rttMs: 40 },
  tcp: { ok: true, rttMs: 60 },
  udp: { ok: true, rttMs: 40 },
  publish: { ok: true },
  client: { ua: 'phone' },
  startedAt: 1,
  finishedAt: 2,
};

type Poll = PhoneTestPoll | 'hang' | 'throw';

/** A control client whose polls answer from a list, or hang until answer(). */
function control(o: { available?: () => Promise<boolean>; session?: 'throw'; polls?: Poll[]; onWait?: () => void } = {}) {
  const calls: string[] = [];
  const polls = [...(o.polls ?? [])];
  const pending: ((s: PhoneTestPoll) => void)[] = [];
  const client: DoctorControl = {
    available: () => (calls.push('available'), o.available ? o.available() : Promise.resolve(true)),
    status: async () => ({}) as never,
    doctorSession: async () => {
      calls.push('session');
      if (o.session) throw new Error('503 from the service');
      return { id: 'abc', url: URL, expiresAt: 0 };
    },
    doctorWait: (id, ms) => {
      calls.push(`wait ${id} ${ms}`);
      o.onWait?.();
      const next = polls.shift() ?? 'hang';
      if (next === 'throw') return Promise.reject(new Error('socket closed'));
      return next === 'hang' ? new Promise<PhoneTestPoll>((r) => pending.push(r)) : Promise.resolve(next);
    },
  };
  return { client, calls, answer: (s: PhoneTestPoll) => pending.splice(0).forEach((r) => r(s)) };
}

const label = (s: PhoneTestState | null) => (!s ? 'null' : s.kind === 'waiting' ? `waiting${s.opened ? ' opened' : ''}` : s.kind);

function phoneTest(ctl: DoctorControl, o: { config?: Config | null; locale?: Locale; waitMs?: number; now?: () => number } = {}) {
  const t = new PhoneTest({ control: ctl, config: o.config ?? null, locale: o.locale ?? 'en', now: o.now ?? (() => 0), ...(o.waitMs ? { waitMs: o.waitMs } : {}) });
  const seen: string[] = [];
  t.subscribe(() => seen.push(label(t.state)));
  return { t, seen };
}

/** The rows of a finished run with this report. */
async function rows(report: DoctorReport, config: Config | null = null, locale: Locale = 'en') {
  const { t } = phoneTest(control({ polls: [{ state: 'done', report }] }).client, { config, locale });
  await t.start();
  const s = t.state;
  if (s?.kind !== 'done') throw new Error(`not done: ${label(s)}`);
  return s;
}

describe('phone test run', () => {
  test('nothing before start()', () => {
    expect(phoneTest(control().client).t.state).toBeNull();
  });

  test('service down: available() false or throwing is notRunning, no link asked', async () => {
    for (const available of [async () => false, async () => Promise.reject(new Error('EACCES'))]) {
      const ctl = control({ available });
      const { t, seen } = phoneTest(ctl.client);
      await t.start();
      expect(seen).toEqual(['starting', 'notRunning']);
      expect(ctl.calls).toEqual(['available']);
      expect(await t.finished()).toEqual({ status: 'skip' });
    }
  });

  test('the link cannot be made: error with the message', async () => {
    const { t, seen } = phoneTest(control({ session: 'throw' }).client);
    await t.start();
    expect(seen).toEqual(['starting', 'error']);
    expect(t.state).toEqual({ kind: 'error', message: '503 from the service' });
    expect(await t.finished()).toEqual({ status: 'warn' });
  });

  test('a poll that fails is an error too', async () => {
    const { t } = phoneTest(control({ polls: ['throw'] }).client);
    await t.start();
    expect(t.state).toEqual({ kind: 'error', message: 'socket closed' });
  });

  test('waiting, opened, done: in that order, with the report for --json', async () => {
    const ctl = control({ polls: [{ state: 'pending' }, { state: 'opened', openedAt: 1 }, { state: 'done', openedAt: 1, report: REPORT }] });
    const { t, seen } = phoneTest(ctl.client, { now: () => 1000 });
    const done = t.finished();
    await t.start();
    expect(seen).toEqual(['starting', 'waiting', 'waiting opened', 'done']);
    expect(ctl.calls).toEqual(['available', 'session', `wait abc ${PHONE_POLL_MS}`, `wait abc ${PHONE_POLL_MS}`, `wait abc ${PHONE_POLL_MS}`]);
    expect(await done).toEqual({ status: 'ok', report: REPORT });
  });

  test('waiting carries the link and the deadline', async () => {
    const { t } = phoneTest(control().client, { now: () => 1000, waitMs: 5000 });
    void t.start();
    await Bun.sleep(0);
    expect(t.state).toEqual({ kind: 'waiting', url: URL, deadline: 6000, opened: false });
    t.dispose();
  });

  test('a report without an opened poll still marks the link opened first', async () => {
    const { t, seen } = phoneTest(control({ polls: [{ state: 'done', report: REPORT }] }).client);
    await t.start();
    expect(seen).toEqual(['starting', 'waiting', 'waiting opened', 'done']);
  });

  test('the link expired: expired, a warning', async () => {
    const { t, seen } = phoneTest(control({ polls: [{ state: 'pending' }, { state: 'expired' }] }).client);
    await t.start();
    expect(seen.at(-1)).toBe('expired');
    expect(await t.finished()).toEqual({ status: 'warn' });
  });

  test('the wait runs out: skipped, the last poll only as long as the time left', async () => {
    let clock = 0;
    const ctl = control({ polls: [{ state: 'pending' }, { state: 'pending' }, { state: 'pending' }], onWait: () => void (clock += PHONE_POLL_MS) });
    const { t } = phoneTest(ctl.client, { now: () => clock, waitMs: 20_000 });
    await t.start();
    expect(ctl.calls.slice(2)).toEqual([`wait abc ${PHONE_POLL_MS}`, `wait abc ${PHONE_POLL_MS}`, 'wait abc 4000']);
    expect(t.state).toEqual({ kind: 'skipped' });
    expect(await t.finished()).toEqual({ status: 'skip' });
  });

  test('skip() while waiting: skipped at once; a late answer changes nothing', async () => {
    const ctl = control();
    const { t, seen } = phoneTest(ctl.client);
    const run = t.start();
    await Bun.sleep(0);
    expect(label(t.state)).toBe('waiting');
    t.skip();
    await run;
    ctl.answer({ state: 'done', report: REPORT });
    await Bun.sleep(0);
    expect(seen).toEqual(['starting', 'waiting', 'skipped']);
    expect(await t.finished()).toEqual({ status: 'skip' });
  });

  test('skip() while the link is being made; skip() after the end is a no-op', async () => {
    let up!: (v: boolean) => void;
    const ctl = control({ available: () => new Promise((r) => (up = r)) });
    const { t, seen } = phoneTest(ctl.client);
    const run = t.start();
    t.skip();
    up(true);
    await run;
    expect(seen).toEqual(['starting', 'skipped']);
    expect(ctl.calls).toEqual(['available']);
    const done = phoneTest(control({ polls: [{ state: 'done', report: REPORT }] }).client);
    await done.t.start();
    done.t.skip();
    expect(label(done.t.state)).toBe('done');
  });

  test('start() again drops the run in flight: its answer never lands', async () => {
    const ctl = control();
    const { t, seen } = phoneTest(ctl.client);
    const first = t.start();
    await Bun.sleep(0);
    const second = t.start();
    await first;
    await Bun.sleep(0);
    expect(ctl.calls.filter((c) => c === 'session')).toHaveLength(2);
    ctl.answer({ state: 'done', report: { ...REPORT, udp: { ok: false }, tcp: { ok: false } } });
    await second;
    // One answer reached the second run's poll only; the first run went quiet.
    expect(seen).toEqual(['starting', 'waiting', 'starting', 'waiting', 'waiting opened', 'done']);
    expect(await t.finished()).toMatchObject({ status: 'fail' });
  });

  test('finished() before start() waits for the run', async () => {
    const { t } = phoneTest(control({ polls: [{ state: 'expired' }] }).client);
    const p = t.finished();
    await t.start();
    expect(await p).toEqual({ status: 'warn' });
  });

  test('dispose() stops the run and the listeners', async () => {
    const ctl = control();
    const { t, seen } = phoneTest(ctl.client);
    const run = t.start();
    await Bun.sleep(0);
    t.dispose();
    await run;
    ctl.answer({ state: 'done', report: REPORT });
    await Bun.sleep(0);
    expect(seen).toEqual(['starting', 'waiting']);
  });
});

describe('phone test rows', () => {
  const view = (s: { rows: { id: string; status: string; hint?: string }[] }) => s.rows.map((r) => [r.id, r.status, r.hint ? 'hint' : '']);

  test('all good: ok rows, no hints, status ok', async () => {
    const s = await rows(REPORT);
    expect(s.status).toBe('ok');
    expect(s.rows.map((r) => [r.id, r.status, r.label, r.value, r.hint])).toEqual([
      ['https', 'ok', 'HTTPS', '80 ms', undefined],
      ['signaling', 'ok', 'LiveKit connection', 'works', undefined],
      ['publish', 'ok', 'Sending video', 'works', undefined],
      ['initial', 'ok', 'First path', 'UDP to 203.0.113.7, 40 ms', undefined],
      ['udp', 'ok', 'UDP 7882', 'works, 40 ms', undefined],
      ['tcp', 'ok', 'TCP 7881', 'works, 60 ms', undefined],
    ]);
  });

  test('one media path closed warns, with its hint on that row', async () => {
    const udp = await rows({ ...REPORT, udp: { ok: false, error: 'fell back to TCP' } });
    expect(udp.status).toBe('warn');
    expect(view(udp).slice(4)).toEqual([['udp', 'warn', 'hint'], ['tcp', 'ok', '']]);
    expect(udp.rows[4]!.value).toBe('failed: fell back to TCP');
    expect(udp.rows[4]!.hint).toContain('UDP 7882 is not reachable from the internet');
    const tcp = await rows({ ...REPORT, tcp: { ok: false } });
    expect(view(tcp).slice(4)).toEqual([['udp', 'ok', ''], ['tcp', 'warn', 'hint']]);
    expect(tcp.rows[5]!.hint).toContain('TCP 7881 is not reachable');
  });

  test('both media paths closed fail, the shared hint on both rows', async () => {
    const s = await rows({ ...REPORT, initial: null, udp: { ok: false }, tcp: { ok: false } });
    expect(s.status).toBe('fail');
    expect(view(s).slice(3)).toEqual([['initial', 'warn', ''], ['udp', 'fail', 'hint'], ['tcp', 'fail', 'hint']]);
    expect(s.rows[3]!.value).toBe('no media path');
    expect(s.rows[4]!.hint).toBe(s.rows[5]!.hint!);
    expect(s.rows[4]!.hint).toContain('open TCP 7881 and UDP 7882 to this machine');
  });

  test('signaling or HTTPS down fails; only the signaling hint is given', async () => {
    const s = await rows({ ...REPORT, signaling: { ok: false, error: 'timeout' }, udp: { ok: false }, tcp: { ok: false } }, null, 'pt-BR');
    expect(s.status).toBe('fail');
    expect(s.rows[1]).toMatchObject({ status: 'fail', value: 'falhou: timeout' });
    expect(s.rows[1]!.hint).toContain('A Telinha não é acessível pela internet');
    expect(s.rows.filter((r) => r.hint)).toHaveLength(1);
    const https = await rows({ ...REPORT, https: { ok: false, latencyMs: null } });
    expect(https.status).toBe('fail');
    expect(https.rows[0]).toMatchObject({ status: 'fail', value: 'failed' });
  });

  test('sending video failing only warns', async () => {
    const s = await rows({ ...REPORT, publish: { ok: false, error: 'no camera' } });
    expect(s.status).toBe('warn');
    expect(s.rows[2]).toMatchObject({ status: 'warn', value: 'failed: no camera' });
    expect(s.rows[2]!.hint).toBeUndefined();
  });

  test('a wrong LIVEKIT_NODE_IP: the first path warns with the address the phone was sent to', async () => {
    const config = loadConfig({ ...PROD_ENV, LIVEKIT_NODE_IP: '198.51.100.1' });
    const s = await rows(REPORT, config);
    expect(s.status).toBe('warn');
    expect(s.rows[3]).toMatchObject({ id: 'initial', status: 'warn' });
    expect(s.rows[3]!.hint).toContain('LiveKit advertises 203.0.113.7, which is not the public IP 198.51.100.1');
    expect((await rows(REPORT, loadConfig({ ...PROD_ENV, LIVEKIT_NODE_IP: '203.0.113.7' }))).status).toBe('ok');
  });

  test('TURN: its failure alone warns, never fails, and names the TURN host', async () => {
    const config = loadConfig({ ...PROD_ENV, HOSTING: 'vps', TURN: 'on' });
    const s = await rows({ ...REPORT, turn: { ok: false, error: 'not relayed' } }, config);
    expect(s.status).toBe('warn');
    expect(s.rows.at(-1)).toMatchObject({ id: 'turn', status: 'warn', label: 'TURN/TLS 443', value: 'failed: not relayed' });
    expect(s.rows.at(-1)!.hint).toContain('turn.telinha.example.com');
    const both = await rows({ ...REPORT, udp: { ok: false }, turn: { ok: false } });
    expect(view(both).slice(4)).toEqual([['udp', 'warn', 'hint'], ['tcp', 'ok', ''], ['turn', 'warn', 'hint']]);
    expect(both.rows.at(-1)!.hint).toContain('turn.<host>');
    const good = await rows({ ...REPORT, turn: { ok: true, rttMs: 120 } });
    expect(good.status).toBe('ok');
    expect(good.rows.at(-1)).toMatchObject({ status: 'ok', value: 'works, 120 ms' });
    expect((await rows({ ...REPORT, turn: null })).rows.map((r) => r.id)).not.toContain('turn');
  });

  test("LiveKit Cloud: no ports to name, Cloud hints, and the candidate IP is Cloud's", async () => {
    const config = loadConfig({ ...PROD_ENV, MEDIA: 'cloud', LIVEKIT_CLOUD_URL: 'wss://proj-abc.livekit.cloud', LIVEKIT_NODE_IP: '198.51.100.1' });
    const udp = await rows({ ...REPORT, udp: { ok: false, error: 'timed out' } }, config);
    expect(udp.rows.map((r) => r.label).slice(4)).toEqual(['UDP', 'TCP']);
    expect(udp.rows[3]!.status).toBe('ok');
    expect(udp.rows[4]!.hint).toBe('UDP to LiveKit Cloud did not work from the phone; video falls back to TCP with more delay. Nothing to open on your side.');
    expect((await rows({ ...REPORT, tcp: { ok: false } }, config)).rows[5]!.hint).toContain('video still works over UDP');
    expect((await rows({ ...REPORT, tcp: { ok: false }, udp: { ok: false } }, config)).rows[4]!.hint).toContain('that network blocks WebRTC');
    const down = await rows({ ...REPORT, signaling: { ok: false, error: 'could not connect' }, initial: null, udp: { ok: false }, tcp: { ok: false } }, config);
    expect(down.rows[1]!.hint).toContain('check the livekit-cloud check above');
  });

  test('the rows follow the language', async () => {
    const { t, seen } = phoneTest(control({ polls: [{ state: 'done', report: REPORT }] }).client);
    await t.start();
    t.setLocale('pt-BR');
    expect(seen.at(-1)).toBe('done');
    expect(seen).toHaveLength(5);
    const s = t.state;
    expect(s?.kind === 'done' && s.rows[1]!.label).toBe('Conexão com o LiveKit');
  });
});
