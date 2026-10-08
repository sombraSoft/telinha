---
title: LiveKit Cloud
description: Deixe um projeto do LiveKit Cloud levar o vídeo (MEDIA=cloud) quando a máquina não pode receber conexões de mídia, atrás de CGNAT ou sem nada encaminhado.
sidebar:
  order: 8
---

Por padrão a Telinha roda o LiveKit ela mesma (`MEDIA=self`): o SFU
que recebe a tela compartilhada e envia para cada pessoa assistindo é um
processo filho da Telinha na mesma máquina, e as duas portas de mídia dele
precisam chegar nessa máquina vindas da internet. Com `MEDIA=cloud` um projeto
do [LiveKit Cloud](https://livekit.io/cloud) faz esse trabalho no lugar dele. A
Telinha continua servindo as páginas, o login do Discord e o bot; o vídeo vai
entre os navegadores e os servidores do LiveKit, e nenhuma porta de mídia é
aberta em lugar nenhum.

## Quando usar

- **A sua linha está atrás de CGNAT**, então nada da internet chega na sua
  rede (veja [CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo)).
  Com um Cloudflare Tunnel para as páginas e o LiveKit Cloud para o vídeo, um
  PC em casa não precisa de nenhuma porta encaminhada.
- **Você não consegue encaminhar portas** no roteador, ou prefere não fazer.
- **Quem assiste de redes rígidas**: o LiveKit Cloud tem servidores TURN
  próprios, então quem está numa rede que só libera a porta 443 continua
  conseguindo assistir, onde quer que a Telinha rode.

O preço são os limites mensais do plano gratuito (abaixo), e o vídeo passar
por uma empresa que não é você (veja [Privacidade](#privacidade)). Uma linha de
casa com IP público e portas encaminhadas, ou uma VPS, não precisa de nada
disso.

As páginas continuam precisando de uma entrada: as pessoas abrem o
`PUBLIC_URL` como sempre. Isso é um
[Cloudflare Tunnel](/telinha/pt-br/guides/domains/#cloudflare-tunnel) (um
domínio na Cloudflare; a única opção de casa atrás de CGNAT), um
[endereço do DuckDNS na porta 8443](/telinha/pt-br/guides/domains/#duckdns-na-porta-8443)
(TCP 8443 encaminhada) ou uma [VPS](/telinha/pt-br/start/vps/).

## Crie o projeto

1. Crie uma conta em [cloud.livekit.io](https://cloud.livekit.io) e crie um
   projeto.
2. Em Settings → Project do projeto, copie a URL do projeto. Ela tem a cara de
   `wss://my-group-abc123.livekit.cloud` (os exemplos de código do painel
   chamam ela de `LIVEKIT_URL`). Ela vira a `LIVEKIT_CLOUD_URL`.
3. Em Settings → Keys, crie uma chave de API e copie a chave e o segredo dela.
   Eles viram o `LIVEKIT_API_KEY` e o `LIVEKIT_API_SECRET`. Guarde o segredo
   como uma senha: quem tem ele consegue entrar em qualquer sala do projeto e
   controlar todas.

### Desligue a criação automática de salas

Nas configurações do projeto, desligue a criação automática de salas. O
LiveKit Cloud normalmente cria uma sala no momento em que alguém entra numa
que não existe. A Telinha não precisa disso: ela mesma cria cada sala quando o
`/telinha` roda e apaga quando a sala fecha. Com a criação automática ligada,
alguém abrindo uma sala recém-fechada com um token entregue antes de ela
fechar (os tokens duram 10 minutos) traria de volta uma sala vazia que ninguém
acompanha. A Telinha recusa tokens novos para salas fechadas de qualquer
jeito, e uma sala assim some sozinha quando fica vazia, mas com a opção
desligada ela nem aparece. O `telinha doctor` repete esse conselho na linha
do LiveKit Cloud.

## O plano gratuito

O plano gratuito Build do LiveKit Cloud inclui, por projeto:

| Franquia | Plano Build |
| --- | --- |
| Participante-minutos de WebRTC | 5.000 por mês |
| Transferência de dados de download | 50 GB por mês |
| Participantes conectados | 100 ao mesmo tempo, somando todas as salas |

No plano gratuito isso é um teto rígido: quando os minutos ou a transferência
acabam, o LiveKit Cloud recusa conexões novas até o mês seguinte, e com 100
pessoas conectadas a próxima é recusada. Os participante-minutos contam cada
pessoa conectada numa sala, inclusive quem compartilha: uma sessão de duas
horas com uma pessoa compartilhando e quatro assistindo gasta 5 × 120 = 600
minutos, então 5.000 dão umas oito noites assim. Um compartilhamento longo em
alta resolução pode gastar os 50 GB antes. O painel do projeto em
cloud.livekit.io mostra o consumo; os planos pagos aumentam os limites.

## Configure

Rode o `telinha setup` e escolha *LiveKit Cloud* no passo Vídeo: ele pede a
URL do projeto, a chave de API e o segredo (colado num campo mascarado), e pula
as portas de mídia. Em casa atrás de CGNAT o setup já escolhe o Cloud para você.

Sem as telas do setup, troque com o setup não interativo. O segredo nunca vai
na linha de comando: passe como arquivo (`-` lê do stdin) ou pela variável de
ambiente `LIVEKIT_API_SECRET`.

```
telinha setup --non-interactive --media cloud \
  --cloud-url wss://my-group-abc123.livekit.cloud \
  --livekit-key APIxxxxxxxxxxxx --livekit-secret-file - < ./livekit-secret
```

Todas as outras respostas vêm do `telinha.env` existente; numa instalação nova,
acrescente as opções de um setup não interativo completo (veja
[CLI](/telinha/pt-br/reference/cli/)). O setup escreve:

```
MEDIA=cloud
LIVEKIT_CLOUD_URL=wss://my-group-abc123.livekit.cloud
LIVEKIT_API_KEY=APIxxxxxxxxxxxx
LIVEKIT_API_SECRET='...'
```

Ele tira o `MEDIA_TCP_PORT` e o `MEDIA_UDP_PORT` (nada usa essas portas) e o
par de chaves que tinha gerado para o LiveKit local, e depois reinicia o
serviço. Se faltar `--cloud-url`, `--livekit-key` ou o segredo, o setup lista
tudo o que falta de uma vez e sai com 2.

À mão também funciona, e é o jeito no Docker: ponha essas quatro linhas no
`telinha.env` (com o segredo entre aspas simples), tire as duas linhas das
portas de mídia e reinicie (`telinha service restart`; no Docker
`docker compose up -d --force-recreate` em `/opt/telinha`). A
`LIVEKIT_CLOUD_URL` também aceita a forma `https://`, e um caminho, query ou
barra final colados são descartados.

## O que muda quando roda

- **Nenhum LiveKit filho.** O `telinha run` só inicia o Caddy ou o
  `cloudflared` (ou nada com `INGRESS=external`), e a linha de início dele diz
  `media=cloud`.
- **Nenhuma porta de mídia.** O UPnP só pede ao roteador a 8443 (DuckDNS em
  casa), o Firewall do Windows não ganha regras do LiveKit (o passo do serviço
  do setup, ou o `telinha service install --firewall`, reescreve as regras), e
  o doctor não lista porta de mídia para encaminhar.
- **Nenhum proxy de sinalização em `/livekit`.** A página da sala recebe a URL do projeto no
  Cloud junto com o token e se conecta direto no LiveKit Cloud, para a
  sinalização e para a mídia.
- **As salas funcionam igual.** A Telinha cria cada sala pela API de salas do
  projeto, acompanha quem está nela e apaga quando ela fecha, o que desconecta
  todo mundo. Os tokens continuam durando 10 minutos, e um link para uma sala
  fechada é recusado pela Telinha antes de o LiveKit Cloud ser consultado.
- **A vigia de IP** continua renovando os mapeamentos do roteador e o DuckDNS
  quando o IP público muda; não há LiveKit para reiniciar.
- **Chaves ignoradas.** `LIVEKIT_PORT`, `MEDIA_TCP_PORT`, `MEDIA_UDP_PORT`,
  `LIVEKIT_API_URL` e `LIVEKIT_PUBLIC_URL` só valem com `MEDIA=self`; com um
  valor diferente do padrão elas geram o log
  `config: LIVEKIT_PORT only applies to MEDIA=self; ignored`.
- **Nenhum TURN da própria Telinha.** `TURN=on` é recusado com `MEDIA=cloud`:
  o LiveKit Cloud traz o dele.

## Verifique

```
telinha doctor
```

- A linha **LiveKit Cloud** (`livekit-cloud`) lista as salas do projeto com a
  sua chave e o seu segredo, o que prova a URL e o par de chaves juntos:
  `Connected to my-group-abc123.livekit.cloud: 0 room(s) open there.` (em
  português, `Conectado a ...`). Ela falha quando o LiveKit Cloud recusa a
  chave ou o segredo (copie de novo em Settings → Keys) ou não responde
  (confira a `LIVEKIT_CLOUD_URL` e a internet da máquina).
- A linha **NAT da operadora** (`cgnat`) só avisa atrás de CGNAT: só as
  páginas precisam de uma entrada.
- O **teste pelo celular** se conecta direto no projeto do Cloud. As linhas
  UDP e TCP aparecem sem número de porta, porque as portas são do LiveKit
  Cloud; quando as duas falham, a rede do celular bloqueia WebRTC e não há
  nada para abrir do seu lado.

## Privacidade

Com `MEDIA=cloud` a tela e o som compartilhados passam pelos servidores do
LiveKit. Eles viajam criptografados, mas quem cuida deles é uma empresa que
não é você, sob os termos e a política de privacidade do próprio LiveKit. Os
tokens de sala que a Telinha assina também levam o nome de exibição, o id de
usuário e o avatar do Discord de cada pessoa, como já acontece com o LiveKit
embutido, e os nomes das salas são os códigos das salas. Com `MEDIA=self` nada
disso chega na máquina de mais ninguém.

## Voltar atrás

```
telinha setup --non-interactive --media self
```

O setup tira a `LIVEKIT_CLOUD_URL` e o par de chaves do Cloud, gera um par
local novo, e a próxima inicialização roda o LiveKit na máquina de novo.
Encaminhe a TCP 7881 e a UDP 7882 de novo (ou deixe o UPnP fazer isso), e veja
[Encaminhamento de portas](/telinha/pt-br/guides/port-forwarding/).
