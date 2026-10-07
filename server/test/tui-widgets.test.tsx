import { describe, expect, test } from 'bun:test';
import { createSignal } from 'solid-js';
import { qrMatrix } from '../src/doctor/qr.ts';
import { Footer, fitFooter, Header, Sidebar, type SidebarStep } from '../src/tui/ui/chrome.tsx';
import { fit, fitTail, pad, useLayout, windowStart, wrap } from '../src/tui/ui/layout.ts';
import { qrRows } from '../src/tui/ui/qr.tsx';
import { Bar, Field, HintPane, Picker, type PickOption, StatusIcon } from '../src/tui/ui/widgets.tsx';
import { frame, paste, press, settle, typeText, until, VERSION, withTui } from './tui-harness.tsx';

const OPTS: PickOption[] = [
  { value: 'home', label: 'A computer at home', desc: 'Your PC or a home server' },
  { value: 'vps', label: 'A rented server (VPS)', desc: 'Hetzner, DigitalOcean and similar', chosen: true },
  { value: 'adv', label: 'Advanced…', desc: 'Only if you know why', subtle: true },
];

describe('fit and friends', () => {
  test('fit cuts by display width with a trailing …', () => {
    expect(fit('hello world', 20)).toBe('hello world');
    expect(fit('hello world', 6)).toBe('hello…');
    expect(fit('hello', 0)).toBe('');
    // Wide characters count two columns.
    expect(fit('日本語テキスト', 7)).toBe('日本語…');
    expect(Bun.stringWidth(fit('日本語テキスト', 7))).toBeLessThanOrEqual(7);
  });

  test('fitTail keeps the end, pad fills to the width', () => {
    expect(fitTail('abcdefgh', 5)).toBe('…efgh');
    expect(pad('ab', 4)).toBe('ab  ');
    expect(pad('abcdef', 4)).toBe('abc…');
  });

  test('wrap by words, long words split, blank lines kept', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('https://example.com/abc', 10)).toEqual(['https://ex', 'ample.com/', 'abc']);
    expect(wrap('a\n\nb', 5)).toEqual(['a', '', 'b']);
  });

  test('windowStart keeps the index in view and moves as little as possible', () => {
    expect(windowStart(0, 10, 4)).toBe(0);
    expect(windowStart(5, 10, 4, 0)).toBe(2);
    expect(windowStart(3, 10, 4, 2)).toBe(2);
    expect(windowStart(1, 10, 4, 2)).toBe(1);
    expect(windowStart(9, 10, 20)).toBe(0);
  });
});

describe('useLayout', () => {
  function Probe() {
    const L = useLayout();
    return (
      <text fg="#ffffff">{`sidebar=${L.sidebar()} side=${L.side()} card=${L.cardW()} hint=${L.hintW()} list=${L.listRows()}`}</text>
    );
  }
  test('hint pane beside the card from 110 columns of card+hint; no sidebar under 80', async () => {
    const at = (width: number, height: number) =>
      withTui(
        () => <Probe />,
        { width, height },
        async (s) => frame(s).trim(),
      );
    // 139 - 2 - 27 = 110: side by side, the hint pane 38 wide.
    expect(await at(139, 34)).toBe('sidebar=true side=true card=71 hint=38 list=22');
    expect(await at(138, 34)).toBe('sidebar=true side=false card=109 hint=109 list=22');
    expect(await at(80, 30)).toBe('sidebar=true side=false card=51 hint=51 list=18');
    expect(await at(79, 12)).toBe('sidebar=false side=false card=77 hint=77 list=4');
  });
});

