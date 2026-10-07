// The setup screens driven with keys on OpenTUI's test renderer, wired to the
// real setup (setup state, lookups, apply, file write) on a fake machine.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { TaskId, TaskRow } from '../src/cli/setup/apply.ts';
import type { SetupUiContext } from '../src/cli/setup/ui.ts';
import { run } from '../src/cli/setup.ts';
import { parseEnvFile } from '../src/envfile.ts';
import { frame, paste, press, typeText, until } from './tui-harness.tsx';
import {
  APP,
  at,
  BAD_TOKEN,
  CHANNEL,
  ctxFor,
  DUCK,
  defaultsToReview,
  discordKeys,
  ENV,
  fakeChecks,
  fakeDoctor,
  GUILD,
  homeDuckKeys,
  leak,
  machine,
  PUBLIC_IP,
  ROLE,
  SECRET,
  type Started,
  startOffer,
  startSetup,
  TOKEN,
  TUNNEL,
  VPS_NAT,
} from './tui-setup-fixtures.ts';

// Whole runs: a key press is a few renders.
setDefaultTimeout(20_000);

const QUIET = ['--lang', 'en', '--no-service', '--no-upnp', '--no-doctor'];
const PAGE_DOWN = '\x1b[6~';
const PAGE_UP = '\x1b[5~';
const HOME_DUCK = {
  HOSTING: 'home',
  INGRESS: 'direct',
  PUBLIC_URL: 'https://my-group.duckdns.org:8443',
  HTTP_PORT: '0',
  HTTPS_PORT: '8443',
  ACME_DNS: 'duckdns',
  DDNS_PROVIDER: 'duckdns',
  DUCKDNS_DOMAIN: 'my-group',
  DUCKDNS_TOKEN: DUCK,
};

/** Review -> Apply -> the last card -> Exit; setup's exit code. */
async function applyAndExit(r: Started): Promise<number | null> {
  await at(r, 'review');
  await press(r.s, 'enter');
  return exit(r, await until(r.s, /Telinha is (running|set up)/, 5000));
}

/** Exit on the last card (the second choice when the doctor report is offered). */
async function exit(r: Started, f: string): Promise<number | null> {
  await press(r.s, ...(f.includes('Show the doctor report') ? ['down', 'enter'] : ['enter']));
  return r.code;
}

const vars = (r: Started) => parseEnvFile(r.files.get(ENV)!).vars;

describe('answering with keys writes telinha.env', () => {
  test('home with a domain on Cloudflare: the pasted install command keeps the token, no HTTP ports', async () => {
    const r = await startSetup(QUIET);
    const frames: string[] = [];
    await at(r, 'hosting');
    await press(r.s, 'enter');
    await at(r, 'homeCf');
    await press(r.s, '1');
    await at(r, 'tunnelToken');
    const pasted = `cloudflared service install ${TUNNEL}`;
    await paste(r.s, pasted);
    let f = frame(r.s);
    expect(f).toContain(`${pasted.length} characters · pasted`);
    expect(f).toContain('•'.repeat(20));
    expect(leak(TUNNEL, f)).toBeNull();
    frames.push(f);
    await press(r.s, 'enter');
    frames.push(await at(r, 'tunnelHost'));
    await typeText(r.s, 't.example.com');
    await press(r.s, 'enter');
    await discordKeys(r);
    f = await defaultsToReview(r);
    frames.push(f);
    expect(f).toMatch(/Cloudflare Tunnel token +set/);
    expect(f).toMatch(/Web address +https:\/\/t\.example\.com/);
    await press(r.s, 'enter');
    frames.push(await until(r.s, 'Telinha is set up', 5000));
    expect(await exit(r, frames.at(-1)!)).toBe(0);
    // The pasted command shares words with the hint; the token itself is what must never show.
    expect(leak(TUNNEL, [...frames, ...r.term.out, ...r.err].join(' | '))).toBeNull();
    const v = vars(r);
    expect(v).toMatchObject({
      HOSTING: 'home',
      INGRESS: 'tunnel',
      TUNNEL_TOKEN: TUNNEL,
      PUBLIC_URL: 'https://t.example.com',
      CHANNEL_IDS: CHANNEL,
      GUILD_ID: GUILD,
      ROLE_ID: ROLE,
    });
    expect(v.HTTP_PORT ?? '').toBe('');
    expect(v.HTTPS_PORT ?? '').toBe('');
  });

  test('home without a domain: DuckDNS checked while answering, HTTPS on 8443', async () => {
    const r = await startSetup(QUIET);
    await at(r, 'hosting');
    await press(r.s, 'enter');
    await at(r, 'homeCf');
    await press(r.s, '2');
    await at(r, 'duckName');
    await typeText(r.s, 'my-group');
    await press(r.s, 'enter');
    await at(r, 'duckToken');
    await paste(r.s, DUCK);
    await press(r.s, 'enter');
    // The update ran with the token; its note shows on the next card.
    expect(await at(r, 'httpsPort')).toContain(`my-group.duckdns.org now points at ${PUBLIC_IP}.`);
    expect(frame(r.s)).toContain('default: 8443');
    await press(r.s, 'enter');
    await discordKeys(r);
    await defaultsToReview(r);
    expect(await applyAndExit(r)).toBe(0);
    expect(vars(r)).toMatchObject({ ...HOME_DUCK, UPNP: 'auto', DISCORD_CLIENT_ID: APP });
    expect(r.rec.ddns).toEqual([`my-group ${PUBLIC_IP}`, `my-group ${PUBLIC_IP}`]);
  });

  test('VPS, own domain: the DNS answer is a note, the file serves 80/443', async () => {
    const r = await startSetup(QUIET, { nat: VPS_NAT });
    // Detected as a VPS: that is the highlighted answer now.
    expect(await at(r, 'hosting')).toContain('❯ 2. A rented server (VPS)');
    await press(r.s, 'enter');
    await at(r, 'vpsAddress');
    await press(r.s, '1');
    await at(r, 'domain');
    await typeText(r.s, 't.example.com');
    await press(r.s, 'enter');
    expect(await at(r, 'discordToken')).toContain(`t.example.com points at this network (${PUBLIC_IP}).`);
    await discordKeys(r);
    expect(await defaultsToReview(r)).not.toContain('Ask the router?');
    expect(await applyAndExit(r)).toBe(0);
    expect(vars(r)).toMatchObject({
      HOSTING: 'vps',
      INGRESS: 'direct',
      PUBLIC_URL: 'https://t.example.com',
      HTTP_PORT: '80',
      HTTPS_PORT: '443',
      UPNP: 'off',
    });
  });
});

