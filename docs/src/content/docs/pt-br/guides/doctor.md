---
title: Doctor e solução de problemas
description: Rode o telinha doctor, entenda a lista de verificações e o teste pelo celular, e resolva os problemas mais comuns pelo sintoma.
sidebar:
  order: 3
---

O `telinha doctor` confere tudo o que fica entre um membro do Discord e um
vídeo funcionando: a configuração, os programas auxiliares, o aplicativo do
Discord, o endereço público, o LiveKit Cloud ou o TURN quando estão em uso, o
serviço local, o roteador e as atualizações.
Depois ele oferece um teste pelo celular, com dados móveis, que mede o caminho
de verdade de fora da sua rede. Rode depois do setup, depois de mudar
qualquer coisa e sempre que algo parar de funcionar.

## Como rodar

```
telinha doctor              # todas as verificações, depois o teste pelo celular
telinha doctor --local      # pula as verificações que precisam de internet, e o teste pelo celular
telinha doctor --no-phone   # todas as verificações, sem o teste pelo celular
telinha doctor --json       # resultado legível por máquina no stdout
```

Num terminal o doctor é uma lista interativa. Sem terminal (um pipe, um script,
uma tarefa agendada) ou com `--json` ele imprime linhas simples; as duas formas
rodam as mesmas verificações.

- Ele lê a mesma configuração que o `telinha run`: o `telinha.env` mais o
  ambiente.
- Cada verificação tem no máximo 10 segundos; uma que demora mais falha com
  "Não terminou em 10 s".
- O `--local` pula as verificações do Discord, do IP público, do DNS e do
  HTTPS, além do teste pelo celular.
- O `--json` imprime `{ checks, phone }` (o `phone` só quando o teste rodou);
  o link e o QR code do teste vão então para o stderr.
- O código de saída é 1 quando uma verificação ou o teste pelo celular falhou;
  avisos e verificações puladas não contam. Ctrl+C na lista sai com 130.
- Ele fala a língua da linha de comando: `--lang pt-BR` ou `LOCALE`.

Onde rodar:

| Instalação | Comando |
| --- | --- |
| Windows, Linux como usuário | `telinha doctor` |
| Linux como root | `sudo telinha doctor` |
| Docker | `docker exec -it telinha bun server/src/index.ts doctor` |
| De um clone | `bun server/src/index.ts doctor` |

O setup mostra a mesma lista no fim (*Ver o diagnóstico*), com os resultados
das verificações que ele já rodou.

## A lista de verificações

Uma linha por verificação, na ordem em que você consertaria as coisas. Enquanto
uma verificação roda aparece um spinner; depois a linha ganha um ícone e um
resultado de uma linha:

| Ícone | Significado |
| --- | --- |
| `✔` | ok |
| `!` | aviso: funciona, mas tem algo estranho ou que não deu para confirmar |
| `✖` | falha: isso quebra a Telinha para alguém |
| `–` | pulada: não se aplica a esta instalação, ou uma verificação anterior precisa passar antes |

Embaixo da lista uma linha conta cada tipo (`11 ok · 1 aviso · 1 com falha · 2
pulados`), na cor do pior. Vá até uma linha e aperte Enter para abrir: os
detalhes e, numa linha que não está ok, um trecho **Como corrigir** dizendo o
que fazer. Uma linha ok abre nos detalhes, ou em *Nada a fazer*.

| Tecla | O que faz |
| --- | --- |
| `↑` `↓` (ou `k` `j`) | Move entre as linhas |
| `Enter`, `Espaço` ou `→` | Abre ou fecha a linha em que o cursor está |
| `r` | Roda todas as verificações de novo, com dados novos: use depois de consertar algo |
| `p` | Começa um novo teste pelo celular (quando a Telinha está rodando) |
| `s` | Para de esperar o celular |
| `q` ou `Esc` | Sai; o código de saída é 1 quando uma verificação ou o teste pelo celular falhou |

Uma linha de DNS que falhou, aberta, por exemplo:

