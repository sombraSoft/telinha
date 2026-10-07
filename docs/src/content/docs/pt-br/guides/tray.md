---
title: Ícone na bandeja
description: O ícone da Telinha ao lado do relógio do Windows, com o que ele mostra, o menu, as notificações, o início junto com o Windows e como remover.
sidebar:
  order: 6
---

Num PC com Windows, a Telinha põe um ícone na área de notificação, ao lado do
relógio. Ele mostra se a Telinha está rodando, inicia, para e reinicia ela,
procura e instala atualizações, e abre a página e o log. O ícone é um programa
pequeno e separado, o `telinha-tray.exe`. A tarefa em segundo plano roda a
Telinha com ou sem ele, e fechar o ícone não para nada.

É um único `.exe` feito sobre o .NET Framework 4.8 que já vem no Windows 10
(versão 1903 ou mais nova) e no Windows 11, então não há mais nada para
instalar. O mesmo arquivo roda em PCs x64 e ARM.

## Instalando

O `telinha setup` instala o ícone numa instalação nativa no Windows. O passo
*Ícone* pergunta *Mostrar um ícone da Telinha ao lado do relógio?* (sim por
padrão) e, depois de um sim, *Iniciar o ícone quando você entrar no Windows?*
(não por padrão; veja [Iniciar com o Windows](#iniciar-com-o-windows)). Numa
nova rodada as duas começam pelo que o PC tem agora. A instalação então copia
o `telinha-tray.exe` do zip baixado para `%LOCALAPPDATA%\Telinha\bin`, ao lado
do `telinha.exe`, e inicia ele logo depois da etapa do serviço, mostrando
`Ícone na bandeja iniciado (ao lado do relógio).` O Windows pode esconder um
ícone novo atrás da seta `^`; arraste ele para perto do relógio para deixar à
vista.

Rode o setup num terminal normal, não em *Executar como administrador*.
O ícone nunca roda elevado: tudo que o menu dele roda rodaria elevado também, e
um ícone elevado não poderia ser fechado de um terminal normal. Num terminal de
administrador o setup copia o arquivo mesmo assim, mas não inicia o ícone,
e mostra
`Rodando como administrador: o ícone na bandeja não foi iniciado; rode telinha tray start num terminal normal.`
Num PC com o UAC desligado, ou logado como o Administrador embutido, não existe
terminal normal: lá tudo roda no mesmo nível, então o ícone inicia mesmo assim.

## O que ele mostra

O ícone tem uma bolinha colorida:

| Bolinha | Significado |
| --- | --- |
| Verde | A Telinha está rodando. |
| Âmbar | Há uma versão estável mais nova. |
| Vermelha | Um programa auxiliar ou a própria Telinha fica reiniciando, a última atualização falhou, ou o que você acabou de clicar no menu falhou. |
| Cinza | Parada, sem responder, ou iniciando. |

A dica ao passar o mouse e a primeira linha do menu dizem o mesmo em palavras:
`Telinha 0.7.0: rodando, 2 sala(s)`, `Telinha: parada`,
`Telinha: não responde` ou `Telinha: iniciando…`.

*Iniciando…* aparece enquanto o loop do serviço sobe a Telinha: depois de um
reinício, depois de uma atualização, ou numa partida lenta que baixa programas
auxiliares novos. O ícone só dá a Telinha como parada quando a própria tarefa
em segundo plano sumiu, ou quando a Telinha não subiu em 5 minutos com a tarefa
rodando.

Uma segunda linha aparece quando há algo a acrescentar: o resultado do que você
acabou de clicar (`Serviço iniciado.`, `Já está atualizada.`, ou um erro como
`Não deu pra iniciar a Telinha: …`) por uns 30 segundos, senão detalhes como
`livekit: reiniciando (3 reinícios em 10 min)`,
`atualização pra v0.7.1 preparada` ou `fixada em v0.7.0`.

## O menu

| Item | O que faz |
| --- | --- |
| Abrir Telinha | Abre a `PUBLIC_URL` no navegador. Um clique duplo no ícone faz o mesmo. |
| Iniciar | Roda `telinha service start`. |
| Parar | Roda `telinha service stop`. Uma execução no console (`telinha run`) recebe uma parada suave no lugar. |
| Reiniciar | Pede para a Telinha sair, e o loop do serviço inicia ela de novo na hora. Só aparece quando ela roda como serviço. |
| Verificar atualizações | Procura a versão estável mais nova, como o `telinha update --check`. |
| Atualizar agora | Instala a versão estável mais nova (ou a fixada) agora, mesmo com salas abertas, como o `telinha update --now`. O rótulo mostra a tag quando há uma disponível. O serviço reinicia para aplicar. |
| Abrir log | Abre o `logs\telinha.log` com o app padrão, ou a pasta `logs` quando ainda não há log. |
| Iniciar com o Windows | Inicia o ícone quando você entra no Windows; veja abaixo. |
| Sair | Fecha o ícone. A Telinha continua rodando. |

Os itens que não se aplicam ficam cinza: *Iniciar* com a Telinha rodando,
*Parar* e os de atualização enquanto ela não responde, *Abrir Telinha* quando
a `PUBLIC_URL` não é um endereço `http` ou `https`.

## Notificações

O ícone mostra uma notificação do Windows, que também fica na central de
notificações, só nestes casos:

- **A Telinha parou.** Ela estava rodando e parou de responder sem o loop do
  serviço, ou não subiu em 5 minutos
  (`A Telinha não subiu em 5 minutos; veja o log.`). Nunca nos dois minutos
  depois de você clicar em *Parar*, *Reiniciar* ou *Atualizar agora*.
- **Reinícios em sequência.** Um programa auxiliar reiniciou 3 vezes em 10
  minutos (`livekit fica caindo; veja o log.`), ou a própria Telinha fica
  reiniciando (`A Telinha fica reiniciando; veja o log.`).
- **Uma versão nova.** `v0.7.1 está disponível.`, uma vez por versão, e nunca
  com a `UPDATE_PIN` definida.
- **Uma atualização aplicada.** `Atualizada pra v0.7.1.`, uma vez por versão,
  para uma atualização aplicada com o ícone rodando (ou logo antes de ele
  iniciar). Uma de antes disso, por exemplo com o ícone desligado, não é
  anunciada.

O que você clica no menu nunca vira notificação, dando certo ou não. O
resultado (iniciado, parado, reiniciado, `Já está atualizada.`, uma
atualização instalada) aparece na segunda linha do menu e na dica. Uma falha
aparece ali também, por exemplo `Não deu pra iniciar a Telinha: …` ou
`Parar falhou: …` com a primeira linha do erro, e deixa a bolinha vermelha
enquanto está lá. Clicar numa notificação não faz nada.

## Iniciar com o Windows

Desligado por padrão: depois de reiniciar o PC, o ícone só volta com isso
ligado. Ligue ou desligue pela caixa *Iniciar com o Windows* do menu, com
`telinha tray autostart on` (ou `off`), ou na segunda pergunta do ícone no
setup (`--tray-autostart` sem as telas do setup). Um setup sem as telas e sem
a opção deixa a configuração como está. É o valor `Telinha` da chave `Run` do seu usuário no
registro, apontando para `bin\telinha-tray.exe`.

## Iniciando e parando à mão

Depois de *Sair*, ou depois de entrar no Windows sem *Iniciar com o Windows*,
inicie o ícone de novo com `telinha tray start` num terminal normal; num
terminal de administrador ele recusa, com a linha mostrada acima.
`telinha tray status` diz se ele está rodando, a versão e se inicia com o
Windows, e `telinha tray stop` fecha ele. Todas as ações estão em
[Linha de comando](/telinha/pt-br/reference/cli/#telinha-tray).

A verificação `tray` do [`telinha doctor`](/telinha/pt-br/guides/doctor/)
mostra o mesmo, avisa quando o ícone roda uma versão diferente da Telinha e diz
se o arquivo tem [assinatura de código](/telinha/pt-br/guides/code-signing/).

## Como ele fala com a Telinha

Só neste computador. O ícone pergunta à Telinha pelo ponto de controle local
em `LISTEN`, com o token de `data\run\control.token` (o mesmo que os comandos
`telinha` usam), e roda o `telinha.exe` ao lado dele para *Iniciar* e *Parar*.
Ele lê o `data\run\service.pid` para saber se o loop do serviço está vivo, e o
`config\telinha.env` para `LISTEN`, `PUBLIC_URL` e `LOCALE` (o idioma segue a
mesma regra da linha de comando). Ele grava o `data\run\tray.json` enquanto
roda e o próprio log em `logs\telinha-tray.log`. Ele não abre nenhuma conexão
com a internet por conta própria: *Verificar atualizações* pergunta à Telinha,
que pergunta ao GitHub.

## Atualizações

Os zips do Windows trazem o `telinha-tray.exe`. Quando a Telinha se atualiza,
ela troca o arquivo do ícone do mesmo jeito que o `telinha.exe`, mas só quando
o ícone está instalado (senão ela atualiza a cópia guardada para um setup
depois; veja abaixo), e uma volta de versão devolve o anterior também. O
ícone rodando percebe que o arquivo mudou e reinicia sozinho na versão nova.
Veja [Atualizações](/telinha/pt-br/guides/updates/#binário-nativo).

## Sem o ícone

Responder *Sem ícone* no setup (ou `telinha setup --no-tray`) desliga o
*Iniciar com o Windows*, fecha o ícone e renomeia o `bin\telinha-tray.exe`
para `bin\telinha-tray.dist.exe`, mostrando `Ícone na bandeja não instalado.`
Essa cópia nunca roda; ela só
fica guardada para o ícone poder voltar sem download. As atualizações deixam o
ícone de fora e mantêm a cópia em dia, e o instalador do PowerShell também,
quando você roda ele de novo. Um setup depois que responda sim instala o
ícone de novo a partir dessa cópia (a pergunta então começa em *Sem ícone*);
sem as telas do setup a opção diz a escolha a cada execução, como a
`--no-service`, então uma execução sem `--no-tray` instala ele. Sem o
`bin\telinha-tray.exe`, a verificação `tray` do `telinha doctor` mostra `Ícone na bandeja não instalado.`, o que não
é problema.

## Desinstalando

`telinha service uninstall` também fecha o ícone e remove a entrada de
*Iniciar com o Windows*. O arquivo vai embora com a pasta da Telinha quando
você apagar ela.
