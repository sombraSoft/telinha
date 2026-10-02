// Builds web/dist: the static room page plus livekit-client's ESM bundle, which
// the server serves from /sala/. Plain copies, no bundling, so the browser gets
// exactly the files in src/.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const src = join(import.meta.dir, 'src');
const dist = join(import.meta.dir, 'dist');

// Find livekit-client's package root through module resolution (works with
// hoisted or workspace-local node_modules) instead of a hardcoded path.
function pkgRoot(name: string): string {
  let dir = dirname(Bun.resolveSync(name, import.meta.dir));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && require(pkg).name === name) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`package root of ${name} not found`);
    dir = up;
  }
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const f of await readdir(src)) {
  await cp(join(src, f), join(dist, f), { recursive: true });
  console.log(`web/dist/${f}`);
}
const lk = join(pkgRoot('livekit-client'), 'dist', 'livekit-client.esm.mjs');
if (!(await Bun.file(lk).exists())) throw new Error(`missing ${lk}`);
await cp(lk, join(dist, 'livekit-client.esm.mjs'));
console.log('web/dist/livekit-client.esm.mjs');
