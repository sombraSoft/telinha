// `bun run image`: builds the image locally with docker or podman and runs the
// same smoke test as CI inside it (scripts/smoke.sh ships in the image, so no
// mount). Exits non-zero on any failure.
import { $ } from 'bun';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TAG = 'telinha:dev';

const step = (s: string) => console.log(`\n==> ${s}`);
// Skip .cmd/.bat shims (e.g. a docker.cmd wrapping podman on Windows): Bun
// cannot pass arguments through cmd.exe reliably.
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
    // Run it outside the repo: under Git Bash, podman's ssh writes the VM's
    // host key to a literal file named NUL in the working directory.
    step('podman machine start');
    await $`${bin} machine start`.cwd(tmpdir());
  }
  step(`${engine} build -t ${TAG} .`);
  await $`${bin} build -t ${TAG} .`;
  step('smoke test');
  // The image's entrypoint is the program; the smoke script needs a shell.
  await $`${bin} run --rm --entrypoint sh ${TAG} scripts/smoke.sh`;
  step('ok');
} catch (e) {
  console.error(`\nfailed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
