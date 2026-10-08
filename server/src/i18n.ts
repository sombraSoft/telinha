// Server-side strings (HTML pages + the slash command). en is the source of keys and the
// fallback; the Dict type forces pt-BR to define every key.
export type Locale = 'pt-BR' | 'en';
export const LOCALES: readonly Locale[] = ['pt-BR', 'en'];

// Same rule as web/src/lib/i18n: anything Portuguese -> pt-BR, else en.
export function resolveLocale(tag: string | null | undefined): Locale {
  return tag?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

// Highest-q entry that maps to a supported locale (pt* or en*); else en.
export function fromAcceptLanguage(header: string | null | undefined): Locale {
  let best: { tag: string; q: number } | null = null;
  for (const part of (header ?? '').split(',')) {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim().toLowerCase() ?? '';
    if (!tag.startsWith('pt') && !tag.startsWith('en')) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q) || q <= 0) continue;
    if (!best || q > best.q) best = { tag, q };
  }
  return best ? resolveLocale(best.tag) : 'en';
}

const en = {
  members: 'members',
  enter: 'Signing in…',
  denied: '{name}, Telinha is only for {group}.',
  otherAccount: 'Sign in with another account',
  expired: 'Login expired.',
  tryAgain: 'Try again',
  loggedOut: 'You left Telinha.',
  signInAgain: 'Sign in again',
  error: 'Something went wrong with the login.',
  cmdDescription: 'Open a Telinha room to share your screen',
  optWhatDescription: 'What are you streaming? e.g. Elden Ring',
  onlyGroup: 'Telinha is only for {group}.',
  wrongChannel: 'Use /{cmd} in {where}.',
  or: ' or ',
  opened: '📺 **{who}** opened a Telinha{what}',
  tip: '-# Only {group} can join (Discord login). To stream with game sound: Google Chrome → **Window** tab → pick the game and tick app audio (just the game, not Discord).',
  open: 'Open Telinha',
  openFailed: 'Could not open a Telinha right now. Try again in a moment.',
  cardStreaming: '🔴 Streaming: {list}',
  cardInRoom: '👀 In the room: {list}',
  cardOpenedAt: '⏱️ Opened {when}',
  cardClosed: '📺 Telinha by **{who}** ended{what}',
  cardLasted: '⏱️ Lasted {duration}',
  cardNobody: '⏱️ Nobody joined',
  cardSeen: '👥 Stopped by: {list}',
  durLessMin: 'less than 1 min',
  durMin: '{m} min',
  durHours: '{h}h {m}min',
  durHoursOnly: '{h}h',
} as const;

export type Key = keyof typeof en;
type Dict = { readonly [K in Key]: string };

const ptBR: Dict = {
  members: 'membros',
  enter: 'Entrando…',
  denied: '{name}, a Telinha é só pra {group}.',
  otherAccount: 'Entrar com outra conta',
  expired: 'Login expirou.',
  tryAgain: 'Tentar de novo',
  loggedOut: 'Saiu da Telinha.',
  signInAgain: 'Entrar de novo',
  error: 'Deu ruim no login.',
  cmdDescription: 'Abre uma telinha pra compartilhar a tela',
  optWhatDescription: 'O que vai passar? ex: Elden Ring',
  onlyGroup: 'A Telinha é só pra {group}.',
  wrongChannel: 'Usa o /{cmd} no {where}.',
  or: ' ou ',
  opened: '📺 **{who}** abriu uma telinha{what}',
  tip: '-# Só {group} entram (login com Discord). Pra transmitir com som do jogo: Google Chrome → aba **Janela** → escolhe o jogo e marca o áudio do app (só o jogo, sem o Discord).',
  open: 'Abrir telinha',
  openFailed: 'Não deu pra abrir a telinha agora. Tenta de novo daqui a pouco.',
  cardStreaming: '🔴 Transmitindo: {list}',
  cardInRoom: '👀 Na sala: {list}',
  cardOpenedAt: '⏱️ Aberta {when}',
  cardClosed: '📺 Telinha de **{who}** encerrada{what}',
  cardLasted: '⏱️ Durou {duration}',
  cardNobody: '⏱️ Ninguém entrou',
  cardSeen: '👥 Passaram por aqui: {list}',
  durLessMin: 'menos de 1 min',
  durMin: '{m} min',
  durHours: '{h}h {m}min',
  durHoursOnly: '{h}h',
};

export const dicts: Record<Locale, Dict> = { en, 'pt-BR': ptBR };

// Single pass, so a {placeholder} inside a param value is never expanded.
export function t(locale: Locale, key: Key, params: Record<string, string> = {}): string {
  const s = dicts[locale][key] ?? en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(params, k) ? (params[k] ?? m) : m));
}
