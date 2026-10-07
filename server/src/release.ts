// What a Telinha release holds and where it lives, for the packer
// (scripts/build-binary.ts) and every fetcher (the updater, bins.ts) alike:
// asset names per target, the files inside each archive, the bin folder names
// the updater and install.ps1 share, and the SHA256SUMS lines. install.sh and
// install.ps1 cannot import this; test/release.test.ts pins what they hard-code.
//
// Releases are read without the API: `releases/latest` answers with a redirect
// to a release tag (no rate limit, no token) and assets live under
// `releases/download/<release tag>/`. No imports: the Docker bins stage copies
// this file next to bins.ts and nothing else of server/.

export const REPO = 'sombraSoft/telinha';
const TAG_RE = /\/releases\/tag\/([^/?#]+)/;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** A release tag with `-` is a prerelease (v0.8.0-rc.1): never installed unless pinned. */
export const isStableTag = (tag: string): boolean => !tag.includes('-');

export const releaseAssetUrl = (tag: string, name: string, repo = REPO): string =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;

/** The release tag a `releases/latest` redirect points at, or null when the response is not one. */
export function tagFromRedirect(res: { status: number; headers: Headers }): string | null {
  if (res.status < 300 || res.status > 399) return null;
  const location = res.headers.get('location') ?? '';
  const m = TAG_RE.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * The release tag `releases/latest` redirects to: GitHub points it at the
 * newest published non-prerelease. Null when offline or when there is no release.
 */
export async function latestReleaseTag(fetchFn: FetchFn, repo = REPO, timeoutMs = 30_000): Promise<string | null> {
  try {
    // Manual redirects: the Location header is the answer; following it would download a page.
    const res = await fetchFn(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return tagFromRedirect(res);
  } catch {
    return null;
  }
}

// version.ts' Target, spelled out here so this file stays import-free.
type Target = `${'linux' | 'windows'}-${'x64' | 'arm64'}`;
/** Names that depend on the OS only take whatever the caller has: a target, an OS or a Node platform. */
type OsOf = Target | 'linux' | 'windows' | NodeJS.Platform;
const onWindows = (os: OsOf) => os.startsWith('win');
const exe = (os: OsOf) => (onWindows(os) ? '.exe' : '');

/** Linux gets tar.gz (minimal Debian/Alpine have tar but no unzip), Windows zip. */
export const archiveType = (t: Target): 'tar.gz' | 'zip' => (onWindows(t) ? 'zip' : 'tar.gz');
/** Telinha's archive for a target. */
export const assetName = (t: Target): string => `telinha-${t}.${archiveType(t)}`;
/** Our Caddy build for a target, named like Telinha's own archive (x64, not amd64). */
export const caddyAssetName = (t: Target): string => `caddy-${t}.${archiveType(t)}`;

/** The program's file name, in an archive and in an install's bin folder alike. */
export const exeName = (os: OsOf): string => `telinha${exe(os)}`;
/** The one file in a caddy archive. */
export const caddyExeName = (os: OsOf): string => `caddy${exe(os)}`;
export const TRAY_EXE = 'telinha-tray.exe';

/** What Telinha's archive for a target holds: the program, the tray (Windows only; optional, older releases lack it), LICENSE. */
export const archiveContents = (t: Target): { exe: string; tray: string | null; license: string } =>
  ({ exe: exeName(t), tray: onWindows(t) ? TRAY_EXE : null, license: 'LICENSE' });

/** A downloaded program waiting in bin for the swap. */
export const newExeName = (os: OsOf): string => `telinha.new${exe(os)}`;
export const TRAY_NEW = 'telinha-tray.new.exe';
/** The release's tray kept uninstalled: never run, kept current by the updater and install.ps1. */
export const TRAY_DIST = 'telinha-tray.dist.exe';

/**
 * Where a replaced file goes aside, before its suffix: `<stem>.old-<version>`
 * or `<stem>.failed-<release tag>`. Renamed, never deleted (Windows refuses to
 * delete a running exe); the updater sweeps whatever ASIDE_RE matches.
 */
export const asideBase = (stem: 'telinha' | 'telinha-tray', kind: 'old' | 'failed', label: string): string => `${stem}.${kind}-${label}`;
export const ASIDE_RE = /^telinha(-tray)?\.(old|failed)-/;

export const SUMS = 'SHA256SUMS';

/** sha256sum format, `<hex>  <file>` sorted by name, so `sha256sum -c` checks a download by hand. */
export function formatSums(sums: Record<string, string>): string {
  return Object.keys(sums).sort().map((name) => `${sums[name]}  ${name}\n`).join('');
}

/** `<sha256 hex>  <file>` lines (a `*` binary marker is accepted) -> file -> hex; any other line is skipped. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(raw.trim());
    if (m) out[m[2]!.trim()] = m[1]!.toLowerCase();
  }
  return out;
}
