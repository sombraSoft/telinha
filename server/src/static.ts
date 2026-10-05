// The room page (Vite build in WEB_DIR), read fully once at start. Requests are
// matched by exact key, so user input never reaches a filesystem path.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface StaticFile { body: Uint8Array; type: string; cache: string }
export type StaticFiles = Map<string, StaticFile>;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
};

export const contentType = (name: string) => TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';

// Vite puts hashed files under assets/, so those can be cached forever.
const cacheFor = (rel: string) => (rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');

/** rel path ("index.html", "assets/x.js") -> file; served at /sala/<rel>. */
export function staticFromEntries(entries: Iterable<[string, Uint8Array]>): StaticFiles {
  const out: StaticFiles = new Map();
  for (const [rel, body] of entries) {
    out.set(`/sala/${rel}`, { body, type: contentType(rel), cache: cacheFor(rel) });
  }
  const index = out.get('/sala/index.html');
  if (index) out.set('/sala/', index);
  return out;
}

export function loadStatic(dir: string): StaticFiles {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    names = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`WEB_DIR ${dir} unreadable (run bun run build first): ${(e as Error).message}`);
  }
  const entries: [string, Uint8Array][] = [];
  for (const name of names) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    entries.push([name.replaceAll('\\', '/'), readFileSync(full)]);
  }
  const files = staticFromEntries(entries);
  if (!files.has('/sala/')) throw new Error(`WEB_DIR ${dir} has no index.html`);
  return files;
}