describe('Picker', () => {
  test('numbered rows, descriptions, the saved answer and a subtle row', async () => {
    await withTui(
      () => <Picker options={OPTS} onConfirm={() => {}} />,
      { width: 80, height: 14 },
      async (s) => {
        const f = frame(s);
        expect(f).toContain('  1. A computer at home');
        expect(f).toContain('❯ 2. A rented server (VPS)  ✓ current answer');
        expect(f).toContain('     Hetzner, DigitalOcean and similar');
        // Subtle rows get a blank line above.
        expect(f).toMatch(/similar\n\s*\n\s+3\. Advanced…/);
      },
    );
  });

  test('a digit picks; arrows and j/k move and wrap', async () => {
    const got: unknown[] = [];
    const moves: number[] = [];
    await withTui(
      () => <Picker options={OPTS} initial={0} onMove={(i) => moves.push(i)} onConfirm={(v) => got.push(v)} />,
      { width: 80, height: 14 },
      async (s) => {
        await press(s, 'up');
        expect(frame(s)).toContain('❯ 3. Advanced…');
        await press(s, 'j');
        expect(frame(s)).toContain('❯ 1. A computer at home');
        await press(s, 'k', 'k');
        expect(frame(s)).toContain('❯ 2. A rented server');
        await press(s, 'enter');
        expect(got).toEqual(['vps']);
        await press(s, '1');
        expect(got).toEqual(['vps', 'home']);
        expect(moves).toEqual([0, 2, 0, 2, 1, 0]);
      },
    );
  });

  test('a long list shows a window with "↑ N more" / "↓ N more"', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      value: `c${i + 1}`,
      label: `#channel-${i + 1}`,
      desc: `topic ${i + 1}`,
    }));
    await withTui(
      () => <Picker options={many} maxRows={8} width={40} onConfirm={() => {}} />,
      { width: 60, height: 14 },
      async (s) => {
        let f = frame(s);
        expect(f).toContain('❯  1. #channel-1');
        expect(f).toContain('topic 1');
        // Only the highlighted row has its description when the list is tight.
        expect(f).not.toContain('topic 2');
        expect(f).toContain('↓ 15 more');
        expect(f).not.toContain('↑');
        await press(s, ...Array<string>(8).fill('down'));
        f = frame(s);
        expect(f).toContain('❯  9. #channel-9');
        expect(f).toMatch(/↑ \d+ more/);
        expect(f).toMatch(/↓ \d+ more/);
        await press(s, 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up', 'up');
        f = frame(s);
        expect(f).toContain('❯ 20. #channel-20');
        expect(f).toContain('↑ 15 more');
        expect(f).not.toContain('↓');
      },
    );
  });

  test('multi: space toggles, a toggles all, min shows the error', async () => {
    const got: unknown[] = [];
    const opts = [
      { value: 'g', label: '#general' },
      { value: 'm', label: '#games' },
      { value: 'n', label: '#movie-night' },
    ];
    await withTui(
      () => (
        <Picker
          multi
          allKey
          options={opts}
          min={1}
          minError="Pick at least one channel."
          onConfirm={(v) => got.push(v)}
        />
      ),
      { width: 60, height: 12 },
      async (s) => {
        expect(frame(s)).toContain('0 selected');
        await press(s, 'enter');
        expect(frame(s)).toContain('Pick at least one channel.');
        await press(s, 'space');
        expect(frame(s)).toContain('1 selected');
        await press(s, 'down', 'down', 'space');
        let f = frame(s);
        expect(f).toContain('[x] #general');
        expect(f).toContain('[ ] #games');
        expect(f).toContain('[x] #movie-night');
        expect(f).toContain('2 selected');
        // Digits move in multi mode, they do not confirm.
        await press(s, '2');
        expect(frame(s)).toContain('❯ 2. [ ] #games');
        expect(got).toEqual([]);
        await press(s, 'a');
        expect(frame(s)).toContain('3 selected');
        await press(s, 'a');
        expect(frame(s)).toContain('0 selected');
        await press(s, 'a', 'enter');
        expect(got).toEqual([['g', 'm', 'n']]);
        f = frame(s);
        expect(f).toContain('[x] #games');
      },
    );
  });

  test('inactive: keys go elsewhere', async () => {
    const got: unknown[] = [];
    const [on, setOn] = createSignal(false);
    await withTui(
      () => <Picker options={OPTS} active={on} onConfirm={(v) => got.push(v)} />,
      { width: 60, height: 12 },
      async (s) => {
        await press(s, '1', 'enter');
        expect(got).toEqual([]);
        setOn(true);
        await press(s, '1');
        expect(got).toEqual(['home']);
      },
    );
  });
});