describe('moving around', () => {
  test('back (Esc and ←) keeps every answer, branches left behind included', async () => {
    const r = await startSetup(QUIET);
    await homeDuckKeys(r);
    await at(r, 'discordToken');
    await press(r.s, 'escape');
    // The given port is the field's text again.
    expect(await at(r, 'httpsPort')).toContain('8443▌');
    await press(r.s, 'left');
    // A secret never comes back, only that one is kept.
    let f = await at(r, 'duckToken');
    expect(f).toContain('Enter keeps the current one');
    expect(leak(DUCK, f)).toBeNull();
    await press(r.s, 'escape');
    expect(await at(r, 'duckName')).toContain('my-group▌');
    await press(r.s, 'escape');
    f = await at(r, 'homeCf');
    expect(f).toMatch(/❯ 2\. No: use a free DuckDNS address +✓ current answer/);
    // Another branch, then back to the first one: its answers are still there.
    await press(r.s, '1');
    await at(r, 'tunnelToken');
    await press(r.s, 'escape');
    await at(r, 'homeCf');
    await press(r.s, '2');
    expect(await at(r, 'duckName')).toContain('my-group▌');
    // One Esc per press: Esc and the next key at once read as Alt+key.
    await press(r.s, 'escape');
    await at(r, 'homeCf');
    await press(r.s, 'escape');
    await at(r, 'hosting');
    // Nothing before the first question.
    await press(r.s, 'escape');
    expect(await at(r, 'hosting')).toContain('Where will Telinha run?');
    await press(r.s, 'ctrl+c');
    expect(await r.code).toBe(130);
    expect(r.err).toEqual(['Nothing was written.']);
  });

  test('Tab: the sidebar jumps to an answered step; later steps and the Review are locked', async () => {
    const r = await startSetup(QUIET);
    await homeDuckKeys(r);
    await at(r, 'discordToken');
    await press(r.s, 'tab');
    let f = await until(r.s, 'Pick a step to jump to');
    expect(f).toContain('❯ Discord  ‹');
    expect(f).toContain('↑↓ move  enter jump  esc question  ctrl+c quit');
    await press(r.s, 'up', 'up', 'enter');
    f = await at(r, 'hosting');
    expect(f).not.toContain('Pick a step to jump to');
    await press(r.s, 'tab', 'down', 'down', 'down', 'enter');
    f = await until(r.s, 'Answer the earlier steps first');
    // Still on the first question, the sidebar still has the keys.
    expect(r.state().current().id).toBe('hosting');
    await press(r.s, 'down', 'enter');
    expect(await until(r.s, 'Answer the earlier steps first')).toContain('Pick a step to jump to');
    await press(r.s, 'escape');
    f = await until(r.s, '1-9 pick');
    expect(f).not.toContain('Pick a step to jump to');
    await press(r.s, 'ctrl+c');
    await r.code;
  });

  test('a terminal under 80 columns: Tab swaps the card for the step list', async () => {
    const r = await startSetup(QUIET, { width: 70, height: 24 });
    let f = await at(r, 'hosting');
    expect(f).not.toContain('○ Address');
    await press(r.s, 'tab');
    f = await until(r.s, 'Pick a step to jump to');
    expect(f).toContain('○ Address');
    expect(f).not.toContain('Where will Telinha run?');
    await press(r.s, 'escape');
    expect(await until(r.s, 'Where will Telinha run?')).not.toContain('○ Address');
    await press(r.s, 'ctrl+c');
    await r.code;
  });
});

