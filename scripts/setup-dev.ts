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
  const { exitCode } = Bun.spawnSync(cmd, { stdio: ['inherit', 'inherit', 'inherit'] });
  if (exitCode !== 0) process.exit(exitCode);
}
