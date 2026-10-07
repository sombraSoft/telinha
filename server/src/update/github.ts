// GitHub releases without the API: `releases/latest` answers with a redirect to
// the newest published non-prerelease tag (no rate limit, no token), and the
// assets live under `releases/download/<release tag>/`.
import { isStableTag, latestReleaseTag, parseSums, REPO, releaseAssetUrl, SUMS } from '../release.ts';
import { errorMessage, type GitHubReleases, PendingError } from './types.ts';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function createGitHubReleases(o: { fetch?: FetchFn; repo?: string; timeoutMs?: number } = {}): GitHubReleases {
  const fetchFn: FetchFn = o.fetch ?? fetch;
  const repo = o.repo ?? REPO;
  const timeoutMs = o.timeoutMs ?? 30_000;
  const get = (url: string, init: RequestInit = {}) =>
    fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const assetUrl = (tag: string, asset: string) => releaseAssetUrl(tag, asset, repo);
  return {
    latestTag: () => latestReleaseTag(fetchFn, repo, timeoutMs),
    assetUrl,
    async sums(tag) {
      let res: Response;
      try {
        res = await get(assetUrl(tag, SUMS));
      } catch (e) {
        throw new PendingError(`${SUMS} of ${tag}: ${errorMessage(e)}`);
      }
      if (!res.ok) throw new PendingError(`${SUMS} of ${tag}: HTTP ${res.status}`);
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