```
✖ DNS                         telinha.example.com aponta pra 198.51.100.7, mas o IP público é 203.0.113.9.
                              └ Como corrigir
                                Muda o registro A de telinha.example.com pra 203.0.113.9.
```

Conserte de cima para baixo: uma configuração quebrada faz a maioria das
verificações seguintes ser pulada, e um token do bot recusado pelo Discord
pula as outras verificações do Discord. Cada verificação, o que ela olha e o
que o resultado quer dizer:
[Verificações do doctor](/telinha/pt-br/reference/doctor-checks/).

## Saída simples

Sem terminal o doctor imprime uma linha por verificação e um resumo, com os
detalhes esmaecidos e a correção depois de uma seta:

```
✓ IP público                  A internet vê esta rede como 203.0.113.9.
✗ DNS                         telinha.example.com aponta pra 198.51.100.7, mas o IP público é 203.0.113.9.
                              → Muda o registro A de telinha.example.com pra 203.0.113.9.
! Redirecionamento de portas  Sem redirecionamento: UDP 7882.
                              → Redireciona na mão no roteador pra 192.168.0.10: UDP 7882
```

Os ícones são `✓`, `!`, `✗` e `–`, com os mesmos significados de cima. O teste
pelo celular é pulado sem terminal (o link precisa de alguém para abrir),
a menos que o `--json` rode num; aí as linhas dele saem do mesmo jeito, cada
dica embaixo da linha que ela explica.

Duas linhas dependem de como a mídia está configurada. **LiveKit Cloud**
(`livekit-cloud`) só roda com `MEDIA=cloud`: ela lista as salas do projeto com
a chave e o segredo da API, então prova a URL e o par de chaves de uma vez, e
as linhas de detalhe repetem as duas coisas a saber sobre o projeto (desligar
a criação automática de salas; os limites do plano gratuito). Veja
[LiveKit Cloud](/telinha/pt-br/guides/livekit-cloud/). **TURN sobre TLS**
(`turn`) só roda onde o TURN está ligado: ela confere se o `turn.<host>`
resolve para o IP público, se ele apresenta um certificado válido na 443 e se
o TURN do LiveKit está escutando localmente na `TURN_PORT`. Numa VPS com
domínio próprio ela é pulada com o registro DNS a criar e o `TURN=on` a pôr.
Veja [TURN sobre TLS na porta 443](/telinha/pt-br/guides/turn/).

## O teste pelo celular

Com o serviço rodando e as verificações feitas, o doctor pede à Telinha um
link de uso único. Na lista ele aparece num painel ao lado das linhas (embaixo,
num terminal estreito, onde o código ocupa a tela até o celular responder),
com um QR code, e o mesmo painel depois mostra o resultado:

```
Abra isto no celular com o Wi-Fi DESLIGADO (dados móveis):
  https://telinha.example.com/doctor?t=...
```

Os dados móveis são o ponto: no seu próprio Wi-Fi o celular está dentro da sua
rede e não prova nada sobre o roteador. Não precisa de login no Discord. O
link funciona uma vez só e apenas por 10 minutos, e o cookie que ele deixa (15
minutos) não abre nada além da página do teste e do proxy de sinalização, numa
sala privada só dele (com `MEDIA=cloud` a página se conecta direto ao projeto
no Cloud). A página faz o teste; o celular e o terminal mostram o
resultado, e as linhas entram na lista como um grupo *Teste no celular*; uma que
falhou traz a correção.

O doctor espera o celular por até 10 minutos. Aperte `s` (Ctrl+C na saída
simples) para parar de esperar, e `p` para um link novo quando um expira ou você
pulou. O teste é pulado com `--no-phone` ou `--local`, sem um terminal
interativo e quando a Telinha não está rodando (inicie com
`telinha service start`).

O QR code aparece inteiro ou não aparece: quando a janela é pequena demais para
ele, mesmo sem o cabeçalho, o painel mostra só o link; aumente a janela para ver
o código.