describe('secrets', () => {
  test('never on screen: no four characters of a typed or pasted secret in any frame, nor in what stays after', async () => {
    const frames: string[] = [];
    const shot = () => frames.push(frame(r.s));
    const r = await startSetup(['--lang', 'en', '--no-upnp'], {
      compiled: true,
      doctor: fakeDoctor(),
      doctorChecks: fakeChecks({ n: 0 }),
    });
    await at(r, 'hosting');
    await press(r.s, 'enter');
    await at(r, 'homeCf');
    await press(r.s, '2');
    await at(r, 'duckName');
    await typeText(r.s, 'my-group');
    await press(r.s, 'enter');
    await at(r, 'duckToken');
    // Typed, not pasted: every key press is a frame.
    for (const ch of DUCK) {
      await typeText(r.s, ch);
      shot();
    }
    // Ctrl+R shows it, inside the field only, and hides it again.
    await press(r.s, 'ctrl+r');
    const shown = frame(r.s);
    expect(shown.split('\n').filter((l) => l.includes(DUCK.slice(-12)))).toHaveLength(1);
    expect(shown).toMatch(new RegExp(`│ ${DUCK.slice(0, 8)}`));
    await press(r.s, 'ctrl+r');
    shot();
    // With the sidebar in front the field does not take Ctrl+R.
    await press(r.s, 'tab', 'ctrl+r');
    shot();
    await press(r.s, 'escape');
    await press(r.s, 'enter');
    shot();
    await at(r, 'httpsPort');
    await press(r.s, 'enter');
    await at(r, 'discordToken');
    await paste(r.s, TOKEN);
    shot();
    await press(r.s, 'enter');
    await at(r, 'clientSecret');
    shot();
    await paste(r.s, SECRET);
    shot();
    await press(r.s, 'enter');
    for (const id of ['guild', 'role'] as const) {
      await at(r, id);
      shot();
      await press(r.s, 'enter');
    }
    await at(r, 'channels');
    await press(r.s, 'space', 'enter');
    shot();
    frames.push(await defaultsToReview(r));
    await press(r.s, 'enter');
    frames.push(await until(r.s, 'Telinha is running', 5000));
    await press(r.s, 'enter');
    frames.push(await until(r.s, /\d ok · /));
    await press(r.s, 'q');
    frames.push(await until(r.s, 'Exit'));
    await press(r.s, 'down', 'enter');
    expect(await r.code).toBe(0);
    const all = [...frames, ...r.term.out, ...r.out, ...r.err].join('\n');
    for (const secret of [DUCK, TOKEN, SECRET]) expect(leak(secret, all)).toBeNull();
    // The values did reach the file.
    expect(vars(r)).toMatchObject({ DUCKDNS_TOKEN: DUCK, DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_SECRET: SECRET });
  });
});

