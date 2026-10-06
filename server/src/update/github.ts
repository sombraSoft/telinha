// GitHub releases without the API: `releases/latest` answers with a redirect to
// the newest published non-prerelease tag (no rate limit, no token), and the
// assets live under `releases/download/<tag>/`.
import type { Target } from '../version.ts';
import { PendingError, errorMessage, type GitHubReleases } from './types.ts';

export const REPO = 'sombraSoft/telinha';
const TAG_RE = /\/releases\/tag\/([^/?#]+)/;

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** A tag with `-` is a prerelease (v0.8.0-rc.1): never installed unless pinned. */
export const isStableTag = (tag: string): boolean => !tag.includes('-');

/** The release asset for a target: Linux ships tar.gz (tar is universal there), Windows zip. */
export const assetName = (target: Target): string => (target.startsWith('windows') ? `telinha-${target}.zip` : `telinha-${target}.tar.gz`);

/** `<sha256 hex>  <file>` lines (sha256sum format; a `*` binary marker is accepted) -> file -> hex. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(raw.trim());
    if (m) out[m[2]!.trim()] = m[1]!.toLowerCase();
  }
  return out;
}

/** The tag a `releases/latest` redirect points at, or null when the response is not one. */
export function tagFromRedirect(res: { status: number; headers: Headers }): string | null {
  if (res.status < 300 || res.status > 399) return null;
  const location = res.headers.get('location') ?? '';
  const m = TAG_RE.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function createGitHubReleases(o: { fetch?: FetchFn; repo?: string; timeoutMs?: number } = {}): GitHubReleases {
  const fetchFn: FetchFn = o.fetch ?? fetch;
  const base = `https://github.com/${o.repo ?? REPO}`;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const get = (url: string, init: RequestInit = {}) => fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const assetUrl = (tag: string, asset: string) => `${base}/releases/download/${encodeURIComponent(tag)}/${asset}`;
  return {
    async latestTag() {
      try {
        // Manual redirects: the Location header is the answer; following it would download a page.
        return tagFromRedirect(await get(`${base}/releases/latest`, { redirect: 'manual' }));
      } catch {
        return null; // offline: nothing to report
      }
    },
    assetUrl,
    async sums(tag) {
      let res: Response;
      try {
        res = await get(assetUrl(tag, 'SHA256SUMS'));
      } catch (e) {
        throw new PendingError(`SHA256SUMS of ${tag}: ${errorMessage(e)}`);
      }
      if (!res.ok) throw new PendingError(`SHA256SUMS of ${tag}: HTTP ${res.status}`);
      return parseSums(await res.text());
    },
    async asset(tag, name) {
      try {
        return await get(assetUrl(tag, name));
      } catch (e) {
        throw new PendingError(`${name} of ${tag}: ${errorMessage(e)}`);
      }
    },
  };
}

/** Newest stable tag, or null when unknown, offline or only a prerelease is latest. For doctor's update check. */
export async function latestStable(fetchFn?: FetchFn): Promise<string | null> {
  const tag = await createGitHubReleases({ fetch: fetchFn }).latestTag();
  return tag && isStableTag(tag) ? tag : null;
}
