// Same format as 0.1.1: localStorage "telinha.<key>" holding JSON. Storage can
// be blocked (private mode, sandboxed iframes), so every access is guarded.
const PREFIX = 'telinha.';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {}
}
