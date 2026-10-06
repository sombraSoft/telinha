// CLI strings (help, wizard, doctor, service, update) in EN and pt-BR. Same
// pattern as i18n.ts: en is the source of keys, the Dict type forces pt-BR to
// define every key, `{param}` is substituted. Kept apart from i18n.ts because
// only the CLI needs them; a command with many strings keeps its own dictionary
// next to its code with defineStrings().
import { resolveLocale, type Locale } from '../i18n.ts';

export type { Locale };
export type Params = Record<string, string | number>;

// Single pass, so a {placeholder} inside a param value is never expanded.
function fill(s: string, params: Params): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}

/** A scoped dictionary: `const t = defineStrings({ hi: 'Hi {name}' }, { hi: 'Oi {name}' }); t(locale, 'hi', { name })`. */
export function defineStrings<const E extends Record<string, string>>(en: E, ptBR: { readonly [K in keyof E]: string }) {
  const dicts: Record<Locale, { readonly [K in keyof E]: string }> = { en, 'pt-BR': ptBR };
  const t = (locale: Locale, key: keyof E & string, params: Params = {}): string => fill(dicts[locale][key] ?? en[key], params);
  return Object.assign(t, { en, ptBR });
}

const HELP_EN = `Telinha: screen sharing for your Discord group.

Usage: telinha [command] [flags]

Commands:
  run                      start the service (default)
  setup                    configure Telinha step by step
  doctor                   check the configuration, Discord, network and the service
  update                   install the newest version (--check: only look)
  service <action>         install | uninstall | start | stop | restart | status
  help [command]           this help, or a command's

Flags:
  --lang en|pt-BR          language (else LOCALE in telinha.env, else the system's)
  --home DIR               install directory (same as TELINHA_HOME)
  --yes                    accept the defaults without asking
  -v, --version            print the version
  -h, --help               print this help`;

const HELP_PT = `Telinha: compartilhamento de tela pro seu grupo do Discord.

Uso: telinha [comando] [opções]

Comandos:
  run                      inicia o serviço (padrão)
  setup                    configura a Telinha passo a passo
  doctor                   verifica a configuração, o Discord, a rede e o serviço
  update                   instala a versão mais nova (--check: só verifica)
  service <ação>           install | uninstall | start | stop | restart | status
  help [comando]           esta ajuda, ou a de um comando

Opções:
  --lang en|pt-BR          idioma (senão LOCALE no telinha.env, senão o do sistema)
  --home DIR               pasta da instalação (o mesmo que TELINHA_HOME)
  --yes                    aceita os padrões sem perguntar
  -v, --version            mostra a versão
  -h, --help               mostra esta ajuda`;

const en = {
  help: HELP_EN,
  usage: 'Usage: telinha [command] [flags]. Run telinha help for the list of commands.',
  helpRun: 'Usage: telinha run\n\nStarts the service in this console: reads telinha.env, starts LiveKit (and Caddy or cloudflared) and serves the rooms. Ctrl+C stops it.',
  helpSetup: 'Usage: telinha setup [--non-interactive] [flags]\n\nAsks the questions that make up telinha.env, downloads what Telinha needs, installs the service and runs doctor. Secrets come from the environment (DISCORD_TOKEN, ...) or from --<name>-file <path|->, never from flags.',
  helpDoctor: 'Usage: telinha doctor [--json] [--no-phone] [--local]\n\nChecks the configuration, Discord, DNS, TLS, the router and the service. --local skips internet checks, --no-phone skips the phone test.',
  helpUpdate: 'Usage: telinha update [--check | --now]\n\n--check only shows what would be installed; --now installs even with rooms open.',
  helpService: 'Usage: telinha service install [--firewall] [--user] | uninstall | start | stop | restart | status',
  unknownCommand: 'unknown command {cmd}',
  noConfig: 'No configuration yet ({path}).',
  offerSetup: 'Set Telinha up now?',
  alreadyRunning: 'Telinha is already running (pid {pid}). Use: telinha service status | telinha service stop',
  pressEnter: 'Press Enter to close.',
  // args.ts
  argUnknownFlag: 'unknown flag {flag}',
  argNeedsValue: '{flag} needs a value',
  argNoValue: '{flag} takes no value',
  argBadBoolean: '{flag} must be true or false, got {value}',
  argSecretFlag: '{flag} is not accepted: secrets never go on the command line (others can read it in the process list and shell history). Set {env} in the environment or use {flag}-file <path|-> (- reads stdin).',
  argOneStdin: 'only one secret can be read from stdin (-) per run',
  argBadLang: '--lang must be en or pt-BR, got {value}',
  // term.ts
  needsInput: 'no answer for "{q}" (non-interactive)',
  yesNoDefYes: '(Y/n)',
  yesNoDefNo: '(y/N)',
  yesNo: '(y/n)',
  answerYesNo: 'Answer y or n.',
  required: 'An answer is required.',
  pickAtLeast: 'Pick at least {n}.',
  selectHint: '↑/↓ move, Enter picks',
  multiHint: '↑/↓ move, Space toggles, a = all, Enter confirms',
  moreAbove: '↑ {n} more',
  moreBelow: '↓ {n} more',
  keepCurrent: '(keep current)',
} as const;