### O que cada linha mede

| Linha | Mede |
| --- | --- |
| HTTPS | A página carregou por HTTPS, e quanto tempo levou |
| Conexão com o LiveKit | A sinalização por `/livekit` no `PUBLIC_URL`; com `MEDIA=cloud`, até o projeto no Cloud |
| Envio de vídeo | A publicação de uma faixa de vídeo de teste bem pequena |
| Primeiro caminho | O protocolo e o IP que a conexão usou, e o tempo de ida e volta |
| UDP / TCP | A mídia forçada por cada protocolo, um de cada vez, na `MEDIA_UDP_PORT` e na `MEDIA_TCP_PORT`; com `MEDIA=cloud` as linhas não mostram porta (as portas são do Cloud) |
| TURN/TLS 443 | Só com o TURN ligado (*TURN sobre TLS na 443* no celular): a mídia forçada por `turn.<host>:443`; a prova de que quem está numa rede que só libera a 443 consegue retransmitir |

### Como ler uma falha

| O que falhou | O que quer dizer |
| --- | --- |
| Conexão com o LiveKit | A Telinha não é acessível pela internet no `PUBLIC_URL`: veja as verificações de DNS, certificado HTTPS e roteador |
| UDP e TCP, com HTTPS e LiveKit ok | As portas de mídia estão fechadas: encaminhe as duas |
| Só UDP | A UDP não está encaminhada; o vídeo ainda funciona por TCP, com mais atraso |
| Só TCP | A TCP não está encaminhada; quem está numa rede que bloqueia UDP não consegue assistir |
| Primeiro caminho para um IP que não é o seu IP público | O LiveKit anuncia o endereço errado: confira o `LIVEKIT_NODE_IP` (`MEDIA=self`; com o Cloud o IP é do Cloud) |
| UDP e TCP com `MEDIA=cloud` | A rede daquele celular bloqueia WebRTC; não há nada para abrir do seu lado, tente outra rede |
| TURN/TLS 443 | Um aviso, não uma falha: veja a verificação `turn` (o registro DNS e o certificado de `turn.<host>`) |

## Solução de problemas

Cada problema abaixo diz qual verificação pega ele; a referência
[Verificações do doctor](/telinha/pt-br/reference/doctor-checks/) descreve
todas.

### Nada abre de fora

A página abre na sua rede, mas não pelos dados móveis. Olhe, nesta ordem:

- `dns`: o nome precisa apontar para o seu IP público (`public-ip`). Logo
  depois de criar ou mudar um registro, pode levar um tempo para propagar.
- `tls`: além do certificado, ela busca `<PUBLIC_URL>/healthz` pela internet.
  Se isso falha com o certificado válido, o pedido não está chegando na
  Telinha.
- `gateway`, `cgnat` e `mappings`: o roteador encaminha a TCP 8443 (um
  endereço do DuckDNS em casa) para esta máquina, ou o túnel está de pé
  (`listeners`), e a linha não está atrás de CGNAT. Numa VPS, a 443 e a 80
  estão abertas no firewall do provedor. Veja
  [Encaminhamento de portas](/telinha/pt-br/guides/port-forwarding/).
- `listeners`: a Telinha e os programas auxiliares estão de pé localmente.

### Funciona de fora, mas não da sua própria rede

Os amigos entram e o teste pelo celular com dados móveis passa, mas o
endereço não abre na máquina que roda a Telinha nem em outro aparelho da
mesma rede. O roteador não faz NAT loopback (também chamado de hairpin NAT ou
NAT reflection): ele não consegue devolver para dentro uma conexão feita ao
próprio IP público. A instalação está certa. Ligue o NAT loopback se o
roteador tiver a opção; sem ele, os aparelhos dessa rede não conseguem entrar.
Uma linha no arquivo hosts apontando o nome para o IP local da máquina não
resolve: a página abre, mas o LiveKit anuncia o IP público para o vídeo. Numa
VPS isso não acontece.

