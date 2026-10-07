// Pure i18n core (no runes), shared by the reactive t() and the unit tests.
import { en, type MessageKey, type Messages } from './en';
import { ptBR } from './pt-BR';

export type { MessageKey, Messages };
export type Locale = 'pt-BR' | 'en';
export type Params = Record<string, string | number>;

export const LOCALES: readonly Locale[] = ['pt-BR', 'en'];
export const dictionaries: Record<Locale, Messages> = { en, 'pt-BR': ptBR };

// The slash command's configured name, from the meta telinha adds to index.html
// (COMMAND_NAME). Vite dev and non-DOM test runs have none: the default.
export const commandName =
  (typeof document === 'undefined'
    ? null
    : document.querySelector('meta[name="telinha-command"]')?.getAttribute('content')) || 'telinha';

/** Same rule as Telinha: any Portuguese tag -> pt-BR, everything else -> en. */
export function resolveLocale(tag: string | null | undefined): Locale {
  return tag && tag.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

export function format(locale: Locale, key: MessageKey, params?: Params): string {
  const text = dictionaries[locale][key] || en[key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}
