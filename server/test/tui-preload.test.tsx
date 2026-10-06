// Guards the bunfig [test] preload: without it bun test loads Solid's server
// build and signals never update, so this frame would stay on "count 0".
import { expect, test } from 'bun:test';
import { testRender, useKeyboard } from '@opentui/solid';
import { createSignal } from 'solid-js';

function Counter() {
  const [n, setN] = createSignal(0);
  useKeyboard((key) => {
    if (key.name === 'x') setN((v) => v + 1);
  });
  return <text fg="#ffffff">count {n()}</text>;
}

test('Solid reacts to a key press under bun test', async () => {
  const s = await testRender(() => <Counter />, { width: 20, height: 3 });
  try {
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('count 0');
    s.mockInput.pressKey('x');
    await Bun.sleep(30);
    await s.renderOnce();
    expect(s.captureCharFrame()).toContain('count 1');
  } finally {
    s.renderer.destroy();
  }
});