export type Key = keyof typeof en;
type Dict = { readonly [K in Key]: string };

const ptBR: Dict = {
  help: HELP_PT,
  usage: 'Uso: telinha [comando] [opções]. Rode telinha help pra ver os comandos.',
  helpRun: 'Uso: telinha run\n\nInicia o serviço neste console: lê o telinha.env, sobe o LiveKit (e o Caddy ou o cloudflared) e serve as salas. Ctrl+C para.',
  helpSetup: 'Uso: telinha setup [--non-interactive] [opções]\n\nFaz as perguntas que montam o telinha.env, baixa o que a Telinha precisa, instala o serviço e roda o doctor. Segredos vêm do ambiente (DISCORD_TOKEN, ...) ou de --<nome>-file <caminho|->, nunca de opções.',
  helpDoctor: 'Uso: telinha doctor [--json] [--no-phone] [--local]\n\nVerifica a configuração, o Discord, o DNS, o TLS, o roteador e o serviço. --local pula as verificações pela internet, --no-phone pula o teste no celular.',
  helpUpdate: 'Uso: telinha update [--check | --now]\n\n--check só mostra o que seria instalado; --now instala mesmo com salas abertas.',
  helpService: 'Uso: telinha service install [--firewall] [--user] | uninstall | start | stop | restart | status',
  unknownCommand: 'comando desconhecido {cmd}',
  noConfig: 'Ainda não tem configuração ({path}).',
  offerSetup: 'Configurar a Telinha agora?',
  alreadyRunning: 'A Telinha já está rodando (pid {pid}). Use: telinha service status | telinha service stop',
  pressEnter: 'Aperte Enter pra fechar.',
  argUnknownFlag: 'opção desconhecida {flag}',
  argNeedsValue: '{flag} precisa de um valor',
  argNoValue: '{flag} não recebe valor',
  argBadBoolean: '{flag} precisa ser true ou false, veio {value}',
  argSecretFlag: '{flag} não é aceito: segredo nunca vai na linha de comando (dá pra ver na lista de processos e no histórico do shell). Defina {env} no ambiente ou use {flag}-file <caminho|-> (- lê do stdin).',
  argOneStdin: 'só um segredo pode ser lido do stdin (-) por execução',
  argBadLang: '--lang precisa ser en ou pt-BR, veio {value}',
  needsInput: 'sem resposta pra "{q}" (modo não interativo)',
  yesNoDefYes: '(S/n)',
  yesNoDefNo: '(s/N)',
  yesNo: '(s/n)',
  answerYesNo: 'Responda s ou n.',
  required: 'Precisa de uma resposta.',
  pickAtLeast: 'Escolha pelo menos {n}.',
  selectHint: '↑/↓ move, Enter escolhe',
  multiHint: '↑/↓ move, Espaço marca, a = todos, Enter confirma',
  moreAbove: '↑ mais {n}',
  moreBelow: '↓ mais {n}',
  keepCurrent: '(manter o atual)',
};

export const dicts: Record<Locale, Dict> = { en, 'pt-BR': ptBR };

export function ts(locale: Locale, key: Key, params: Params = {}): string {
  return fill(dicts[locale][key] ?? en[key], params);
}

/** Any tag (pt, pt_BR.UTF-8, en-US) -> a supported locale; anything Portuguese is pt-BR. */
export function localeFromTag(tag: string | null | undefined): Locale {
  return resolveLocale(tag?.replace(/_/g, '-'));
}

/**
 * --lang, else LOCALE, else the POSIX locale variables (the first set of
 * LC_ALL, LC_MESSAGES, LANG; C/POSIX count as unset), else the OS display
 * language as Intl sees it (how Windows reports it), else en.
 */
export function pickLocale(
  env: Record<string, string | undefined>,
  override?: string | null,
  intlLocale: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().locale,
): Locale {
  if (override) return localeFromTag(override);
  if (env.LOCALE) return localeFromTag(env.LOCALE);
  const posix = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (posix && !/^(C|POSIX)([._@]|$)/i.test(posix)) return localeFromTag(posix);
  try {
    return localeFromTag(intlLocale());
  } catch {
    return 'en';
  }
}
