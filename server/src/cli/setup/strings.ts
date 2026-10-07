// Setup's install lines (EN + pt-BR): what the steps print while they write the
// file and install. The questions' texts live in qstrings.ts, the task list's
// in apply-strings.ts.
import { defineStrings } from '../strings.ts';

export const t = defineStrings(
  {
    failed: 'setup failed: {error}',
    aborted: 'Nothing was written.',
    wroteEarlier: 'This attempt wrote nothing; {file} is the one an earlier attempt wrote.',
    configInvalid: 'the resulting configuration is invalid: {error}',

    // host
    hostLine: 'This machine: {what}.',
    hostPublicIp: 'public IP {ip}',
    hostNoPublicIp: 'public IP unknown (offline?)',
    hostRouter: 'Router: {router}.',

    // address
    duckOk: '{name} now points at {ip}.',
    duckFailed: 'DuckDNS did not accept it: {error}',

    // discord
    discordTitle: 'Discord',
    discordBot: 'Bot: {name} (app id {id})',
    discordTokenRejected: 'Discord rejected the token; paste it again.',
    discordUnreachable: 'Discord could not be reached: {error}',
    intentsOn: 'Switched on Server Members Intent and Presence Intent.',
    intentsApiFailed: 'Could not switch the intents on automatically: {error}',
    intentsGiveUp: 'The intents are still off: the bot cannot log in ("disallowed intents") until they are on.',
    secretRejected: 'Discord rejected the client secret.',
    secretUnchecked: 'Could not check the client secret ({error}); keeping it.',
    redirectSkipped: 'Login will fail until {uri} is a redirect of the app (telinha doctor checks it).',
    guildMissingInvite: 'The bot is not in server {id}; add it with {url}',
    roleMissing: 'Role {id} does not exist in the server.',
    channelMissing: 'Channel {id} is not a text channel the bot can see.',
    clientIdMismatch: "--client-id {given} does not match the token's application {id}; using {id}.",

    // write
    written: 'Wrote {file}',
    aclFailed: 'Could not restrict access to the file: {error}',

    // binaries, service
    binsTitle: 'Programs',
    binsChecking: 'Downloading {tools}...',
    binsOk: 'Programs ready in {dir}',
    binsFailed: 'Download failed: {error}. telinha run tries again at start.',
    binsByService: 'The service downloads {tools} itself, as its own user, when it starts.',
    serviceTitle: 'Service',
    serviceNeedsBinary: 'Running from source: no service is installed (the native binary installs one).',
    serviceUnsupported: 'No service manager on this system; start Telinha with telinha run.',
    serviceInstalling: 'Installing the service ({kind})...',
    serviceInstalled: 'Service installed ({kind})',
    serviceFailed: 'Service install failed: {error}',
    serviceManual: 'Install it later: paste this into PowerShell (Windows asks for administrator rights):\n  {cmd}',
    exeCopied: 'Copied the program to {path}',
    pathAdded: 'Added {dir} to your PATH: new terminals know the telinha command.',
    whoamiFailed: 'Could not read the current Windows account (whoami).',
    uacExplain:
      'Windows asks for administrator rights once (UAC): to register the background task\nand allow the media ports through the firewall.',
    uacDeclined: 'Administrator rights were not granted; the service is not installed.',
    uacNoResult: 'The elevated install left no result (exit code {code}).',
    stepTask: 'Background task',
    stepFirewall: 'Firewall rules',
    stepStart: 'Start',
    stepSkipped: '{step}: skipped',
    stepHint: 'Still to do by hand: {cmd}',
    lingerWhy: 'Without it Telinha stops whenever you log out of this machine (an SSH session ending counts).',
    sysctlExplain:
      'Ports {ports} are below 1024: Linux lets only root bind them unless one setting changes.\nOne sudo command allows ports from 80 up for every user (it survives updates):',
    sysctlOk: 'Ports from 80 up are allowed now.',
    sysctlFailed: 'The setting was not changed.',
    sysctlManual: 'To use 80/443 later: {cmd}',

    // router
    routerTitle: 'Router',
    routerNone: 'No router answered UPnP, NAT-PMP or PCP.',
    routerFound: 'Router {router}, external IP {ip}',
    forwardByHand: 'Forward these ports on the router to this machine: {ports}',
    routerVps:
      "Open these ports in your provider's firewall (security group / security list) and in this machine's own firewall: {ports}",
    routerVpsUfw: 'ufw is installed; if it is active: {cmd}',
    routerVpsFirewalld: 'firewalld is installed; if it is running: {cmd}',
    upnpWillMap: 'Telinha asks the router for {ports} while it runs (telinha doctor shows the result).',
    cgnat:
      "The router's external IP is a carrier-grade NAT address (100.64.0.0/10): nothing from the internet\ncan reach this network. Run setup again and choose LiveKit Cloud (MEDIA=cloud) for the video, ask the ISP\nfor a public IP, or run Telinha on a VPS.",
    cgnatCloud:
      "The router's external IP is a carrier-grade NAT address (100.64.0.0/10): LiveKit Cloud carries the\nvideo, but the HTTPS port still cannot reach this network. A Cloudflare Tunnel needs no open port.",
    routerNoMedia: 'LiveKit Cloud carries the video: no media ports to open here.',
    doubleNat:
      "The router's external IP is private: there is a second router in front of it (double NAT).\nForward the ports on that one too, or put this router in bridge mode.",

    // start, doctor, next
    startTitle: 'Start',
    waitingStart: 'Waiting for Telinha to start...',
    restarting: 'Restarting Telinha with the new configuration...',
    running: 'Telinha is running.',
    notAnswering: 'Telinha does not answer yet. Its log says why: {log}\n{telinha} doctor --local checks the rest.',
    certWaiting: "Waiting for the HTTPS certificate (Let's Encrypt, usually under a minute)...",
    certWaitingDns: "Waiting for the HTTPS certificate (Let's Encrypt through DuckDNS, usually 1-3 minutes)...",
    certOk: 'HTTPS certificate in place.',
    certPending:
      'No HTTPS certificate yet: getting one can take a few minutes. If doctor flags it below, run {telinha} doctor again in a few minutes before changing anything.',
    consoleRestart: 'Telinha runs in a console: restart it there to use the new configuration.',
    startByHand: 'Start it with: {cmd}',
    doctorTitle: 'Checking everything (telinha doctor)',
    doctorProblems: 'Doctor found problems: the lines above say what to fix; {telinha} doctor checks again.',
    doctorFailed: 'Doctor could not run: {error}',
    nextTitle: 'Next steps',
    nextNative:
      'Open {url} or type /{command} in one of the chosen Discord channels.\nSettings live in {file}: run {telinha} setup again to change them, {telinha} doctor to check them.',
    nextDocker:
      'Start it on the host:  cd /opt/telinha && docker compose up -d\nKeep it updated:       systemctl enable --now telinha-update.timer\nCheck it:              docker exec -it telinha bun server/src/index.ts doctor',
  },
  {
    failed: 'o setup falhou: {error}',
    aborted: 'Nada foi gravado.',
    wroteEarlier: 'Esta tentativa não gravou nada; {file} é o que uma tentativa anterior gravou.',
    configInvalid: 'a configuração resultante é inválida: {error}',

    hostLine: 'Esta máquina: {what}.',
    hostPublicIp: 'IP público {ip}',
    hostNoPublicIp: 'IP público desconhecido (sem internet?)',
    hostRouter: 'Roteador: {router}.',

    duckOk: '{name} agora aponta pra {ip}.',
    duckFailed: 'O DuckDNS não aceitou: {error}',

    discordTitle: 'Discord',
    discordBot: 'Bot: {name} (app id {id})',
    discordTokenRejected: 'O Discord recusou o token; cole de novo.',
    discordUnreachable: 'Não deu pra falar com o Discord: {error}',
    intentsOn: 'Server Members Intent e Presence Intent foram ligados.',
    intentsApiFailed: 'Não deu pra ligar os intents automaticamente: {error}',
    intentsGiveUp: 'Os intents continuam desligados: o bot não consegue entrar ("disallowed intents") até ligar.',
    secretRejected: 'O Discord recusou o client secret.',
    secretUnchecked: 'Não deu pra verificar o client secret ({error}); mantendo.',
    redirectSkipped: 'O login vai falhar até {uri} ser um redirect do app (o telinha doctor verifica).',
    guildMissingInvite: 'O bot não está no servidor {id}; adicione com {url}',
    roleMissing: 'O cargo {id} não existe no servidor.',
    channelMissing: 'O canal {id} não é um canal de texto que o bot vê.',
    clientIdMismatch: '--client-id {given} não bate com a aplicação do token {id}; usando {id}.',

    written: '{file} gravado',
    aclFailed: 'Não deu pra restringir o acesso ao arquivo: {error}',

    binsTitle: 'Programas',
    binsChecking: 'Baixando {tools}...',
    binsOk: 'Programas prontos em {dir}',
    binsFailed: 'O download falhou: {error}. O telinha run tenta de novo ao iniciar.',
    binsByService: 'O serviço baixa {tools} sozinho, com o usuário dele, quando inicia.',
    serviceTitle: 'Serviço',
    serviceNeedsBinary: 'Rodando do código-fonte: nenhum serviço é instalado (o binário nativo instala um).',
    serviceUnsupported: 'Sem gerenciador de serviço neste sistema; inicie a Telinha com telinha run.',
    serviceInstalling: 'Instalando o serviço ({kind})...',
    serviceInstalled: 'Serviço instalado ({kind})',
    serviceFailed: 'A instalação do serviço falhou: {error}',
    serviceManual: 'Instale depois: cole isto no PowerShell (o Windows pede direitos de administrador):\n  {cmd}',
    exeCopied: 'Programa copiado pra {path}',
    pathAdded: '{dir} foi adicionado ao seu PATH: terminais novos conhecem o comando telinha.',
    whoamiFailed: 'Não deu pra ler a conta atual do Windows (whoami).',
    uacExplain:
      'O Windows pede permissão de administrador uma vez (UAC): pra registrar a tarefa em segundo plano\ne liberar as portas de mídia no firewall.',
    uacDeclined: 'A permissão de administrador não foi dada; o serviço não foi instalado.',
    uacNoResult: 'A instalação elevada não deixou resultado (código de saída {code}).',
    stepTask: 'Tarefa em segundo plano',
    stepFirewall: 'Regras de firewall',
    stepStart: 'Início',
    stepSkipped: '{step}: pulado',
    stepHint: 'Falta fazer à mão: {cmd}',
    lingerWhy: 'Sem isso a Telinha para sempre que você sai desta máquina (o fim de uma sessão SSH conta).',
    sysctlExplain:
      'As portas {ports} são menores que 1024: o Linux só deixa o root usar elas, a menos que um ajuste mude.\nUm comando sudo libera as portas a partir da 80 pra todo usuário (vale depois das atualizações):',
    sysctlOk: 'Portas a partir da 80 liberadas.',
    sysctlFailed: 'O ajuste não foi feito.',
    sysctlManual: 'Pra usar 80/443 depois: {cmd}',

    routerTitle: 'Roteador',
    routerNone: 'Nenhum roteador respondeu UPnP, NAT-PMP ou PCP.',
    routerFound: 'Roteador {router}, IP externo {ip}',
    forwardByHand: 'Redirecione estas portas no roteador pra esta máquina: {ports}',
    routerVps:
      'Libere estas portas no firewall do provedor (security group / security list) e no firewall desta máquina: {ports}',
    routerVpsUfw: 'O ufw está instalado; se estiver ativo: {cmd}',
    routerVpsFirewalld: 'O firewalld está instalado; se estiver rodando: {cmd}',
    upnpWillMap: 'A Telinha pede {ports} pro roteador enquanto roda (o telinha doctor mostra o resultado).',
    cgnat:
      'O IP externo do roteador é de CGNAT da operadora (100.64.0.0/10): nada da internet chega\nnesta rede. Rode o setup de novo e escolha o LiveKit Cloud (MEDIA=cloud) pro vídeo, peça um IP\npúblico pra operadora, ou rode a Telinha numa VPS.',
    cgnatCloud:
      'O IP externo do roteador é de CGNAT da operadora (100.64.0.0/10): o LiveKit Cloud leva o vídeo,\nmas a porta HTTPS ainda não chega nesta rede. Um Cloudflare Tunnel não precisa de porta aberta.',
    routerNoMedia: 'O LiveKit Cloud leva o vídeo: nenhuma porta de mídia pra abrir aqui.',
    doubleNat:
      'O IP externo do roteador é privado: tem um segundo roteador na frente (NAT duplo).\nRedirecione as portas nele também, ou coloque este roteador em modo bridge.',

    startTitle: 'Início',
    waitingStart: 'Esperando a Telinha iniciar...',
    restarting: 'Reiniciando a Telinha com a configuração nova...',
    running: 'A Telinha está rodando.',
    notAnswering:
      'A Telinha ainda não responde. O log dela diz o motivo: {log}\n{telinha} doctor --local verifica o resto.',
    certWaiting: "Esperando o certificado HTTPS (Let's Encrypt, em geral menos de um minuto)...",
    certWaitingDns: "Esperando o certificado HTTPS (Let's Encrypt pelo DuckDNS, em geral de 1 a 3 minutos)...",
    certOk: 'Certificado HTTPS no lugar.',
    certPending:
      'Ainda sem certificado HTTPS: conseguir um pode levar alguns minutos. Se o doctor apontar isso abaixo, rode {telinha} doctor de novo daqui a uns minutos antes de mudar qualquer coisa.',
    consoleRestart: 'A Telinha roda num console: reinicie ela lá pra usar a configuração nova.',
    startByHand: 'Inicie com: {cmd}',
    doctorTitle: 'Verificando tudo (telinha doctor)',
    doctorProblems:
      'O doctor achou problemas: as linhas acima dizem o que corrigir; {telinha} doctor verifica de novo.',
    doctorFailed: 'O doctor não conseguiu rodar: {error}',
    nextTitle: 'Próximos passos',
    nextNative:
      'Abra {url} ou digite /{command} num dos canais escolhidos do Discord.\nAs configurações ficam em {file}: rode {telinha} setup de novo pra mudar, {telinha} doctor pra verificar.',
    nextDocker:
      'Inicie no host:          cd /opt/telinha && docker compose up -d\nMantenha atualizada:     systemctl enable --now telinha-update.timer\nVerifique:               docker exec -it telinha bun server/src/index.ts doctor',
  },
);

export type SKey = keyof typeof t.en;
