// What this program is: version, commit and target. The native build defines
// BUILD_* with `bun build --define`; `bun server/src/index.ts` (dev, Docker) has none.
import { readFileSync } from 'node:fs';

declare const BUILD_VERSION: string | undefined;
declare const BUILD_COMMIT: string | undefined;
declare const BUILD_TARGET: string | undefined;

export type Target = 'linux-x64' | 'linux-arm64' | 'windows-x64' | 'windows-arm64';
export const TARGETS: readonly Target[] = ['linux-x64', 'linux-arm64', 'windows-x64', 'windows-arm64'];

/** True in the `bun build --compile` binary. */
export const isCompiled = (): boolean => typeof BUILD_VERSION !== 'undefined';

/** BUILD_VERSION, else the root package.json (dev, Docker), else 'dev'. */
export function version(): string {
  if (typeof BUILD_VERSION !== 'undefined' && BUILD_VERSION) return BUILD_VERSION;
  try {
    return (
      (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string })
        .version ?? 'dev'
    );
  } catch {
    return 'dev';
  }
}

export function commit(): string | null {
  return typeof BUILD_COMMIT !== 'undefined' && BUILD_COMMIT ? BUILD_COMMIT : null;
}

/** The release asset this machine runs; throws on a host no binary is built for. */
export function hostTarget(platform: string = process.platform, arch: string = process.arch): Target {
  const os = platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'x64' || arch === 'arm64' ? arch : null;
  if (!os || !cpu) throw new Error(`no telinha build for ${platform}/${arch}`);
  return `${os}-${cpu}`;
}

/** "telinha 0.7.0 (abc1234, bun 1.4.2, windows-x64)"; dev builds have no commit. */
export function versionLine(): string {
  let target: string;
  try {
    target = typeof BUILD_TARGET !== 'undefined' && BUILD_TARGET ? BUILD_TARGET : hostTarget();
  } catch {
    target = `${process.platform}-${process.arch}`;
  }
  const parts = [commit(), `bun ${Bun.version}`, target].filter(Boolean);
  return `telinha ${version()} (${parts.join(', ')})`;
}