describe('the install', () => {
  test('a failing service install: Retry fails again, Skip goes on to the end', async () => {
    const r = await startSetup(['--lang', 'en', '--no-upnp', '--no-doctor'], { compiled: true, serviceFails: 2 });
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    let f = await until(r.s, 'Retry');
    expect(f).toMatch(/✖ Install the service +Service install failed: systemctl/);
    expect(f).toContain('The service is not installed: try again, or skip and start Telinha with telinha run.');
    expect(f).toContain('↑↓ move  enter select  ctrl+c quit');
    expect(f).toMatch(/✖ Install\s/);
    expect(r.rec.installs).toBe(1);
    await press(r.s, 'enter');
    await until(r.s, 'Retry');
    expect(r.rec.installs).toBe(2);
    await press(r.s, 'down', 'enter');
    f = await until(r.s, 'Telinha is set up');
    expect(f).toMatch(/– Install the service +skipped/);
    // ↑ from the first choice walks the finished rows; Enter shows a row's lines.
    await press(r.s, 'up', 'up');
    expect(frame(r.s)).toContain('Install the service  ‹');
    await press(r.s, 'enter');
    expect(frame(r.s)).toContain('✖ Service install failed: systemctl enable --now telinha.service exited with 1');
    await press(r.s, 'down', 'down', 'down');
    await press(r.s, 'down', 'enter');
    expect(await r.code).toBe(0);
    expect(r.term.out).toContain(
      '– Install the service: Service install failed: systemctl enable --now telinha.service exited with 1',
    );
  });

  test("Back to questions lands on the failed task's question; sudo gets the terminal; applying again works", async () => {
    const r = await startSetup(['--lang', 'en', '--no-upnp', '--no-doctor'], {
      compiled: true,
      serviceFails: 1,
      nat: VPS_NAT,
      isRoot: false,
    });
    await at(r, 'hosting');
    await press(r.s, '2');
    await at(r, 'vpsAddress');
    await press(r.s, '1');
    await at(r, 'domain');
    await typeText(r.s, 't.example.com');
    await press(r.s, 'enter');
    await discordKeys(r);
    await at(r, 'media');
    await press(r.s, 'enter');
    await at(r, 'turn');
    await press(r.s, '2');
    await at(r, 'mediaPorts');
    await press(r.s, 'enter');
    const sysctl = await at(r, 'sysctl');
    expect(sysctl).toContain('Ports below 1024');
    await press(r.s, 'enter');
    await defaultsToReview(r);
    await press(r.s, 'enter');
    await until(r.s, 'Retry');
    // sudo asked for its password on the real terminal, after the explanation.
    expect(r.driver.terminal).toHaveLength(1);
    expect(r.driver.terminal[0]!.join(' ')).toContain('Ports 80, 443 are below 1024');
    expect(r.rec.spawnInteractive[0]![0]).toBe('sudo');
    await press(r.s, 'down', 'down', 'enter');
    expect(await at(r, 'sysctl')).toContain('Ports below 1024');
    await press(r.s, 'enter');
    await defaultsToReview(r);
    await press(r.s, 'enter');
    const f = await until(r.s, 'Telinha is running', 5000);
    expect(r.rec.installs).toBe(2);
    expect(await exit(r, f)).toBe(0);
  });

  test('Esc while installing: going back is disabled; Ctrl+C needs a second press', async () => {
    let release!: () => void;
    const hold = new Promise<void>((res) => (release = res));
    const r = await startSetup(QUIET, { binsHold: hold });
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    let f = await until(r.s, '52%  10.9 / 21.0 MB  livekit');
    expect(f).toContain('Working…');
    expect(f).toMatch(/ ctrl\+c quit\n$/);
    await press(r.s, 'escape');
    expect(await until(r.s, '! Installing: going back is disabled until this finishes.')).toContain(
      'Installing Telinha',
    );
    await press(r.s, 'ctrl+c');
    f = await until(r.s, 'Press Ctrl+C again to stop: the install may be left half done.');
    expect(r.state().screen()).toBe('review');
    await press(r.s, 'ctrl+c');
    expect(await r.code).toBe(130);
    // The file was written before the download: the summary says so.
    expect(r.term.out).toContain('ok Write telinha.env: Wrote /opt/telinha/config/telinha.env');
    release();
  });

  test('Esc and ← on the failed and the last card: a notice, the card stays', async () => {
    const r = await startSetup(['--lang', 'en', '--no-upnp', '--no-doctor'], { compiled: true, serviceFails: 1 });
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    await until(r.s, 'Retry');
    await press(r.s, 'escape');
    let f = await until(r.s, '! To change answers, pick Back to questions.');
    expect(f).toContain('❯ 1. Retry');
    // A new stage clears it.
    await press(r.s, 'enter');
    f = await until(r.s, 'Telinha is running', 5000);
    expect(f).not.toContain('! To change');
    await press(r.s, 'left');
    f = await until(r.s, '! The install has run: going back is disabled.');
    expect(f).toContain('Telinha is running');
    expect(r.state().screen()).toBe('review');
    expect(await exit(r, f)).toBe(0);
  });

  test('telinha.env cannot be written: Retry or Back to questions, no Skip', async () => {
    const r = await startSetup(QUIET, { writeFails: 1 });
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    let f = await until(r.s, 'Retry');
    expect(f).toMatch(/✖ Write telinha\.env +the resulting configuration is invalid: ENOSPC|✖ Write telinha\.env/);
    expect(f).toContain('ENOSPC: no space left on device');
    expect(f).toContain('2. Back to questions');
    expect(f).not.toContain('Skip');
    await press(r.s, 'enter');
    f = await until(r.s, 'Telinha is set up', 5000);
    expect(await exit(r, f)).toBe(0);
    expect(vars(r)).toMatchObject(HOME_DUCK);
  });

  test('after a written file, the Review says so; a later attempt that writes nothing still names it', async () => {
    const r = await startSetup(['--lang', 'en', '--no-upnp', '--no-doctor'], { compiled: true, serviceFails: 1 });
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    await until(r.s, 'Retry');
    await press(r.s, '3');
    await defaultsToReview(r);
    const f = await until(r.s, 'Leave setup');
    expect(f).toContain('telinha.env was already written by the last attempt');
    expect(f).not.toContain('Nothing has changed');
    expect(f).not.toContain('Quit without writing');
    await press(r.s, 'up');
    expect(frame(r.s)).toContain('Keeps what the last attempt left on this machine');
    await press(r.s, 'down');
    // The bot left the server: this attempt stops at Discord, before the file.
    r.world.guilds = [];
    await press(r.s, 'enter');
    await until(r.s, '✖ Discord app');
    await press(r.s, 'ctrl+c');
    expect(await r.code).toBe(130);
    expect(r.err).not.toContain('Nothing was written.');
    expect(r.term.out).toContain(
      'warn This attempt wrote nothing; /opt/telinha/config/telinha.env is the one an earlier attempt wrote.',
    );
    expect(r.files.has(ENV)).toBe(true);
  });

  test("what stays after the screens: each task's result, then what is left to do by hand", async () => {
    const r = await startSetup(['--lang', 'en', '--no-doctor'], {
      compiled: true,
      nat: VPS_NAT,
      isRoot: false,
      serviceHints: ['loginctl enable-linger me'],
    });
    await at(r, 'hosting');
    await press(r.s, '2');
    await at(r, 'vpsAddress');
    await press(r.s, '1');
    await at(r, 'domain');
    await typeText(r.s, 't.example.com');
    await press(r.s, 'enter');
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    const f = await until(r.s, 'Telinha is running', 5000);
    // The router's lines and a warning row with more to say are open on the last card.
    expect(f).toContain("Open these ports in your provider's");
    expect(f).toContain('! Still to do by hand: loginctl enable-linger me');
    expect(await exit(r, f)).toBe(0);
    const out = r.term.out.join('\n');
    expect(out).toContain('warn Install the service: Service installed (systemd-user)');
    expect(out).toContain('    ! Still to do by hand: loginctl enable-linger me');
    expect(out).toContain('Without it Telinha stops whenever you log out of this machine');
    expect(out).toContain(
      "ok Router and firewall: Open these ports in your provider's firewall (security group / security list) and in this machine's own firewall: TCP 7881, UDP 7882, TCP 443, TCP 80",
    );
  });

  test('Discord refuses at install time: Back to questions opens the token question', async () => {
    const r = await startSetup(QUIET);
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    // The bot left the server between the questions and the install.
    r.world.guilds = [];
    await press(r.s, 'enter');
    const f = await until(r.s, 'Retry');
    expect(f).toContain('✖ Discord app');
    await press(r.s, 'down', 'down', 'enter');
    await at(r, 'discordToken');
    expect(frame(r.s)).toContain('Enter keeps the current one');
    await press(r.s, 'ctrl+c');
    expect(await r.code).toBe(130);
    expect(r.files.has(ENV)).toBe(false);
  });

  test("the doctor report from the last card: the install's results, a row's fix, r runs it again, q goes back", async () => {
    const runs = { n: 0 };
    const builds = { n: 0 };
    const r = await startSetup(['--lang', 'en', '--no-upnp'], {
      compiled: true,
      doctor: fakeDoctor(builds),
      doctorChecks: fakeChecks(runs),
    });
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    let f = await until(r.s, 'Telinha is running', 5000);
    expect(f).toContain('→ https://my-group.duckdns.org:8443');
    expect(f).toContain('Show the doctor report');
    expect(f).toContain('Telinha keeps running as a service');
    await press(r.s, 'enter');
    f = await until(r.s, '2 ok · 1 warning · 1 failed');
    // The results came from the install: nothing ran again yet.
    expect(runs.n).toBe(0);
    expect(f).toContain('↑↓ move  enter details  r run again');
    expect(f).toContain('✔ Install');
    await press(r.s, 'down', 'down', 'enter');
    f = frame(r.s);
    expect(f).toContain('❯ ▾ ✖ Router');
    expect(f).toContain('└ Fix');
    expect(f).toContain('Forward UDP 7882 on your router to 192.168.0.10.');
    await press(r.s, 'r');
    await until(r.s, '2 ok · 1 warning · 1 failed');
    expect(runs.n).toBe(1);
    expect(builds.n).toBe(1);
    await press(r.s, 'q');
    await until(r.s, 'Show the doctor report');
    await press(r.s, 'down', 'enter');
    expect(await r.code).toBe(0);
  });
});

