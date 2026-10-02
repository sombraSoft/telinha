// `bun run image`: builds the image locally with docker or podman and runs the
// same smoke test as CI inside it. Exits non-zero on any failure.
import { $ } from 'bun';
import { fileURLToPath } from 'node:url';

const TAG = 'telinha:dev';
// Keep in sync with the image job in .github/workflows/ci.yml.
const SMOKE = 'node --check server/src/index.js && node --test server/test/*.test.js'
  + ' && test -f web/dist/index.html && test -f web/dist/app.js && test -f web/dist/app.css'
  + ' && test -f web/dist/livekit-client.esm.mjs';

const step = (s: string) => console.log(`\n==> ${s}`);
// Skip .cmd/.bat shims (e.g. a docker.cmd wrapping podman on Windows): Bun
// refuses to pass SMOKE, which contains && and *, through cmd.exe.
const isShim = (p: string) => /\.(cmd|bat)$/i.test(p);
const found = ['docker', 'podman']
  .map((name) => ({ name, bin: Bun.which(name) }))
  .find((e): e is { name: string; bin: string } => !!e.bin && !isShim(e.bin));
if (!found) {
  console.error('neither docker nor podman (as a real executable) found on PATH');
  process.exit(1);
}
const { name: engine, bin } = found;
$.cwd(fileURLToPath(new URL('..', import.meta.url)));

try {
  step(`using ${engine} (${bin})`);
  if (engine === 'podman' && (await $`${bin} info`.quiet().nothrow()).exitCode !== 0) {
    // On Windows/macOS podman runs in a VM that may be stopped.
    step('podman machine start');
    await $`${bin} machine start`;
  }
  step(`${engine} build -t ${TAG} .`);
  await $`${bin} build -t ${TAG} .`;
  step('smoke test');
  await $`${bin} run --rm ${TAG} sh -c ${SMOKE}`;
  step('ok');
} catch (e) {
  console.error(`\nfailed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
