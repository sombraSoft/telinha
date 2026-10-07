// Frames of the setup screens, EN and pt-BR, as snapshots: a full run per
// language (questions, Review, the install running, failing and done), the
// VPS address list and the welcome card, plus two cards at 80x30. POSIX paths
// and version `test`, so the frames are the same on Windows and Linux.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Locale } from '../src/cli/strings.ts';
import { frame, paste, press, typeText, until } from './tui-harness.tsx';
import {
  at,
  BAD_TOKEN,
  DUCK,
  fakeChecks,
  fakeDoctor,
  SECRET,
  startOffer,
  startSetup,
  TOKEN,
  VPS_NAT,
} from './tui-setup-fixtures.ts';

setDefaultTimeout(30_000);

const LANGS: Locale[] = ['en', 'pt-BR'];
// What the run waits for on the last cards, in each language.
const TEXT = {
  en: { retry: 'Retry', running: 'Telinha is running', welcome: 'Set Telinha up now?', downloading: '52%' },
  'pt-BR': {
    retry: 'Tentar de novo',
    running: 'A Telinha está rodando',
    welcome: 'Configurar a Telinha agora?',
    downloading: '52%',
  },
} as const;

describe.each(LANGS)('setup frames, %s 120x34', (lang) => {
  test('a home install from the first question to the last card', async () => {
    let release!: () => void;
    const binsHold = new Promise<void>((r) => (release = r));
    const r = await startSetup(['--lang', lang, '--no-upnp'], {
      locale: lang,
      compiled: true,
      serviceFails: 1,
      binsHold,
      doctor: fakeDoctor(),
      doctorChecks: fakeChecks({ n: 0 }),
    });
    const s = r.s;
    expect(await at(r, 'hosting')).toMatchSnapshot('where');
    await press(s, 'enter');
    expect(await at(r, 'homeCf')).toMatchSnapshot('home-cloudflare');
    await press(s, '2');
    await at(r, 'duckName');
    await typeText(s, 'my-group');
    await press(s, 'enter');
    await at(r, 'duckToken');
    await paste(s, DUCK);
    expect(frame(s)).toMatchSnapshot('duck-token');
    await press(s, 'enter');
    expect(await at(r, 'httpsPort')).toMatchSnapshot('https-port');
    await press(s, 'enter');
    await at(r, 'discordToken');
    let open!: () => void;
    r.world.hold = new Promise((res) => (open = res));
    await paste(s, BAD_TOKEN);
    await press(s, 'enter');
    expect(await at(r, 'discordToken', { running: true })).toMatchSnapshot('bot-token-checking');
    r.world.hold = null;
    open();
    expect(await at(r, 'discordToken')).toMatchSnapshot('bot-token-rejected');
    await press(s, 'ctrl+u');
    await paste(s, TOKEN);
    await press(s, 'enter');
    await at(r, 'clientSecret');
    await paste(s, SECRET);
    await press(s, 'enter');
    expect(await at(r, 'guild')).toMatchSnapshot('guild');
    await press(s, 'enter');
    await at(r, 'role');
    await press(s, 'enter');
    await at(r, 'channels');
    await press(s, 'down', 'space');
    expect(frame(s)).toMatchSnapshot('channels');
    await press(s, 'enter');
    await at(r, 'command');
    await press(s, 'enter');
    await at(r, 'group');
    await press(s, 'enter');
    await at(r, 'media');
    await press(s, 'enter');
    await at(r, 'mediaPorts');
    await press(s, 'enter');
    expect(await at(r, 'upnp')).toMatchSnapshot('router');
    await press(s, 'tab');
    expect(frame(s)).toMatchSnapshot('sidebar');
    await press(s, 'escape');
    await press(s, 'enter');
    await at(r, 'autoUpdate');
    await press(s, 'enter');
    expect(await at(r, 'review')).toMatchSnapshot('review');
    await press(s, 'enter');
    expect(await until(s, TEXT[lang].downloading)).toMatchSnapshot('apply-running');
    release();
    expect(await until(s, TEXT[lang].retry)).toMatchSnapshot('apply-failed');
    await press(s, 'enter');
    expect(await until(s, TEXT[lang].running, 5000)).toMatchSnapshot('apply-done');
    await press(s, 'down', 'enter');
    expect(await r.code).toBe(0);
  });

  test('a VPS: the address choices', async () => {
    const r = await startSetup(['--lang', lang], { locale: lang, nat: VPS_NAT, compiled: true });
    await at(r, 'hosting');
    await press(r.s, 'enter');
    expect(await at(r, 'vpsAddress')).toMatchSnapshot('vps-address');
    await press(r.s, 'ctrl+c');
    await r.code;
  });

  test('telinha alone without a telinha.env: the welcome card', async () => {
    const r = await startOffer({ locale: lang, env: { LANG: lang === 'en' ? 'en_US.UTF-8' : 'pt_BR.UTF-8' } });
    expect(await until(r.s, TEXT[lang].welcome)).toMatchSnapshot('welcome');
    await press(r.s, 'ctrl+c');
    await r.code;
  });
});