describe('lookups on the cards', () => {
  test('DuckDNS refuses the token: type it again (an empty field), or keep it with a Review note', async () => {
    const r = await startSetup(QUIET, { duckOk: () => false });
    await at(r, 'hosting');
    await press(r.s, 'enter');
    await at(r, 'homeCf');
    await press(r.s, '2');
    await at(r, 'duckName');
    await typeText(r.s, 'my-group');
    await press(r.s, 'enter');
    await at(r, 'duckToken');
    await paste(r.s, DUCK);
    await press(r.s, 'enter');
    let f = await until(r.s, '✖ DuckDNS did not accept it: KO');
    expect(f).toContain('❯ 1. Type the token again');
    expect(f).toContain('2. Keep it anyway (the running service retries)');
    expect(f).toContain('↑↓ move  1-9 pick  enter select');
    await press(r.s, 'enter');
    f = await at(r, 'duckToken');
    expect(f).toContain('0 characters');
    expect(f).not.toContain('did not accept');
    await paste(r.s, DUCK);
    await press(r.s, 'enter');
    await until(r.s, 'Keep it anyway');
    await press(r.s, '2');
    await at(r, 'httpsPort');
    await press(r.s, 'enter');
    await discordKeys(r);
    f = await defaultsToReview(r);
    expect(f).toContain('! DuckDNS did not accept the token for my-group.duckdns.org yet');
    expect(leak(DUCK, f)).toBeNull();
    await press(r.s, 'ctrl+c');
    await r.code;
  });

  test('a login redirect the app lacks: the URI on its own line, checked again, or skipped into a Review note', async () => {
    const r = await startSetup(QUIET);
    const uri = 'https://my-group.duckdns.org:8443/auth/callback';
    r.world.redirects = [];
    await homeDuckKeys(r);
    await at(r, 'discordToken');
    await paste(r.s, TOKEN);
    await press(r.s, 'enter');
    await at(r, 'clientSecret');
    await paste(r.s, SECRET);
    await press(r.s, 'enter');
    let f = await at(r, 'redirect');
    expect(f).toContain(uri);
    expect(f).toContain('❯ 1. I added it: check again');
    expect(f).toContain('Redirects -> Add Redirect, paste this, then Save Changes:');
    await press(r.s, '1');
    f = await until(r.s, '! Not there yet (did you press Save Changes?).');
    expect(r.state().current().id).toBe('redirect');
    await press(r.s, '2');
    await at(r, 'guild');
    await press(r.s, 'enter');
    await at(r, 'role');
    await press(r.s, 'enter');
    await at(r, 'channels');
    await press(r.s, 'space', 'enter');
    f = await defaultsToReview(r);
    expect(f).toContain(`! Login will fail until ${uri} is a redirect`);
    await press(r.s, 'ctrl+c');
    await r.code;
  });

  test('a token Discord rejects stays (the check shows while it runs), a good one goes on', async () => {
    let open!: () => void;
    const r = await startSetup(QUIET);
    await homeDuckKeys(r);
    await at(r, 'discordToken');
    r.world.hold = new Promise((res) => (open = res));
    await paste(r.s, BAD_TOKEN);
    await press(r.s, 'enter');
    let f = await at(r, 'discordToken', { running: true });
    expect(f).toContain('⠋ Checking the token with Discord…');
    r.world.hold = null;
    open();
    f = await until(r.s, '✖ Discord rejected the token; copy it again and paste it here.');
    expect(r.state().current().id).toBe('discordToken');
    // Typing hides the error until the next Enter.
    await press(r.s, 'ctrl+u');
    await paste(r.s, TOKEN);
    expect(frame(r.s)).not.toContain('rejected');
    await press(r.s, 'enter');
    expect(await at(r, 'clientSecret')).toContain(`› Bot: Telinha Bot (app id ${APP})`);
    await press(r.s, 'ctrl+c');
    await r.code;
  });

  test('a bot in no server: the invite card, then the list once it was added', async () => {
    const r = await startSetup(QUIET);
    r.world.guilds = [];
    await homeDuckKeys(r);
    await at(r, 'discordToken');
    await paste(r.s, TOKEN);
    await press(r.s, 'enter');
    await at(r, 'clientSecret');
    await paste(r.s, SECRET);
    await press(r.s, 'enter');
    let f = await at(r, 'guild');
    expect(f).toContain('! The bot is not in any server yet.');
    expect(f).toContain('https://discord.com/oauth2/authorize?client_id=111111111111111111');
    expect(f).toContain('❯ 1. Open the link in the browser');
    expect(f).toContain('2. I added the bot: check again');
    expect(f).toContain('Add the bot to your server with this link');
    r.world.guilds = [{ id: GUILD, name: 'Gurizada' }];
    await press(r.s, '2');
    f = await until(r.s, '1. Gurizada');
    expect(f).toContain('2. Another server (add the bot)');
    expect(f).not.toContain('Open the link');
    await press(r.s, 'enter');
    await at(r, 'role');
    await press(r.s, 'ctrl+c');
    await r.code;
  });

  test('channels: at least one; space toggles, a takes them all', async () => {
    const r = await startSetup(QUIET);
    await homeDuckKeys(r);
    await at(r, 'discordToken');
    await paste(r.s, TOKEN);
    await press(r.s, 'enter');
    await at(r, 'clientSecret');
    await paste(r.s, SECRET);
    await press(r.s, 'enter');
    await at(r, 'guild');
    await press(r.s, 'enter');
    await at(r, 'role');
    await press(r.s, '2');
    let f = await at(r, 'channels');
    expect(f).toContain('↑↓ move  space toggle  a all  enter confirm  esc/← back  tab steps');
    await press(r.s, 'enter');
    expect(await until(r.s, 'Pick at least one channel.')).toContain('[ ] #geral');
    await press(r.s, 'a');
    f = await until(r.s, '3 selected');
    expect(f).toContain('[x] #filmes');
    await press(r.s, 'a', 'down', 'space', 'down', 'space');
    f = await until(r.s, '2 selected');
    expect(f).toContain('[ ] #geral');
    await press(r.s, 'enter');
    await at(r, 'command');
    expect(r.state().answers().channels).toEqual(['444444444444444442', '444444444444444443']);
    expect(r.state().answers().role).toBe(GUILD);
    await press(r.s, 'ctrl+c');
    await r.code;
  });
});

