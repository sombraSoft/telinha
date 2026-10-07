// telinha.env reader. Deliberately dumb: no interpolation, no unescaping, no inline
// comments. Single-quoted values are the one spelling Docker's env_file reads the same.
import { readFileSync } from 'node:fs';

export interface ParsedEnv {
  vars: Record<string, string>;
  warnings: string[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnvFile(text: string): ParsedEnv {
  const vars: Record<string, string> = {};
  const warnings: string[] = [];
  // Notepad may save a BOM, which would make the first key invalid.
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    // Never echo the line itself: it may be a pasted secret.
    if (eq < 0) {
      warnings.push(`envfile: line ${i + 1} has no "=", skipped`);
      continue;
    }
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      warnings.push(`envfile: line ${i + 1}: bad key "${key}", skipped`);
      continue;
    }
    let value = body.slice(eq + 1).trim();
    const q = value[0];
    const quoted = (q === '"' || q === "'") && value.length >= 2 && value.endsWith(q);
    if (quoted) value = value.slice(1, -1);
    // compose interpolates $, unescapes \ and strips " #..." outside single quotes.
    if (!(quoted && q === "'") && /[$\\#]/.test(value)) {
      warnings.push(`envfile: ${key} contains $, \\ or #; single-quote it so Docker and native read the same value`);
    }
    vars[key] = value;
  }
  return { vars, warnings };
}

/** null when the file does not exist; any other read error throws so a broken host fails loudly. */
export function loadEnvFile(path: string): ParsedEnv | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return parseEnvFile(text);
}

/** Real environment wins over the file, except variables set to '' (same rule as loadConfig). */
export function mergeEnv(
  file: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out = { ...file };
  for (const [k, v] of Object.entries(processEnv)) if (v) out[k] = v;
  return out;
}
