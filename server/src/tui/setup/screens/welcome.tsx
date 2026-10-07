// `telinha` alone with no telinha.env yet: offer the setup before anything is asked.
import { createMemo } from 'solid-js';
import { ts } from '../../../cli/strings.ts';
import { useLocale } from '../../strings.ts';
import { c } from '../../theme.ts';
import { fit, useLayout } from '../../ui/layout.ts';
import { Bold, Card, Picker } from '../../ui/widgets.tsx';
import { useS } from '../strings.ts';
import { Lines, paint } from './question.tsx';

export function WelcomeScreen(p: { envFile: string; active: () => boolean; onGo(): void; onQuit(): void }) {
  const s = useS();
  const locale = useLocale();
  const L = useLayout();
  const fullW = () => (L.side() ? L.cardW() + L.hintW() + 1 : L.cardW());
  const inner = () => Math.max(10, fullW() - 6);
  const intro = createMemo(() => paint(ts(locale(), 'noConfig', { path: p.envFile }), inner(), c.muted));
  const about = createMemo(() => paint(s('welcome.about'), inner(), c.muted));
  return (
    <Card title={` ${s('welcome.title')} `} width={fullW()} active={p.active()}>
      <text fg={c.text} attributes={Bold} wrapMode="none">{fit(ts(locale(), 'offerSetup'), inner())}</text>
      <Lines lines={intro()} />
      <box flexDirection="column" marginTop={1} flexShrink={0}>
        <Lines lines={about()} />
      </box>
      <box marginTop={1} flexShrink={0}>
        <Picker
          options={[
            { value: 'go', label: s('welcome.go'), desc: s('welcome.goDesc') },
            { value: 'quit', label: s('welcome.quit'), desc: s('welcome.quitDesc') },
          ]}
          width={inner()}
          active={p.active}
          onConfirm={(v) => (v === 'go' ? p.onGo() : p.onQuit())}
        />
      </box>
    </Card>
  );
}
