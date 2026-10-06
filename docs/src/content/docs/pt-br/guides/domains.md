---
title: Endereço, HTTPS e modos de entrada
description: Como as pessoas chegam na Telinha por HTTPS, com domínio próprio, DuckDNS, sslip.io, um Cloudflare Tunnel ou o seu próprio proxy reverso.
sidebar:
  order: 1
---

As pessoas abrem a Telinha no navegador, e o navegador só compartilha a tela
em páginas HTTPS. Por isso a Telinha precisa de um endereço HTTPS. Esse
endereço é o `PUBLIC_URL` no `telinha.env`, e o `INGRESS` diz quem atende
nele. O `telinha setup` pergunta qual das opções abaixo você quer e grava as
chaves; para mudar depois, rode o assistente de novo, ou edite o
`telinha.env` e reinicie. Todas as chaves estão em
[Configuração](/telinha/pt-br/reference/configuration/).

## Qual escolher

| Opção | `INGRESS` | Serve para | Portas web de entrada |
| --- | --- | --- | --- |
| [Seu próprio domínio](#seu-próprio-domínio) | `direct` | Você tem um domínio | TCP 443 e 80 |
| [DuckDNS](#duckdns) | `direct` | Sem domínio, internet de casa com IP que muda | TCP 443 e 80 |
| [sslip.io](#sslipio) | `direct` | Sem domínio, uma VPS com IP fixo | TCP 443 e 80 |
| [Cloudflare Tunnel](#cloudflare-tunnel) | `tunnel` | Redes que não conseguem abrir 80/443; precisa de um domínio na Cloudflare | nenhuma |
| [Seu próprio proxy reverso](#seu-próprio-proxy-reverso) | `external` | Você já roda nginx, Caddy, Traefik... | as do seu proxy |

No modo `direct`, o Caddy que vem junto pega um certificado Let's Encrypt para
o host do `PUBLIC_URL` e repassa tudo para o `LISTEN`. No modo `tunnel`, o
`cloudflared` leva as páginas e nenhum Caddy roda. No modo `external`, o seu
proxy faz os dois papéis.

O vídeo não passa por nenhum desses caminhos. O navegador manda a mídia direto
para o LiveKit pela TCP `MEDIA_TCP_PORT` (7881) e pela UDP `MEDIA_UDP_PORT`
(7882). Essas duas portas precisam chegar na máquina em qualquer modo, até com
túnel: veja [Quais portas](/telinha/pt-br/guides/port-forwarding/#quais-portas).

## Seu próprio domínio

Crie um registro A num nome que é seu, apontando para o IPv4 público da rede
onde a Telinha roda. Passo a passo: nas configurações de DNS da empresa onde
você comprou o domínio, adicione um registro do tipo `A`, nome `telinha` (o
que dá `telinha.seudominio.com.br`), valor o seu IP público (o assistente e o
`telinha doctor` mostram qual é). A mudança pode levar alguns minutos para
chegar a todo mundo. Depois:

```
PUBLIC_URL=https://telinha.example.com
INGRESS=direct
```

O Caddy pega o certificado sozinho assim que as portas TCP 80 e 443 chegam na
máquina. O `ACME_EMAIL` é opcional e dá ao Let's Encrypt um e-mail para avisos
de vencimento. O assistente e o `telinha doctor` (a verificação `dns`)
comparam o registro com o IP público e avisam quando eles não batem.

Se o IP da sua internet de casa muda, use o DNS dinâmico do seu provedor de
DNS, ou o DuckDNS logo abaixo.

## DuckDNS

De graça, acompanha o IP quando ele muda e funciona em qualquer máquina. No
duckdns.org: entre, adicione um subdomínio e copie o token que aparece no topo
da página.

```
PUBLIC_URL=https://my-group.duckdns.org
DDNS_PROVIDER=duckdns
DUCKDNS_DOMAIN=my-group
DUCKDNS_TOKEN='...'
```

O `DUCKDNS_DOMAIN` é só o subdomínio (`a-z`, `0-9`, `-`); se você colar com
`.duckdns.org`, o final é removido com um aviso. Um `PUBLIC_URL` em outro host
também gera aviso.

A Telinha atualiza o registro ao iniciar e depois consulta o IP público a cada
5 minutos. Ela atualiza o registro quando o IP mudou ou quando a última
atualização falhou, pelo menos uma vez por dia, e na hora quando a
[vigia de IP](#ip-dinâmico) percebe uma mudança. O log mostra
`ddns: my-group.duckdns.org -> 203.0.113.9`; o token nunca aparece no log. Com
`LIVEKIT_NODE_IP` definido, ela manda esse IP em vez de consultar.

## sslip.io

Sem domínio e com um IPv4 público fixo, o que na prática quer dizer uma VPS:
`https://203-0-113-9.sslip.io` resolve para `203.0.113.9` sem conta e sem
configurar nada. Coloque o IP também em `LIVEKIT_NODE_IP`:

```
PUBLIC_URL=https://203-0-113-9.sslip.io
LIVEKIT_NODE_IP=203.0.113.9
```

O assistente grava os dois e só oferece essa opção para VPS. O sslip.io é um
domínio compartilhado, e o Let's Encrypt limita quantos certificados emite por
domínio a cada semana; então um certificado pode ser recusado quando muitos já
foram emitidos para o sslip.io nos últimos dias. Domínio próprio ou DuckDNS é
mais confiável.

## Cloudflare Tunnel

Nenhuma porta web de entrada: o `cloudflared` abre uma conexão de saída até a
Cloudflare, que serve o seu hostname por ela. Serve para redes que não
conseguem encaminhar 80/443, e funciona em todas as builds (Windows on ARM
inclusive). Precisa de um domínio com o DNS na Cloudflare.

No painel da Cloudflare: Zero Trust → Networks → Tunnels → crie um túnel (tipo
cloudflared), copie o token e dê ao túnel um public hostname cujo service seja
`http://localhost:<porta do LISTEN>` (por padrão `http://localhost:8081`).

```
PUBLIC_URL=https://telinha.example.com
INGRESS=tunnel
TUNNEL_TOKEN='...'
```

As portas de mídia continuam precisando de encaminhamento: o túnel não leva
WebRTC. Se você escolheu o túnel porque nada da internet chega na sua rede,
leia antes [CGNAT e NAT duplo](#cgnat-e-nat-duplo).

## Seu próprio proxy reverso

`INGRESS=external`: o seu proxy termina o TLS e repassa para o `LISTEN`
(`127.0.0.1:8081` por padrão; se o proxy roda em outra máquina, coloque no
`LISTEN` um endereço que ele alcance e deixe essa porta fechada para a
internet). O proxy precisa:

- repassar o upgrade de WebSocket, pelo menos para o relay de sinalização em
  `/livekit/rtc`;
- definir o `X-Forwarded-For` (todo proxy conhecido já faz isso por padrão): a
  Telinha usa os cabeçalhos de encaminhamento para separar um pedido público
  ao `/healthz` de um local, e para manter o endpoint de controle só local.

A trava de login continua sendo da Telinha. O `/auth/check` continua
disponível se o seu proxy quiser um `forward_auth` próprio. Com o Caddy como
proxy, o padrão já faz tudo isso:

```
telinha.example.com {
	reverse_proxy 127.0.0.1:8081
}
```

Encaminhe as portas de mídia como em qualquer outro modo.

## Tradução de portas

Quando a 443 da máquina já está ocupada, ou quando uma instalação de usuário
no Linux não pode usar portas abaixo de 1024, o roteador pode traduzir: a 443
pública vai, por exemplo, para a 8443 da máquina.

```
PUBLIC_URL=https://telinha.example.com
HTTPS_PORT=8443
HTTP_PORT=0
```

O roteador encaminha a TCP 443 pública para a 8443 da máquina. Uma porta no
`PUBLIC_URL` diferente do `HTTPS_PORT` é só um aviso:
`config: PUBLIC_URL port 443 differs from HTTPS_PORT 8443; assuming the router translates 443 -> 8443`.
Com o UPnP ligado, a Telinha pede ao roteador exatamente essa tradução.

O `HTTP_PORT=0` desliga a porta HTTP (o redirecionamento para HTTPS). O Let's
Encrypt pode então validar por TLS na 443 (o desafio TLS-ALPN), então a porta
80 não precisa estar aberta. O assistente grava esses valores quando você
recusa o passo das portas baixas numa instalação de usuário no Linux; veja
[Rodando como serviço](/telinha/pt-br/guides/service/#linux-como-usuário).

## CGNAT e NAT duplo

Muitas internets residenciais dividem um único IPv4 público entre vários
clientes (o CGNAT, NAT da operadora): o endereço WAN do roteador fica em
`100.64.0.0/10`, e nada da internet chega na sua rede, nem com encaminhamento
de portas nem com UPnP. O `telinha doctor` detecta isso: a verificação `cgnat`
compara o IP externo do roteador, lido por UPnP, NAT-PMP ou PCP, com o IP que a
internet vê, e o assistente também avisa. Para testar na mão, veja
[É CGNAT?](/telinha/pt-br/guides/port-forwarding/#é-cgnat).

Um endereço WAN numa faixa privada (`10.x`, `172.16.x` a `172.31.x`,
`192.168.x`) quer dizer NAT duplo: tem um segundo roteador na frente do seu,
muitas vezes o modem da operadora. Encaminhe as portas nele também, ou coloque
um dos dois em modo bridge.

Um Cloudflare Tunnel faz as páginas passarem pelo CGNAT, mas as portas de
mídia não. As saídas:

- Pedir à operadora um IPv4 público. Muitas vezes é de graça; peça um "IP
  público" ou para "tirar do CGNAT".
- Rodar a Telinha numa [VPS](/telinha/pt-br/start/vps/) pequena, que tem IP
  público e nenhum roteador.

## IP dinâmico

O LiveKit descobre o IP público uma vez, ao iniciar (STUN), e passa esse IP
para os navegadores. Numa internet residencial a vigia de IP mantém isso
certo: ela pergunta o IP público para `https://1.1.1.1/cdn-cgi/trace` (e
depois para `https://api.ipify.org`) a cada `IP_WATCH_SECONDS` (300; `0`
desliga) e, quando o IP muda, renova os mapeamentos no roteador, avisa o
DuckDNS e reinicia o LiveKit:

```
public IP 203.0.113.9 -> 198.51.100.7, restarting livekit
```

Reiniciar o LiveKit só dá uma piscada nas salas abertas: a página pega um
token novo e entra de novo uma vez, e quem estava compartilhando precisa
compartilhar de novo. O nome no DNS também precisa seguir o IP novo, que é o
trabalho do DuckDNS ou do DNS dinâmico do seu provedor.

Com IP público fixo, coloque esse IP em `LIVEKIT_NODE_IP`: o LiveKit pula o
STUN e a vigia de IP fica desligada.