### O login volta para o Discord ou mostra "Invalid OAuth2 redirect_uri"

O Discord só manda as pessoas de volta para endereços cadastrados no
aplicativo, e a API dele não deixa cadastrar um por você. A `discord-redirect`
falha e mostra o endereço para adicionar, com o caminho no Developer Portal:
seu aplicativo → OAuth2 → Redirects → adicione `<PUBLIC_URL>/auth/callback` →
Save Changes. Se mudar o `PUBLIC_URL`, adicione o novo. Passo a passo, com os
nomes dos menus em português:
[Aplicativo do Discord](/telinha/pt-br/start/discord/).

### "Disallowed intents"

O bot precisa das intents Server Members e Presence; sem elas o Discord recusa
o login dele com "disallowed intents". A `discord-intents` falha. Rode o
`telinha setup` de novo (ele liga as duas), ou ligue no Developer Portal, na
página Bot do seu aplicativo.

### A página abre, mas o vídeo nunca conecta

O HTTPS funciona, então o lado web está certo; o problema são as portas de
mídia. O teste pelo celular mostra UDP e TCP com falha. Encaminhe a TCP
`MEDIA_TCP_PORT` (7881) e a UDP `MEDIA_UDP_PORT` (7882) para esta máquina,
libere as duas no firewall da máquina e, numa VPS, no firewall do provedor
também. A `mappings` mostra o que o roteador aceitou; no Linux a `listeners`
mostra os comandos do ufw ou do firewalld. Atrás de CGNAT (a `cgnat` falha)
nenhum encaminhamento resolve: peça um IPv4 público, ou ponha `MEDIA=cloud`
para o [LiveKit Cloud](/telinha/pt-br/guides/livekit-cloud/) levar o vídeo sem
porta aberta; veja
[CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo).

### O LiveKit Cloud falha

