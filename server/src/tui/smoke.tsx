// Build smoke (TELINHA_SMOKE_TUI=1): proves this build carries OpenTUI's native
// library for its target AND a reactive Solid build. The key press matters:
// Solid's server build still renders the first frame, only reactivity dies.
import { testRender, useKeyboard } from '@opentui/solid';
import { createSignal } from 'solid-js';

function Counter() {
  const [n, setN] = createSignal(0);
  useKeyboard((key) => {
    if (key.name === 'x') setN((v) => v + 1);
  });
  return <text fg="#ffffff">count {n()}</text>;
}

/** 0 when a key press re-renders the frame, 1 otherwise (both frames printed). */
export async function smoke(): Promise<number> {
  const s = await testRender(() => <Counter />, { width: 20, height: 3 });
  try {
    await s.renderOnce();
    const first = s.captureCharFrame();
    s.mockInput.pressKey('x');
    // Key parsing is async: give it a tick before rendering again.
    await Bun.sleep(30);
    await s.renderOnce();
    const second = s.captureCharFrame();
    if (second !== first && second.includes('count 1')) {
      console.log(`tui smoke ok:\n${second.trimEnd()}`);
      return 0;
    }
    console.error(
      `tui smoke FAILED: the key press did not re-render\n--- before\n${first.trimEnd()}\n--- after\n${second.trimEnd()}`,
    );
    return 1;
  } finally {
    s.renderer.destroy();
  }
}
