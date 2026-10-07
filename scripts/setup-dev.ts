// Runs after `mise install` (mise.toml [hooks] postinstall) so one command sets up
// a fresh clone: mise installs the toolchain, this installs the dependencies and
// the git hooks (lefthook.yml). CI installs its own dependencies with
// --frozen-lockfile and needs no hooks, so it is a no-op there.
//
//   bun scripts/setup-dev.ts
if (process.env.CI) process.exit(0);

for (const cmd of [
  [process.execPath, 'install'],
  ['lefthook', 'install'],
]) {
  // spawnSync throws when the program is not on PATH (lefthook outside mise).
  const run = (() => {
    try {
      return Bun.spawnSync(cmd, { stdio: ['inherit', 'inherit', 'inherit'] });
    } catch {
      return null;
    }
  })();
  if (!run) {
    console.error(`setup-dev: ${cmd[0]} is not on PATH; run \`mise install\` from the repository`);
    process.exit(1);
  }
  if (run.exitCode !== 0) process.exit(run.exitCode);
}