describe('setup frames, en 80x30', () => {
  test('the first question and a pasted token: the hint pane under the card, cut to fit', async () => {
    const r = await startSetup(['--lang', 'en'], { width: 80, height: 30 });
    expect(await at(r, 'hosting')).toMatchSnapshot('where 80x30');
    await press(r.s, 'enter');
    await at(r, 'homeCf');
    await press(r.s, '2');
    await at(r, 'duckName');
    await typeText(r.s, 'my-group');
    await press(r.s, 'enter');
    await at(r, 'duckToken');
    await paste(r.s, DUCK);
    expect(frame(r.s)).toMatchSnapshot('duck-token 80x30');
    await press(r.s, 'ctrl+c');
    await r.code;
  });
});

/** 24 rows, nothing drawn over the key help on the last one. */
function fits24(f: string): string {
  const lines = f.trimEnd().split('\n');
  expect(lines).toHaveLength(24);
  expect(lines.at(-1)).toMatch(/^ ↑↓ \S+ {2}enter \S+ .*ctrl\+c \S+$/);
  expect(lines.at(-1)).not.toContain('─');
  return f;
}

describe.each(LANGS)('setup frames, %s 80x24 (the smallest terminal)', (lang) => {
  test('a Review with a note, a failed install, the last card: everything that matters fits', async () => {
    const r = await startSetup(['--lang', lang], {
      locale: lang,
      compiled: true,
      serviceFails: 1,
      width: 80,
      height: 24,
      doctor: fakeDoctor(),
      doctorChecks: fakeChecks({ n: 0 }),
    });
    // A login redirect the app lacks, skipped: a note on the Review.
    r.world.redirects = [];
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
    await at(r, 'httpsPort');
    await press(r.s, 'enter');
    await at(r, 'discordToken');
    await paste(r.s, TOKEN);
    await press(r.s, 'enter');
    await at(r, 'clientSecret');
    await paste(r.s, SECRET);
    await press(r.s, 'enter');
    await at(r, 'redirect');
    await press(r.s, '2');
    for (const id of [
      'guild',
      'role',
      'channels',
      'command',
      'group',
      'media',
      'mediaPorts',
      'upnp',
      'autoUpdate',
    ] as const) {
      await at(r, id);
      await press(r.s, ...(id === 'channels' ? ['space', 'enter'] : ['enter']));
    }
    let f = fits24(await at(r, 'review'));
    // Every choice, the note further down the rows.
    expect(f).toMatch(/1\. \S+/);
    expect(f).toMatch(/3\. \S+/);
    expect(f).toMatchSnapshot('review 80x24');
    // The note scrolls with the rows.
    for (let i = 0; i < 10 && /↓ /.test(frame(r.s)); i++) await press(r.s, '\x1b[6~');
    expect(fits24(frame(r.s))).toContain('! ');
    for (let i = 0; i < 10 && /↑ /.test(frame(r.s)); i++) await press(r.s, '\x1b[5~');
    await press(r.s, 'enter');
    f = fits24(await until(r.s, TEXT[lang].retry, 5000));
    // The failed task's error in full, every choice.
    expect(f).toContain('systemctl');
    expect(f).toContain('with 1');
    expect(f).toMatch(/3\. \S+/);
    expect(f).toMatchSnapshot('apply-failed 80x24');
    await press(r.s, 'enter');
    f = fits24(await until(r.s, TEXT[lang].running, 5000));
    expect(f).toMatch(/2\. \S+/);
    expect(f).toMatchSnapshot('apply-done 80x24');
    await press(r.s, 'down', 'enter');
    expect(await r.code).toBe(0);
  });
});
