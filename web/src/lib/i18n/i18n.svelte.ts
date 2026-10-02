import { prefs } from '../prefs.svelte';
import { format, resolveLocale, type Locale, type MessageKey, type Params } from './index';

// Locale reported by /auth/token (from Discord); navigator.language until then.
let userLocale = $state<string | undefined>(undefined);

export function setUserLocale(locale: string | undefined): void {
  userLocale = locale;
}

export function currentLocale(): Locale {
  const choice = prefs.lang;
  if (choice !== 'auto') return choice;
  return resolveLocale(userLocale ?? (typeof navigator === 'undefined' ? undefined : navigator.language));
}

/** Reactive in templates and $derived: reads the locale state on every call. */
export function t(key: MessageKey, params?: Params): string {
  return format(currentLocale(), key, params);
}
