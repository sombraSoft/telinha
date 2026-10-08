// The phone-test link as a QR code drawn with explicit colours: always dark
// modules on white, whatever the terminal theme, or phones fail to scan it.
// "▀" packs two module rows per cell row (fg = top, bg = bottom) where the
// terminal draws blocks well; elsewhere every module is two spaces with a
// background colour.
import { createMemo, For } from 'solid-js';
import { canDrawBlocks, qrMatrix } from '../../doctor/qr.ts';

const DARK = '#000000';
const LIGHT = '#ffffff';

interface Run {
  text: string;
  fg: string;
  bg: string;
}

function runs(cells: { fg: string; bg: string }[], glyph: string): Run[] {
  const out: Run[] = [];
  for (const cell of cells) {
    const last = out[out.length - 1];
    if (last && last.fg === cell.fg && last.bg === cell.bg) last.text += glyph;
    else out.push({ text: glyph, ...cell });
  }
  return out;
}

/** Rows of colour runs; exported for the tests. */
export function qrRows(text: string, blocks: boolean): Run[][] {
  const m = qrMatrix(text);
  const color = (dark: boolean | undefined) => (dark ? DARK : LIGHT);
  if (!blocks)
    return m.map((row) =>
      runs(
        row.map((d) => ({ fg: color(d), bg: color(d) })),
        '  ',
      ),
    );
  const out: Run[][] = [];
  for (let y = 0; y < m.length; y += 2) {
    const top = m[y];
    const bottom = m[y + 1];
    if (!top) break;
    out.push(
      runs(
        top.map((d, x) => ({ fg: color(d), bg: color(bottom?.[x] ?? false) })),
        '▀',
      ),
    );
  }
  return out;
}

export function QrView(props: { text: string; env: Record<string, string | undefined> }) {
  const rows = createMemo(() => qrRows(props.text, canDrawBlocks(props.env)));
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row" flexShrink={0}>
            <For each={row}>
              {(r) => (
                <text fg={r.fg} bg={r.bg} wrapMode="none">
                  {r.text}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}
