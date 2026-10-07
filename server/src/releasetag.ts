// Telinha's GitHub releases, read without the API: `releases/latest` answers
// with a redirect to a tag (no rate limit, no token) and assets live under
// `releases/download/<tag>/`. No imports: the Docker bins stage copies this file
// next to bins.ts and nothing else of server/.

export const REPO = 'sombraSoft/telinha';
const TAG_RE = /\/releases\/tag\/([^/?#]+)/;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** A tag with `-` is a prerelease (v0.8.0-rc.1): never installed unless pinned. */
export const isStableTag = (tag: string): boolean => !tag.includes('-');

export const releaseAssetUrl = (tag: string, name: string, repo = REPO): string =>
  `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;

/** The tag a `releases/latest` redirect points at, or null when the response is not one. */
export function tagFromRedirect(res: { status: number; headers: Headers }): string | null {
  if (res.status < 300 || res.status > 399) return null;
  const location = res.headers.get('location') ?? '';
  const m = TAG_RE.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** `<sha256 hex>  <file>` lines (sha256sum format; a `*` binary marker is accepted) -> file -> hex. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(raw.trim());
    if (m) out[m[2]!.trim()] = m[1]!.toLowerCase();
  }
  return out;
}

/**
 * The tag `releases/latest` redirects to: GitHub points it at the newest
 * published non-prerelease. Null when offline or when there is no release.
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

/** Our Caddy build in a release, named like telinha's own assets (x64, not amd64). */
export function caddyAssetName(os: 'linux' | 'windows', arch: 'amd64' | 'arm64'): string {
  const cpu = arch === 'amd64' ? 'x64' : 'arm64';
  return os === 'windows' ? `caddy-windows-${cpu}.zip` : `caddy-linux-${cpu}.tar.gz`;
}
