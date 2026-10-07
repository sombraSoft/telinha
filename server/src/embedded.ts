// The page built into the native binary: Bun.build's `compile.assets: ['<root>/web/dist']`
// keeps only the directory's basename, next to the bundled entry.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isCompiled } from './version.ts';

/** The embedded web/dist when this is the compiled binary and it has a page; null otherwise (dev, Docker). */
export function embeddedWebDir(o: { compiled?: boolean; dir?: string } = {}): string | null {
  if (!(o.compiled ?? isCompiled())) return null;
  const dir = o.dir ?? join(import.meta.dir, 'dist');
  return existsSync(join(dir, 'index.html')) ? dir : null;
}
