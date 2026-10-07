// Small self-contained HTML pages for the auth flow (no external assets).
// Colors are the web app's Dark theme tokens, with a Light variant.
import { type Locale, t } from './i18n.ts';

// JSON for an inline <script>: escape "<" so "</script>" can't end it early
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `:root{color-scheme:dark;--bg-0:#121214;--bg-2:#202024;--text:#efeff1;--text-muted:#96979e;--accent:#5865f2;--border:rgba(151,151,159,.16)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg-0:#f3f3f4;--bg-2:#fff;--text:#2e2e34;--text-muted:#6c6d76;--border:rgba(151,151,159,.24)}}
*{box-sizing:border-box}body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg-0);color:var(--text);display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;text-align:center;background:var(--bg-2);border:1px solid var(--border);border-radius:16px;padding:24px}
h1{font-size:1.4rem;margin:0 0 8px}p{margin:8px 0;color:var(--text-muted)}a{color:var(--accent)}`;

export function page(locale: Locale, body: string): string {
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Telinha</title>
<style>${CSS}</style><main>${body}</main></html>`;
}

export const denied = (l: Locale, name: string, group: string) =>
  page(
    l,
    `<h1>📺 Telinha</h1>
<p>${esc(t(l, 'denied', { name, group }))}</p><p><a href="/auth/logout">${esc(t(l, 'otherAccount'))}</a></p>`,
  );

export const welcome = (l: Locale, next: string) =>
  page(l, `<p>${esc(t(l, 'enter'))}</p><script>location.replace(${js(next)});</script>`);

export const expired = (l: Locale) =>
  page(l, `<p>${esc(t(l, 'expired'))} <a href="/">${esc(t(l, 'tryAgain'))}</a></p>`);

export const loggedOut = (l: Locale) =>
  page(l, `<p>${esc(t(l, 'loggedOut'))} <a href="/">${esc(t(l, 'signInAgain'))}</a></p>`);

export const failed = (l: Locale) => page(l, `<p>${esc(t(l, 'error'))} <a href="/">${esc(t(l, 'tryAgain'))}</a></p>`);
