// The install's own dictionary (EN + pt-BR): task labels, what to do when a
// task fails, and the few lines the task list adds to the steps' output.
import { defineStrings } from '../strings.ts';

export const at = defineStrings(
  {
    taskDiscord: 'Discord app',
    taskDuckdns: 'DuckDNS address',
    taskConfig: 'Write telinha.env',
    taskBinaries: 'Download the programs',
    taskService: 'Install the service',
    taskTray: 'Tray icon',
    taskRouter: 'Router and firewall',
    taskStart: 'Start Telinha',
    taskCert: 'HTTPS certificate',
    taskDoctor: 'Check everything',

    hintDiscord:
      'Discord did not accept the answers: go back to fix the bot token, the client secret, the Discord server, the role or the channels.',
    hintDuckdns: 'DuckDNS refused the name or the token: check both on duckdns.org, or go back and type them again.',
    hintConfig: 'Nothing was written: go back to the Review and check the answers.',
    hintBinaries: 'telinha run downloads them again at start; try again once the internet works.',
    hintService: 'The service is not installed: try again, or skip and start Telinha with telinha run.',
    hintTray: 'The icon is optional: skip it and run telinha tray start later.',
    hintRouter: "Forward the ports to this machine by hand (on a VPS: open them in the provider's firewall).",
    hintStart: 'Telinha does not answer yet: its log says why; try again after fixing it.',
    hintCert: 'Getting a certificate can take a few minutes; doctor checks it again later.',
    hintDoctor: 'Doctor found problems: its report says what to fix.',

    uacWaiting: 'Approve the Windows administrator prompt…',
    checksProgress: '{done} of {total} checks',
    doctorOk: '{n} ok',
    doctorWarn1: '1 warning',
    doctorWarnN: '{n} warnings',
    doctorFail: '{n} failed',
    doctorSkip1: '1 skipped',
    doctorSkipN: '{n} skipped',
    notWritten: 'Not run: the configuration was not written.',
    summaryTitle: 'Install',
  },
  {
    taskDiscord: 'App do Discord',
    taskDuckdns: 'Endereço no DuckDNS',
    taskConfig: 'Gravar o telinha.env',
    taskBinaries: 'Baixar os programas',
    taskService: 'Instalar o serviço',
    taskTray: 'Ícone na bandeja',
    taskRouter: 'Roteador e firewall',
    taskStart: 'Iniciar a Telinha',
    taskCert: 'Certificado HTTPS',
    taskDoctor: 'Verificar tudo',

    hintDiscord:
      'O Discord não aceitou as respostas: volte pra corrigir o token do bot, o client secret, o servidor do Discord, o cargo ou os canais.',
    hintDuckdns: 'O DuckDNS recusou o nome ou o token: confira os dois no duckdns.org, ou volte e digite de novo.',
    hintConfig: 'Nada foi gravado: volte pra Revisão e confira as respostas.',
    hintBinaries: 'O telinha run baixa de novo ao iniciar; tente de novo quando a internet funcionar.',
    hintService: 'O serviço não foi instalado: tente de novo, ou pule e inicie a Telinha com telinha run.',
    hintTray: 'O ícone é opcional: pule e rode telinha tray start depois.',
    hintRouter: 'Redirecione as portas pra esta máquina à mão (numa VPS: libere no firewall do provedor).',
    hintStart: 'A Telinha ainda não responde: o log dela diz o motivo; tente de novo depois de corrigir.',
    hintCert: 'Conseguir um certificado pode levar alguns minutos; o doctor verifica de novo depois.',
    hintDoctor: 'O doctor achou problemas: o relatório dele diz o que corrigir.',

    uacWaiting: 'Aprove o pedido de administrador do Windows…',
    checksProgress: '{done} de {total} verificações',
    doctorOk: '{n} ok',
    doctorWarn1: '1 aviso',
    doctorWarnN: '{n} avisos',
    doctorFail: '{n} com falha',
    doctorSkip1: '1 pulado',
    doctorSkipN: '{n} pulados',
    notWritten: 'Não rodou: a configuração não foi gravada.',
    summaryTitle: 'Instalação',
  },
);

export type AKey = keyof typeof at.en;