describe('language, re-runs and flags', () => {
  test('the language question switches every screen at once', async () => {
    const r = await startSetup(['--no-service', '--no-upnp', '--no-doctor']);
    let f = await at(r, 'lang');
    expect(f).toContain('Language / Idioma');
    await press(r.s, '2');
    f = await at(r, 'hosting');
    expect(f).toContain('Onde a Telinha vai rodar?');
    expect(f).toContain('Onde · Passo 1 de 7');
    expect(f).toContain('○ Endereço');
    expect(f).toContain('Compartilhamento de tela pro seu grupo do Discord');
    expect(f).toContain('↑↓ mover  1-9 atalho  enter escolher  esc/← voltar  tab passos  ctrl+c sair');
    expect(f).toContain('Sobre isto');
    expect(f).toContain('Esta máquina: Debian GNU/Linux 12 (bookworm)');
    await press(r.s, 'ctrl+c');
    expect(await r.code).toBe(130);
    expect(r.err).toEqual(['Nada foi gravado.']);
  });

  test('--yes on a re-run opens at the Review; secrets show as kept', async () => {
    // A first, plain run leaves the file.
    const first = machine();
    const plain = ctxFor(
      [
        'setup',
        '--non-interactive',
        ...QUIET,
        '--host',
        'home',
        '--duckdns-domain',
        'my-group',
        '--guild',
        GUILD,
        '--role',
        ROLE,
        '--channels',
        CHANNEL,
      ],
      {
        tty: false,
        env: { DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_SECRET: SECRET, DUCKDNS_TOKEN: DUCK },
      },
    );
    expect(await run({ flags: {}, positionals: [], rest: [] }, plain.ctx, first.deps)).toBe(0);
    const text = first.files.get(ENV)!;
    const r = await startSetup(['--no-service', '--no-upnp', '--no-doctor'], { yes: true, files: { [ENV]: text } });
    const f = await at(r, 'review');
    expect(f).toContain('Review · Step 6 of 7');
    expect(f).toMatch(/Discord bot token +kept/);
    expect(f).toMatch(/DuckDNS token +kept/);
    expect(f).toContain('2. Apply with a new cookie secret');
    await press(r.s, 'down');
    expect(frame(r.s)).toContain('Logs everyone out of the pages');
    expect(f).toContain('They go to /opt/telinha/config/telinha.env.');
    // Quit without writing: the file stays as it was.
    await press(r.s, '4');
    expect(await r.code).toBe(1);
    expect(r.err).toEqual(['Nothing was written.']);
    expect(r.files.get(ENV)).toBe(text);
  });

  test('flags a terminal run cannot use: a notice on the first card, shown once', async () => {
    const r = await startSetup([...QUIET, '--host', 'home', '--public-url', 'https://t.example.com']);
    let f = await at(r, 'hosting');
    expect(f).toContain('! at home Telinha never relies on ports 80/443');
    await press(r.s, 'enter');
    f = await at(r, 'homeCf');
    expect(f).not.toContain('never relies on ports');
    await press(r.s, 'escape');
    expect(await at(r, 'hosting')).not.toContain('never relies on ports');
    await press(r.s, 'ctrl+c');
    await r.code;
  });

  test('telinha alone without a telinha.env: the welcome card, Quit declines', async () => {
    let r = await startOffer();
    const f = await until(r.s, 'Set Telinha up now?');
    expect(f).toContain('No configuration yet (/opt/telinha/config/telinha.env).');
    expect(f).toContain('screen sharing for a Discord group');
    await press(r.s, '2');
    expect(await r.code).toBeNull();
    // Set it up: the questions.
    r = await startOffer();
    await until(r.s, 'Set Telinha up now?');
    await press(r.s, 'enter');
    expect(await until(r.s, 'Language / Idioma')).toContain('❯ Where');
    await press(r.s, 'ctrl+c');
    expect(await r.code).toBe(130);
  });
});

