import { describe, expect, test } from 'bun:test';
import { createGitHubReleases, latestStable } from '../src/update/github.ts';
import { PendingError } from '../src/update/types.ts';

type Call = { url: string; redirect: RequestInit['redirect'] };
function fakeFetch(respond: (url: string) => Response | Error) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, redirect: init?.redirect });
    const r = respond(url);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe('createGitHubReleases', () => {
  test('latestTag follows nothing: manual redirect, Location is the answer', async () => {
    const f = fakeFetch(() => redirect('https://github.com/sombraSoft/telinha/releases/tag/v0.8.0'));
    const gh = createGitHubReleases({ fetch: f.fetch });
    expect(await gh.latestTag()).toBe('v0.8.0');
    expect(f.calls).toEqual([{ url: 'https://github.com/sombraSoft/telinha/releases/latest', redirect: 'manual' }]);
  });

  test('latestTag: no release (404) or offline -> null', async () => {
    expect(await createGitHubReleases({ fetch: fakeFetch(() => new Response('', { status: 404 })).fetch }).latestTag()).toBeNull();
    expect(await createGitHubReleases({ fetch: fakeFetch(() => new Error('ENOTFOUND')).fetch }).latestTag()).toBeNull();
  });

  test('assetUrl under releases/download/<tag>/', () => {
    const gh = createGitHubReleases({ fetch: fakeFetch(() => new Response('')).fetch });
    expect(gh.assetUrl('v0.8.0', 'telinha-linux-x64.tar.gz')).toBe('https://github.com/sombraSoft/telinha/releases/download/v0.8.0/telinha-linux-x64.tar.gz');
    expect(gh.assetUrl('v0.8.0-rc.1', 'SHA256SUMS')).toBe('https://github.com/sombraSoft/telinha/releases/download/v0.8.0-rc.1/SHA256SUMS');
    expect(createGitHubReleases({ repo: 'me/fork' }).assetUrl('v1.0.0', 'x')).toBe('https://github.com/me/fork/releases/download/v1.0.0/x');
  });

  test('sums: parsed when present; 404 and network errors are PendingError', async () => {
    const line = `${'a'.repeat(64)}  telinha-linux-x64.tar.gz\n`;
    const ok = createGitHubReleases({ fetch: fakeFetch(() => new Response(line)).fetch });
    expect(await ok.sums('v0.8.0')).toEqual({ 'telinha-linux-x64.tar.gz': 'a'.repeat(64) });
    const missing = createGitHubReleases({ fetch: fakeFetch(() => new Response('Not Found', { status: 404 })).fetch });
    await expect(missing.sums('v0.8.0')).rejects.toBeInstanceOf(PendingError);
    await expect(missing.sums('v0.8.0')).rejects.toThrow('HTTP 404');
    const offline = createGitHubReleases({ fetch: fakeFetch(() => new Error('connect ECONNREFUSED')).fetch });
    await expect(offline.sums('v0.8.0')).rejects.toBeInstanceOf(PendingError);
  });

  test('asset: the response as is (status for the caller); network error -> PendingError', async () => {
    const f = fakeFetch((url) => (url.endsWith('.zip') ? new Response('zipbytes') : new Response('', { status: 404 })));
    const gh = createGitHubReleases({ fetch: f.fetch });
    const res = await gh.asset('v0.8.0', 'telinha-windows-x64.zip');
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('zipbytes');
    expect((await gh.asset('v0.8.0', 'telinha-linux-x64.tar.gz')).status).toBe(404);
    await expect(createGitHubReleases({ fetch: fakeFetch(() => new Error('reset')).fetch }).asset('v1', 'a')).rejects.toBeInstanceOf(PendingError);
  });

  test('latestStable hides prereleases', async () => {
    expect(await latestStable(fakeFetch(() => redirect('/r/releases/tag/v0.8.0')).fetch)).toBe('v0.8.0');
    expect(await latestStable(fakeFetch(() => redirect('/r/releases/tag/v0.9.0-rc.1')).fetch)).toBeNull();
    expect(await latestStable(fakeFetch(() => new Error('offline')).fetch)).toBeNull();
  });
});
