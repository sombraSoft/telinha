// Dev and the Docker image run the TypeScript source, so the Solid JSX transform
// has to be registered at runtime; the native binary is pre-transformed by the
// build plugin and needs nothing.
import { isCompiled } from '../version.ts';

let prepared: Promise<void> | null = null;

export function prepareTui(): Promise<void> {
  if (isCompiled()) return Promise.resolve();
  // Non-literal specifier: the bundler must not follow it and pull Babel into the binary.
  prepared ??= (async () => {
    const spec = '@opentui/solid/' + 'preload';
    await import(spec);
  })();
  return prepared;
}