describe('Field', () => {
  test('typing, backspace, Ctrl+U, default on an empty Enter', async () => {
    const got: string[] = [];
    await withTui(
      () => <Field width={40} placeholder="call.example.com" defaultText="telinha" onSubmit={(v) => got.push(v)} />,
      { width: 60, height: 8 },
      async (s) => {
        expect(frame(s)).toContain('▌call.example.com');
        expect(frame(s)).toContain('default: telinha');
        await typeText(s, 'guri');
        expect(frame(s)).toContain('guri▌');
        await press(s, 'backspace');
        expect(frame(s)).toContain('gur▌');
        await press(s, 'enter');
        await press(s, 'ctrl+u');
        expect(frame(s)).toContain('▌call.example.com');
        await press(s, 'enter');
        expect(got).toEqual(['gur', 'telinha']);
      },
    );
  });

  test('secret: bracketed paste is masked, newlines stripped, Ctrl+R reveals', async () => {
    const got: string[] = [];
    // gitleaks:allow
    const token = 'a3f9c2e1-7b44-4d0e-9c51-2f8e6b1d03aa'; // gitleaks:allow
    await withTui(
      () => <Field secret width={50} onSubmit={(v) => got.push(v)} />,
      { width: 60, height: 8 },
      async (s) => {
        await paste(s, `${token}\n`);
        let f = await until(s, '36 characters · pasted');
        expect(f).not.toContain('a3f9c2e1');
        expect(f).toContain('•'.repeat(36));
        await press(s, 'ctrl+r');
        f = frame(s);
        expect(f).toContain(token);
        await press(s, 'ctrl+r');
        expect(frame(s)).not.toContain('a3f9c2e1');
        await press(s, 'enter');
        expect(got).toEqual([token]);
      },
    );
  });

  test('a secret wider than the box keeps its tail with a leading …', async () => {
    await withTui(
      () => <Field secret width={20} onSubmit={() => {}} />,
      { width: 40, height: 6 },
      async (s) => {
        await paste(s, 'x'.repeat(40));
        const f = frame(s);
        expect(f).toContain(`…${'•'.repeat(14)}▌`);
        expect(f).toContain('40 characters');
      },
    );
  });

  test('keepsSecret says Enter keeps the saved value; ←, Esc and Tab fall through', async () => {
    const got: string[] = [];
    await withTui(
      () => <Field secret keepsSecret width={50} onSubmit={(v) => got.push(v)} />,
      { width: 60, height: 8 },
      async (s) => {
        expect(frame(s)).toContain('Enter keeps the current one');
        await press(s, 'left', 'escape', 'tab', 'enter');
        expect(got).toEqual(['']);
      },
    );
  });
});

