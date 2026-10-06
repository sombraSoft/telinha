---
title: Doctor e solução de problemas
description: Rode o telinha doctor, entenda a tabela e o teste pelo celular, e resolva os problemas mais comuns pelo sintoma.
sidebar:
  order: 3
---

O `telinha doctor` confere tudo o que fica entre um membro do Discord e um
vídeo funcionando: a configuração, os programas auxiliares, o aplicativo do
Discord, o endereço público, o serviço local, o roteador e as atualizações.
Depois ele oferece um teste pelo celular, com dados móveis, que mede o caminho
de verdade de fora da sua rede. Rode depois do assistente, depois de mudar
qualquer coisa e sempre que algo parar de funcionar.

## Como rodar

```
telinha doctor              # todas as verificações, depois o teste pelo celular
telinha doctor --local      # pula as verificações que precisam de internet, e o teste pelo celular
telinha doctor --no-phone   # todas as verificações, sem o teste pelo celular
telinha doctor --json       # resultado legível por máquina no stdout
```

- Ele lê a mesma configuração que o `telinha run`: o `telinha.env` mais o
  ambiente.
- Cada verificação tem no máximo 10 segundos; uma que demora mais falha com
  "Não terminou em 10 s".
- O `--local` pula as verificações do Discord, do IP público, do DNS e do
  HTTPS, além do teste pelo celular.
- O `--json` imprime `{ checks, phone }` (o `phone` só quando o teste rodou);
  o link e o QR code do teste vão então para o stderr.
- O código de saída é 1 quando uma verificação ou o teste pelo celular falhou;
  avisos e verificações puladas não contam.
- Ele fala a língua da linha de comando: `--lang pt-BR` ou `LOCALE`.

Onde rodar:

| Instalação | Comando |
| --- | --- |
| Windows, Linux como usuário | `telinha doctor` |
| Linux como root | `sudo telinha doctor` |
| Docker | `docker exec -it telinha bun server/src/index.ts doctor` |
| De um clone | `bun server/src/index.ts doctor` |

## Como ler a tabela

Uma linha por verificação, na ordem em que você consertaria as coisas:

| Ícone | Significado |
| --- | --- |
| `✓` | ok |
| `!` | aviso: funciona, mas tem algo estranho ou que não deu para confirmar |
| `✗` | falha: isso quebra a Telinha para alguém |
| `–` | pulada: não se aplica a esta instalação, ou uma verificação anterior precisa passar antes |

Embaixo de uma linha que não está ok vêm os detalhes e uma linha que começa
com `→`: o que fazer. Por exemplo:

```
✓ IP público                  A internet vê esta rede como 203.0.113.9.
✗ DNS                         telinha.example.com aponta pra 198.51.100.7, mas o IP público é 203.0.113.9.
                              → Muda o registro A de telinha.example.com pra 203.0.113.9.
! Redirecionamento de portas  Sem redirecionamento: UDP 7882.
                              → Redireciona na mão no roteador pra 192.168.0.10: UDP 7882
```

Conserte de cima para baixo: uma configuração quebrada faz a maioria das
verificações seguintes ser pulada, e um token do bot recusado pelo Discord
pula as outras verificações do Discord. Cada verificação, o que ela olha e o
que o resultado quer dizer:
[Verificações do doctor](/telinha/pt-br/reference/doctor-checks/).

## O teste pelo celular

Com o serviço rodando e as verificações feitas, o doctor pede à Telinha um
link de uso único e mostra ele com um QR code:

```
Abra isto no celular com o Wi-Fi DESLIGADO (dados móveis):
  https://telinha.example.com/doctor?t=...
```

Os dados móveis são o ponto: no seu próprio Wi-Fi o celular está dentro da sua
rede e não prova nada sobre o roteador. Não precisa de login no Discord. O
link funciona uma vez só e apenas por 10 minutos, e o cookie que ele deixa (15
minutos) não abre nada além da página do teste e do relay do LiveKit, numa
sala privada só dele. A página faz o teste, e o celular e o terminal mostram o
resultado.

O doctor espera o celular por até 10 minutos; Ctrl+C pula a espera. O teste é
pulado com `--no-phone` ou `--local`, sem um terminal interativo e quando a
Telinha não está rodando (inicie com `telinha service start`).

### O que cada linha mede

| Linha | Mede |
| --- | --- |
| HTTPS | A página carregou por HTTPS, e quanto tempo levou |
| Conexão com o LiveKit | A sinalização por `/livekit` no `PUBLIC_URL` |
| Envio de vídeo | A publicação de uma faixa de vídeo de teste bem pequena |
| Primeiro caminho | O protocolo e o IP que a conexão usou, e o tempo de ida e volta |
| UDP / TCP | A mídia forçada por cada protocolo, um de cada vez, na `MEDIA_UDP_PORT` e na `MEDIA_TCP_PORT` |

### Como ler uma falha

| O que falhou | O que quer dizer |
| --- | --- |
| Conexão com o LiveKit | A Telinha não é acessível pela internet no `PUBLIC_URL`: veja as verificações de DNS, certificado HTTPS e roteador |
| UDP e TCP, com HTTPS e LiveKit ok | As portas de mídia estão fechadas: encaminhe as duas |
| Só UDP | A UDP não está encaminhada; o vídeo ainda funciona por TCP, com mais atraso |
| Só TCP | A TCP não está encaminhada; quem está numa rede que bloqueia UDP não consegue assistir |
| Primeiro caminho para um IP que não é o seu IP público | O LiveKit anuncia o endereço errado: confira o `LIVEKIT_NODE_IP` |

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
- `gateway`, `cgnat` e `mappings`: o roteador encaminha a TCP 443 (e a 80)
  para esta máquina, e a linha não está atrás de CGNAT. Veja
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
nenhum encaminhamento resolve: veja
[CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo).

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
sozinho assim que o nome aponta para cá (`dns`) e as portas chegam no Caddy
(`mappings`, `listeners`); as tentativas dele aparecem no log como linhas
`[caddy]`.

- Porta 80 fechada: o Let's Encrypt pode validar por TLS na 443. Use
  `HTTP_PORT=0` para nada ficar esperando na 80, e garanta que a 443 pública
  chega no Caddy. Veja
  [Tradução de portas](/telinha/pt-br/guides/domains/#tradução-de-portas).
- A `listeners` diz que nada escuta na porta HTTPS, numa instalação de
  usuário no Linux: portas abaixo de 1024 precisam do passo único de sysctl
  que ela mostra, ou de `HTTPS_PORT=8443`. Veja
  [Rodando como serviço](/telinha/pt-br/guides/service/#linux-como-usuário).
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

### O serviço do Windows não inicia

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
exemplo, o Caddy não consegue usar as portas 80/443, ou o token do túnel está
errado. O log diz qual. O `telinha-update` volta uma versão que nunca fica
saudável. Com o override do journald, o `journalctl -t telinha` guarda o log
mesmo quando o contêiner é recriado; veja
[Rodando como serviço](/telinha/pt-br/guides/service/#docker).
