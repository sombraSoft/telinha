// The setup screens' own texts (EN + pt-BR): the welcome card, the Review,
// the install list and its last card. Question texts come from the setup state
// (qstrings.ts), shared chrome from tui/strings.ts.
import { useContext } from 'solid-js';
import { defineStrings, type Params } from '../../cli/strings.ts';
import { LocaleCtx } from '../strings.ts';

export const setupStrings = defineStrings(
  {
    'keys.pick': 'pick',

    'welcome.title': 'Welcome',
    'welcome.about':
      'Telinha is screen sharing for a Discord group. A few questions make its telinha.env; nothing changes on this machine before the Review.',
    'welcome.go': 'Set it up',
    'welcome.goDesc': 'Answer the questions, check the Review, then install',
    'welcome.quit': 'Quit',
    'welcome.quitDesc': 'Nothing is written',

    'review.title': 'Review',
    'review.intro': 'Check your answers. Nothing has changed on this machine yet.',
    'review.file': 'They go to {file}.',
    'review.apply': 'Apply',
    'review.applyDesc': 'Write telinha.env, install and start Telinha',
    'review.applyDescDocker': 'Write telinha.env; the machine starts the container',
    'review.rotate': 'Apply with a new cookie secret',
    'review.rotateDesc': 'Logs everyone out of the pages',
    'review.back': 'Back to the questions',
    'review.backDesc': 'Change something first',
    'review.quit': 'Quit without writing',
    'review.quitDesc': 'Nothing changes on this machine',
    'review.introAgain':
      'telinha.env was already written by the last attempt; Apply writes it again with these answers.',
    'review.leave': 'Leave setup',
    'review.leaveDesc': 'Keeps what the last attempt left on this machine',

    'apply.title': 'Installing Telinha',
    'apply.titleDocker': 'Writing the configuration',
    'apply.running': 'Working…',
    'apply.skipped': 'skipped',
    'apply.retry': 'Retry',
    'apply.retryDesc': 'Run this step again',
    'apply.skip': 'Skip',
    'apply.skipDesc': 'Leave it and go on with the rest',
    'apply.back': 'Back to questions',
    'apply.backDesc': 'Change answers, then apply again',
    'apply.done': 'Telinha is running',
    'apply.setUp': 'Telinha is set up',
    'apply.doctor': 'Show the doctor report',
    'apply.doctorDesc': 'See what works and what needs attention',
    'apply.exit': 'Exit',
    'apply.exitDesc': 'Telinha keeps running as a service',
    'apply.exitDescIdle': 'Close the setup',
  },
  {
    'keys.pick': 'atalho',

    'welcome.title': 'Boas-vindas',
    'welcome.about':
      'A Telinha é compartilhamento de tela pro seu grupo do Discord. Algumas perguntas montam o telinha.env dela; nada muda nesta máquina antes da Revisão.',
    'welcome.go': 'Configurar',
    'welcome.goDesc': 'Responda as perguntas, confira a Revisão e instale',
    'welcome.quit': 'Sair',
    'welcome.quitDesc': 'Nada é gravado',

    'review.title': 'Revisão',
    'review.intro': 'Confira suas respostas. Nada mudou nesta máquina ainda.',
    'review.file': 'Elas vão para {file}.',
    'review.apply': 'Aplicar',
    'review.applyDesc': 'Gravar o telinha.env, instalar e iniciar a Telinha',
    'review.applyDescDocker': 'Gravar o telinha.env; a máquina inicia o container',
    'review.rotate': 'Aplicar com um novo segredo de cookie',
    'review.rotateDesc': 'Desconecta todo mundo das páginas',
    'review.back': 'Voltar pras perguntas',
    'review.backDesc': 'Mudar alguma coisa antes',
    'review.quit': 'Sair sem gravar',
    'review.quitDesc': 'Nada muda nesta máquina',
    'review.introAgain':
      'O telinha.env já foi gravado pela última tentativa; Aplicar grava de novo com estas respostas.',
    'review.leave': 'Sair da configuração',
    'review.leaveDesc': 'Mantém o que a última tentativa deixou nesta máquina',

    'apply.title': 'Instalando a Telinha',
    'apply.titleDocker': 'Gravando a configuração',
    'apply.running': 'Trabalhando…',
    'apply.skipped': 'pulado',
    'apply.retry': 'Tentar de novo',
    'apply.retryDesc': 'Rodar este passo de novo',
    'apply.skip': 'Pular',
    'apply.skipDesc': 'Deixar pra lá e seguir com o resto',
    'apply.back': 'Voltar pras perguntas',
    'apply.backDesc': 'Mudar respostas e aplicar de novo',
    'apply.done': 'A Telinha está rodando',
    'apply.setUp': 'A Telinha está configurada',
    'apply.doctor': 'Ver o diagnóstico',
    'apply.doctorDesc': 'Veja o que funciona e o que precisa de atenção',
    'apply.exit': 'Sair',
    'apply.exitDesc': 'A Telinha continua rodando como serviço',
    'apply.exitDescIdle': 'Fechar a configuração',
  },
);

export type SetupKey = Parameters<typeof setupStrings>[1];

/** `s(key, params)` in the screens' current language (tracked inside JSX). */
export function useS(): (key: SetupKey, params?: Params) => string {
  const locale = useContext(LocaleCtx);
  return (key, params) => setupStrings(locale(), key, params);
}