A `livekit-cloud` falha de dois jeitos. *Recusou a chave ou o segredo da API*:
copie a chave e o segredo de novo em Settings → Keys do projeto para o
`LIVEKIT_API_KEY` e o `LIVEKIT_API_SECRET` (ou rode o
[setup não interativo](/telinha/pt-br/guides/livekit-cloud/#configure) de
novo). *Não deu para falar*: confira a `LIVEKIT_CLOUD_URL` (nas Settings do
projeto, no formato `wss://<projeto>.livekit.cloud`) e a internet da máquina.
Quando a verificação passa mas as pessoas são recusadas no fim do mês, o
projeto bateu no teto mensal do plano gratuito.

### Quem está numa rede rígida não consegue assistir

A pessoa está numa rede que só deixa a porta 443 passar (uma empresa, uma
escola, algumas operadoras de celular), então as portas de mídia nunca chegam
na máquina. Numa VPS na 443, ligue o
[TURN sobre TLS na porta 443](/telinha/pt-br/guides/turn/) e rode o
`telinha doctor` de novo: a linha `turn` deve passar e o teste pelo celular
ganha uma linha TURN/TLS 443. Com `MEDIA=cloud`, o TURN do próprio LiveKit
Cloud cobre essas pessoas.

### Só UDP ou só TCP falha

Uma das duas regras está faltando ou com o protocolo errado. Só UDP falhou: o
vídeo cai para TCP, com mais atraso. Só TCP falhou: a maioria das pessoas não
percebe, mas quem está numa rede que bloqueia UDP fica sem nada. Confira no
roteador a regra da que falhou, e a regra de firewall correspondente; a
`mappings` lista uma porta que o roteador recusou.

### O vídeo vai para o endereço errado

A linha Primeiro caminho do teste pelo celular vai para um IP que não é o seu
IP público. Com o `LIVEKIT_NODE_IP` definido, o LiveKit anuncia exatamente esse
endereço: corrija, ou tire a chave numa internet de casa para o LiveKit
descobrir o endereço sozinho (e a vigia de IP acompanhar as mudanças, veja
[IP dinâmico](/telinha/pt-br/guides/domains/#ip-dinâmico)).

### O certificado não sai

A `tls` falha no modo `direct`. O Caddy pega o certificado no Let's Encrypt
sozinho; as tentativas dele aparecem no log como linhas `[caddy]`. A linha
`certificate` diz por qual caminho ele vai.

**Em casa com DuckDNS** (o desafio de DNS, `ACME_DNS=duckdns`), nenhuma porta
entra no certificado:

- O token do DuckDNS precisa estar certo: a linha `dns` pergunta ao DuckDNS
  se ele aceita o token (mandando o IP que o registro já tem, então nada
  muda) e falha quando não aceita; rode o `telinha setup` de novo para
  digitar o certo. Um token errado também aparece como erros `ddns:` no log.
- A `listeners` precisa mostrar o Caddy no `HTTPS_PORT` (8443): outro
  programa nessa porta impede o Caddy de subir.
- A `binaries` falha quando o `caddy` em uso não tem o módulo do DuckDNS (um
  Caddy original ou da distro no `PATH`): rode o `telinha setup` de novo pra
  pôr o build da própria Telinha em `bin/`; o do `PATH` fica como está.
- O primeiro certificado costuma levar de 1 a 3 minutos: o Caddy espera o DNS
  público mostrar o registro do desafio. Rode o `telinha doctor` de novo antes
  de mudar qualquer coisa.

**Numa VPS** (o desafio HTTP), o nome precisa apontar para cá (`dns`) e as
portas 80 e 443 precisam chegar no Caddy: abra as duas no firewall do provedor
e no ufw ou no firewalld (a `listeners` mostra os comandos).

- A `listeners` diz que nada escuta na porta HTTPS, numa instalação de
  usuário no Linux: portas abaixo de 1024 precisam do passo único de sysctl
  que ela mostra. Veja
  [Rodando como serviço](/telinha/pt-br/guides/service/#portas-baixas-numa-instalação-de-usuário-na-vps).
- No sslip.io o domínio compartilhado pode bater no limite semanal do Let's
  Encrypt; um nome DuckDNS ou um domínio próprio evita isso.

### "A Telinha já está rodando"

Só um `telinha run` por pasta da Telinha. Um segundo (rodar num console com o
serviço no ar, um segundo clique duplo) deixa o primeiro em paz e sai com 1:

```
A Telinha já está rodando (pid 1234). Use: telinha service status | telinha service stop
```

Para rodar num console, pare o serviço antes; senão use o que já está
rodando.

### O serviço não inicia no Windows

A `service` avisa quando o serviço não está instalado, não está rodando ou não
inicia junto com o computador. Então:

```
telinha service status
Get-Content "$env:LOCALAPPDATA\Telinha\logs\telinha.log" -Tail 50
```

O `telinha service status` mostra o último resultado da tarefa do Agendador de
Tarefas ao lado do estado dela; o log mostra por que o `telinha run` saiu. Para
registrar o serviço de novo, rode o `telinha setup` de novo: ele faz isso com
um pedido de administrador. Mais em
[Rodando como serviço](/telinha/pt-br/guides/service/#windows).

### Linux: lendo o log

```
journalctl -u telinha -f                # serviço do sistema
journalctl --user -u telinha -f         # serviço de usuário
```

O log tem as linhas da Telinha e as dos programas auxiliares, com os prefixos
`[livekit]`, `[caddy]` e `[cloudflared]`.

### Docker: logs e o healthcheck

```
docker logs -f telinha
docker ps
```

O contêiner aparece como `unhealthy` no `docker ps` enquanto um programa
auxiliar (LiveKit, Caddy, `cloudflared`) está parado esperando reiniciar: por
exemplo, o Caddy não consegue usar a porta dele, ou o token do túnel está
errado. O log diz qual. O `telinha-update` volta uma versão que nunca fica
saudável. Com o override do journald, o `journalctl -t telinha` guarda o log
mesmo quando o contêiner é recriado; veja
[Rodando como serviço](/telinha/pt-br/guides/service/#docker).
