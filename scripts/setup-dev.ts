// Runs after `mise install` (mise.toml [hooks] postinstall) so one command sets up
// a fresh clone: mise installs the toolchain, this installs the dependencies.
// CI installs its own with --frozen-lockfile, so it is a no-op there.
//
//   bun scripts/setup-dev.ts
if (process.env.CI) process.exit(0);

const { exitCode } = Bun.spawnSync([process.execPath, 'install'], { stdio: ['inherit', 'inherit', 'inherit'] });
process.exit(exitCode);
