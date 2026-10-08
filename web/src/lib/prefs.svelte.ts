// Per-viewer preferences, persisted in localStorage (see store.ts).

import type { Locale } from './i18n';
import { parseQuality, parseShareSettings, type QualityChoice, type ShareSettings } from './share';
import { load, save } from './store';
import { parseThemeChoice, type ThemeChoice } from './theme';

export type LangChoice = 'auto' | Locale;
const parseLang = (v: unknown): LangChoice => (v === 'pt-BR' || v === 'en' ? v : 'auto');
const parsePeople = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

class Prefs {
  theme = $state<ThemeChoice>(parseThemeChoice(load('theme', 'system')));
  lang = $state<LangChoice>(parseLang(load('lang', 'auto')));
  stats = $state<boolean>(load<unknown>('stats', false) === true);
  share = $state.raw<ShareSettings>(parseShareSettings(load('share', null)));
  /** People list open or collapsed; null until the user picks, so each viewport keeps its default. */
  people = $state<boolean | null>(parsePeople(load('people', null)));
  /** The Offline section of the people list is open (collapsed by default). */
  offline = $state<boolean>(load<unknown>('offline', false) === true);
  /** The streamer sees their own share on its tile (shown by default). */
  preview = $state<boolean>(load<unknown>('preview', true) !== false);
  // Volume/mute per stream identity; read through to storage on first use.
  #volume = $state<Record<string, number>>({});
  #muted = $state<Record<string, boolean>>({});

  setTheme(v: ThemeChoice) {
    this.theme = v;
    save('theme', v);
  }
  setLang(v: LangChoice) {
    this.lang = v;
    save('lang', v);
  }
  setStats(v: boolean) {
    this.stats = v;
    save('stats', v);
  }
  setShare(v: ShareSettings) {
    this.share = v;
    save('share', v);
  }
  setPeople(v: boolean) {
    this.people = v;
    save('people', v);
  }
  setOffline(v: boolean) {
    this.offline = v;
    save('offline', v);
  }
  setPreview(v: boolean) {
    this.preview = v;
    save('preview', v);
  }

  /** Last quality picked on any tile; new tiles start with it. */
  quality(): QualityChoice {
    return parseQuality(load('quality', 'auto'));
  }
  setQuality(v: QualityChoice) {
    save('quality', v);
  }

  volume(identity: string): number {
    const v = this.#volume[identity] ?? Number(load(`vol.${identity}`, 100));
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 100;
  }
  setVolume(identity: string, v: number) {
    this.#volume[identity] = v;
    save(`vol.${identity}`, v);
  }
  /** byDefault: muted until the user unmutes it (a person's own stream, heard from another tab). */
  muted(identity: string, byDefault = false): boolean {
    return this.#muted[identity] ?? load<unknown>(`mute.${identity}`, byDefault) === true;
  }
  toggleMute(identity: string, byDefault = false) {
    const v = !this.muted(identity, byDefault);
    this.#muted[identity] = v;
    save(`mute.${identity}`, v);
  }
}

export const prefs = new Prefs();