describe('small terminals, Docker and progress', () => {
  test('80x24: the whole run fits; PgDn and PgUp move the Review rows', async () => {
    const r = await startSetup(QUIET, { width: 80, height: 24 });
    await homeDuckKeys(r);
    await discordKeys(r);
    let f = await defaultsToReview(r);
    expect(f).toMatch(/↓ \d+ more/);
    expect(f).toContain('❯ 1. Apply');
    expect(f.trimEnd().split('\n')).toHaveLength(24);
    // Down to the last rows, then back up to the first ones.
    for (let i = 0; i < 10 && /↓ \d+ more/.test(frame(r.s)); i++) await press(r.s, PAGE_DOWN);
    f = frame(r.s);
    expect(f).toMatch(/↑ \d+ more/);
    expect(f).toContain('Ask the router?');
    expect(f).toMatch(/Ports +Media ports/);
    for (let i = 0; i < 10 && /↑ \d+ more/.test(frame(r.s)); i++) await press(r.s, PAGE_UP);
    expect(frame(r.s)).toMatch(/Where +Where will Telin/);
    expect(await applyAndExit(r)).toBe(0);
    expect(vars(r)).toMatchObject(HOME_DUCK);
  });

  test('--docker: the file only, the host path, and how to start it on the host', async () => {
    const r = await startSetup([...QUIET, '--docker'], {
      env: { TELINHA_HOST_ENV: '/srv/telinha/config/telinha.env' },
    });
    await homeDuckKeys(r);
    await discordKeys(r);
    let f = await defaultsToReview(r);
    expect(f).toContain('They go to /srv/telinha/config/telinha.env.');
    expect(f).toContain('Write telinha.env; the host starts the container');
    await press(r.s, 'enter');
    f = await until(r.s, 'Start it on the host:');
    expect(f).toContain('Writing the configuration');
    expect(f).toContain('✔ Wrote /srv/telinha/config/telinha.env');
    expect(f).toContain('Start it on the host:  cd /opt/telinha && docker compose up -d');
    expect(f).not.toContain('Download the programs');
    expect(f).not.toContain('Show the doctor report');
    expect(await exit(r, f)).toBe(0);
    expect(vars(r)).toMatchObject(HOME_DUCK);
  });

  test('task rows: downloads without a size, the UAC wait, the certificate wait and the checks count', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((res) => (finish = res));
    const row = (id: TaskId, o: Partial<TaskRow>): TaskRow => ({
      id,
      status: 'running',
      detail: '',
      spinning: false,
      lines: [],
      progress: null,
      result: null,
      todo: [],
      ...o,
    });
    let changed = () => {};
    const tasks: SetupUiContext['tasks'] = {
      wroteAny: false,
      rows: [
        row('binaries', { progress: { done: 5 * 1024 * 1024, total: null, unit: 'bytes', label: 'caddy' } }),
        row('service', { detail: 'Approve the Windows administrator prompt…', spinning: true }),
        row('cert', {
          detail: 'Waiting for the HTTPS certificate',
          spinning: true,
          progress: { done: 45_000, total: 90_000, unit: 'ms' },
        }),
        row('doctor', { detail: '3 of 18 checks', spinning: true, progress: { done: 3, total: 18, unit: 'items' } }),
      ],
      subscribe: (fn) => {
        changed = fn;
        return () => {};
      },
    };
    const r = await startSetup(QUIET, {
      tasks,
      apply: async () => {
        changed();
        await gate;
        return { kind: 'done', code: 0, values: {}, tasks: {} as never, doctor: null };
      },
    });
    await homeDuckKeys(r);
    await discordKeys(r);
    await defaultsToReview(r);
    await press(r.s, 'enter');
    const f = await until(r.s, '3 of 18 checks');
    expect(f).toMatch(/⠋ Download the programs +5\.0 MB {2}caddy/);
    expect(f).toMatch(/⠋ Install the service +Approve the Windows administrator prompt…/);
    expect(f).toMatch(/⠋ HTTPS certificate +█{11}░{11} {2}50% {2}Waiting for the HTTPS cert/);
    expect(f).toMatch(/⠋ Check everything +█{4}░{18} 3 of 18 checks/);
    finish();
    await until(r.s, 'Exit');
    await press(r.s, 'enter');
    expect(await r.code).toBe(0);
  });
});
