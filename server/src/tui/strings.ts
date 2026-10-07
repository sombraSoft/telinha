// Strings shared by the TUI screens (header, key help, widgets, doctor screen)
// in EN and pt-BR. The locale lives in a context signal so a language switch
// re-renders every string read through useT().
import { createContext, useContext, type Accessor } from 'solid-js';
import { defineStrings, type Locale, type Params } from '../cli/strings.ts';

export const tuiStrings = defineStrings({
  'app.name': 'telinha',
  'app.setup': 'setup',
  'app.doctor': 'doctor',
  'app.tagline': 'Screen sharing for your Discord group',

  'keys.move': 'move',
  'keys.select': 'select',
  'keys.back': 'back',
  'keys.steps': 'steps',
  'keys.quit': 'quit',
  'keys.toggle': 'toggle',
  'keys.all': 'all',
  'keys.confirm': 'confirm',
  'keys.paste': 'paste',
  'keys.reveal': 'show/hide',
  'keys.clear': 'clear',
  'keys.details': 'details',
  'keys.rerun': 'run again',
  'keys.phone': 'phone test',
  'keys.skip': 'skip',
  'keys.question': 'question',
  'keys.jump': 'jump',
  'keys.scroll': 'scroll',
  'keys.retry': 'retry',

  'common.chosen': 'current answer',
  'common.default': 'default',
  'common.characters': '{n} characters',
  'common.pasted': 'pasted',
  'common.empty': 'Type or paste a value',
  'common.keepCurrent': 'Enter keeps the current one',
  'common.required': "This can't be empty.",
  'common.hint': 'About this',
  'common.sidebarFocus': 'Pick a step to jump to',
  'common.locked': 'Answer the earlier steps first',
  'common.noBack': 'Installing: going back is disabled until this finishes.',
  'common.noBackFailed': 'To change answers, pick Back to questions.',
  'common.noBackDone': 'The install has run: going back is disabled.',
  'common.quitAgain': 'Press Ctrl+C again to stop: the install may be left half done.',
  'common.moreAbove': '↑ {n} more',
  'common.moreBelow': '↓ {n} more',
  'common.selected': '{n} selected',
  'common.selected1': '1 selected',
  'common.pickOne': 'Pick at least one.',

  'doctor.title': 'Doctor',
  'doctor.intro': 'Health checks for this install. Enter shows how to fix a row.',
  'doctor.running': 'Running checks…',
  'doctor.ok': '{n} ok',
  'doctor.warn1': '1 warning',
  'doctor.warnN': '{n} warnings',
  'doctor.fail': '{n} failed',
  'doctor.skip1': '1 skipped',
  'doctor.skip': '{n} skipped',
  'doctor.fix': 'Fix',
  'doctor.nothing': 'Nothing to do.',
  'doctor.phoneStarting': 'Starting the phone test…',
  'doctor.phoneLeft': 'Waiting for the phone ({time})',
  'doctor.phoneAgain': 'Press p to start a new phone test.',
  'doctor.qrTooBig': 'Make the window larger to see the QR code, or type the link on the phone.',
}, {
  'app.name': 'telinha',
  'app.setup': 'configuração',
  'app.doctor': 'diagnóstico',
  'app.tagline': 'Compartilhamento de tela pro seu grupo do Discord',

  'keys.move': 'mover',
  'keys.select': 'escolher',
  'keys.back': 'voltar',
  'keys.steps': 'passos',
  'keys.quit': 'sair',
  'keys.toggle': 'marcar',
  'keys.all': 'todos',
  'keys.confirm': 'confirmar',
  'keys.paste': 'colar',
  'keys.reveal': 'mostrar/ocultar',
  'keys.clear': 'limpar',
  'keys.details': 'detalhes',
  'keys.rerun': 'rodar de novo',
  'keys.phone': 'teste no celular',
  'keys.skip': 'pular',
  'keys.question': 'pergunta',
  'keys.jump': 'ir',
  'keys.scroll': 'rolar',
  'keys.retry': 'tentar de novo',

  'common.chosen': 'resposta atual',
  'common.default': 'padrão',
  'common.characters': '{n} caracteres',
  'common.pasted': 'colado',
  'common.empty': 'Digite ou cole um valor',
  'common.keepCurrent': 'Enter mantém o atual',
  'common.required': 'Isto não pode ficar vazio.',
  'common.hint': 'Sobre isto',
  'common.sidebarFocus': 'Escolha um passo pra ir até ele',
  'common.locked': 'Responda os passos anteriores primeiro',
  'common.noBack': 'Instalando: não dá pra voltar até terminar.',
  'common.noBackFailed': 'Pra mudar respostas, escolha Voltar pras perguntas.',
  'common.noBackDone': 'A instalação já rodou: não dá pra voltar.',
  'common.quitAgain': 'Aperte Ctrl+C de novo pra parar: a instalação pode ficar pela metade.',
  'common.moreAbove': '↑ mais {n}',
  'common.moreBelow': '↓ mais {n}',
  'common.selected': '{n} marcados',
  'common.selected1': '1 marcado',
  'common.pickOne': 'Escolha pelo menos um.',

  'doctor.title': 'Diagnóstico',
  'doctor.intro': 'Verificações desta instalação. Enter mostra como corrigir uma linha.',
  'doctor.running': 'Rodando verificações…',
  'doctor.ok': '{n} ok',
  'doctor.warn1': '1 aviso',
  'doctor.warnN': '{n} avisos',
  'doctor.fail': '{n} com falha',
  'doctor.skip1': '1 pulado',
  'doctor.skip': '{n} pulados',
  'doctor.fix': 'Como corrigir',
  'doctor.nothing': 'Nada a fazer.',
  'doctor.phoneStarting': 'Começando o teste no celular…',
  'doctor.phoneLeft': 'Esperando o celular ({time})',
  'doctor.phoneAgain': 'Aperte p pra começar outro teste no celular.',
  'doctor.qrTooBig': 'Aumente a janela pra ver o QR code, ou digite o link no celular.',
});

export type TuiKey = Parameters<typeof tuiStrings>[1];
export type Translate = (key: TuiKey, params?: Params) => string;

const ENGLISH: Accessor<Locale> = () => 'en';
export const LocaleCtx = createContext<Accessor<Locale>>(ENGLISH);

/** `t(key, params)` for the current locale; reading it inside JSX tracks the locale. */
export function useT(): Translate {
  const locale = useContext(LocaleCtx);
  return (key, params) => tuiStrings(locale(), key, params);
}

export function useLocale(): Accessor<Locale> {
  return useContext(LocaleCtx);
}