describe('chrome', () => {
  const steps: SidebarStep[] = [
    { id: 'where', label: 'Where', state: 'done', summary: 'A computer at home, behind a router' },
    { id: 'address', label: 'Address', state: 'failed' },
    { id: 'discord', label: 'Discord', state: 'current' },
    { id: 'install', label: 'Install', state: 'pending' },
  ];

  test('sidebar states, summaries cut to the column, focus keys', async () => {
    const calls: string[] = [];
    const [focused, setFocused] = createSignal(false);
    const [cursor, setCursor] = createSignal(0);
    await withTui(
      () => (
        <Sidebar
          steps={steps}
          focused={focused()}
          cursor={cursor()}
          onMove={(i) => (calls.push(`move ${i}`), setCursor(i))}
          onJump={(i) => calls.push(`jump ${i}`)}
          onLeave={() => calls.push('leave')}
        />
      ),
      { width: 40, height: 16 },
      async (s) => {
        let f = frame(s);
        expect(f).toContain('✔ Where');
        expect(f).toContain('  A computer at home,… │');
        expect(f).toContain('✖ Address');
        expect(f).toContain('❯ Discord');
        expect(f).toContain('○ Install');
        expect(f).not.toContain('Pick a step');
        await press(s, 'down');
        expect(calls).toEqual([]);
        setFocused(true);
        await settle(s);
        f = frame(s);
        expect(f).toContain('steps');
        expect(f).toContain('Where  ‹');
        expect(f).toContain('Pick a step to jump to');
        await press(s, 'up', 'enter', 'escape');
        expect(calls).toEqual(['move 3', 'jump 3', 'leave']);
        expect(frame(s)).toMatchSnapshot();
      },
    );
  });

  test('sidebar in few rows: the blank rows go first, then the summaries; a summary in parts joins or splits', async () => {
    const many: SidebarStep[] = [
      { id: 'where', label: 'Where', state: 'done', summary: 'A computer at home' },
      { id: 'ports', label: 'Ports', state: 'done', summary: 'TCP 7881, 8443\nUDP 7882' },
      { id: 'tunnel', label: 'Tunnel', state: 'done', summary: 'TCP 7881\nUDP 7882' },
      { id: 'review', label: 'Review', state: 'current' },
    ];
    const [rows, setRows] = createSignal<number | undefined>(undefined);
    const noop = () => {};
    await withTui(
      () => (
        <Sidebar steps={many} focused={false} cursor={0} maxRows={rows()} onMove={noop} onJump={noop} onLeave={noop} />
      ),
      { width: 40, height: 20 },
      async (s) => {
        const height = () => frame(s).trimEnd().split('\n').length;
        let f = frame(s);
        // Too long for one line: one line per part. Short enough: joined.
        expect(f).toContain('│   TCP 7881, 8443       │\n│   UDP 7882             │');
        expect(f).toContain('TCP 7881 · UDP 7882');
        expect(height()).toBe(2 + 4 * 2 + 4);
        setRows(13);
        await settle(s);
        f = frame(s);
        expect(height()).toBe(2 + 4 + 4);
        expect(f).toContain('A computer at home');
        setRows(8);
        await settle(s);
        f = frame(s);
        expect(height()).toBe(2 + 4);
        expect(f).not.toContain('A computer at home');
      },
    );
  });

  test('footer: what does not fit leaves, the least needed keys first, quit last', () => {
    const items: [string, string][] = [
      ['↑↓', 'mover'],
      ['enter', 'escolher'],
      ['pgup/pgdn', 'rolar'],
      ['esc/←', 'voltar'],
      ['tab', 'passos'],
      ['ctrl+c', 'sair'],
    ];
    expect(fitFooter(items, 120)).toEqual(items);
    expect(fitFooter(items, 80).map(([k]) => k)).toEqual(['↑↓', 'enter', 'pgup/pgdn', 'esc/←', 'ctrl+c']);
    expect(fitFooter(items, 40).map(([k]) => k)).toEqual(['↑↓', 'enter', 'ctrl+c']);
  });

  test('header, footer, status icons, bar', async () => {
    await withTui(
      () => (
        <box flexDirection="column">
          <Header mode="doctor" version={VERSION} />
          <box flexDirection="row" gap={1}>
            <StatusIcon status="ok" />
            <StatusIcon status="warn" />
            <StatusIcon status="fail" />
            <StatusIcon status="skip" />
            <StatusIcon status="pending" />
            <Bar value={50} width={10} />
          </box>
          <Footer
            items={[
              ['↑↓', 'move'],
              ['enter', 'details'],
              ['q', 'quit'],
            ]}
          />
        </box>
      ),
      { width: 80, height: 8 },
      async (s) => {
        const f = frame(s);
        expect(f).toContain('telinha doctor');
        expect(f).toContain('Screen sharing for your Discord group');
        expect(f).toContain('vtest');
        expect(f).toContain('✔ ! ✖ – ○ █████░░░░░');
        expect(f).toContain('↑↓ move  enter details  q quit');
        expect(f).toMatchSnapshot();
      },
    );
  });

  test('pt-BR header', async () => {
    await withTui(
      () => <Header mode="setup" version={VERSION} right="algo" />,
      { width: 80, height: 5, locale: 'pt-BR' },
      async (s) => {
        const f = frame(s);
        expect(f).toContain('telinha configuração');
        expect(f).toContain('Compartilhamento de tela pro seu grupo do Discord');
        expect(f).toContain('algo');
      },
    );
  });

  test('hint pane wraps and ends an overflow with …', async () => {
    await withTui(
      () => (
        <HintPane
          lines={['one two three four five six seven eight nine ten eleven twelve']}
          extra={{ head: 'Ports', items: ['UDP 7882'] }}
          width={20}
          maxRows={6}
        />
      ),
      { width: 30, height: 10 },
      async (s) => {
        const f = frame(s);
        expect(f).toContain('About this');
        expect(f).toContain('│ one two three    │');
        expect(f).toContain('│ …');
        expect(f).not.toContain('UDP 7882');
      },
    );
  });
});

describe('QR', () => {
  test('two module rows per cell row with blocks, one per row without', () => {
    const m = qrMatrix('https://telinha.example.com/doctor?t=TOKEN');
    expect(m.length).toBeGreaterThan(20);
    // Quiet zone: the first two rows are light.
    expect(m[0]!.every((d) => !d) && m[1]!.every((d) => !d)).toBe(true);
    const blocks = qrRows('https://telinha.example.com/doctor?t=TOKEN', true);
    expect(blocks.length).toBe(Math.ceil(m.length / 2));
    expect(blocks[0]!.map((r) => r.text).join('')).toBe('▀'.repeat(m.length));
    const cells = qrRows('https://telinha.example.com/doctor?t=TOKEN', false);
    expect(cells.length).toBe(m.length);
    expect(cells[0]!.map((r) => r.text).join('')).toBe('  '.repeat(m.length));
    // Always dark on light, whatever the theme.
    expect(new Set(blocks.flat().flatMap((r) => [r.fg, r.bg]))).toEqual(new Set(['#000000', '#ffffff']));
  });
});
