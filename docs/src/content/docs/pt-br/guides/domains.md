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

O assistente pergunta primeiro *Onde a Telinha vai rodar?*, e as opções
dependem da resposta. O `HOSTING` no `telinha.env` guarda isso (`home` ou
`vps`).

**Em casa** ele pergunta *Você tem um domínio na Cloudflare?* A internet de
casa em geral não deixa as portas web 80 e 443 entrarem, então ali a Telinha
nunca conta com elas:

| Resposta | Opção | `INGRESS` | Portas a encaminhar pras páginas |
| --- | --- | --- | --- |
| Sim | [Cloudflare Tunnel](#cloudflare-tunnel) | `tunnel` | nenhuma |
| Não | [DuckDNS na porta 8443](#duckdns-na-porta-8443) | `direct` | TCP 8443 |

**Numa VPS** ele pergunta *Como o pessoal vai chegar na Telinha?* Uma VPS tem
a 80 e a 443 só dela:

| Opção | `INGRESS` | Serve para | Portas web de entrada |
| --- | --- | --- | --- |
| [Seu próprio domínio](#seu-próprio-domínio) | `direct` | Você tem um domínio | TCP 443 e 80 |
| [DuckDNS](#duckdns) | `direct` | Sem domínio, um nome grátis | TCP 443 e 80 |
| [sslip.io](#sslipio) | `direct` | Sem domínio e sem conta | TCP 443 e 80 |
| [Cloudflare Tunnel](#cloudflare-tunnel) | `tunnel` | Um domínio na Cloudflare, sem portas web abertas | nenhuma |
| [Seu próprio proxy reverso](#seu-próprio-proxy-reverso) | `external` | Você já roda nginx, Caddy, Traefik... | as do seu proxy |

No modo `direct`, o Caddy que vem junto pega um certificado Let's Encrypt para
o host do `PUBLIC_URL` e repassa tudo para o `LISTEN`. No modo `tunnel`, o
`cloudflared` leva as páginas e nenhum Caddy roda. No modo `external`, o seu
proxy faz os dois papéis.

O vídeo não passa por nenhum desses caminhos. O navegador manda a mídia direto
para o LiveKit pela TCP `MEDIA_TCP_PORT` (7881) e pela UDP `MEDIA_UDP_PORT`
(7882). Essas duas portas precisam chegar na máquina em qualquer modo, até com
túnel: veja [Quais portas](/telinha/pt-br/guides/port-forwarding/#quais-portas).

## Em casa

### Cloudflare Tunnel

A escolha de casa quando você tem um domínio na Cloudflare, e uma opção numa
VPS também. Nenhuma porta web de entrada: o `cloudflared` abre uma conexão de
saída até a Cloudflare, que serve o seu hostname por ela. O endereço não tem
porta, então abre de qualquer rede, e funciona em todas as builds (Windows on
ARM inclusive). Precisa de um domínio com o DNS na Cloudflare.

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

### DuckDNS na porta 8443

A escolha de casa sem domínio. O DuckDNS dá um `<name>.duckdns.org` grátis
que acompanha o seu IP quando ele muda. No duckdns.org: entre, adicione um
subdomínio e copie o token que aparece no topo da página. O assistente testa o
token na hora e grava:

```
PUBLIC_URL=https://my-group.duckdns.org:8443
INGRESS=direct
HTTPS_PORT=8443
HTTP_PORT=0
ACME_DNS=duckdns
DDNS_PROVIDER=duckdns
DUCKDNS_DOMAIN=my-group
DUCKDNS_TOKEN='...'
```

A Telinha serve HTTPS numa porta própria, a 8443 a não ser que você escolha
outra (1024-65535), e o endereço leva essa porta. O Let's Encrypt pede uma
prova de que você controla o nome; com `ACME_DNS=duckdns` o Caddy dá essa
prova pela API do DuckDNS, criando um registro TXT com o seu token (o desafio
de DNS), então nenhuma conexão do Let's Encrypt precisa chegar na sua rede e
nada escuta na 80 ou na 443. O roteador encaminha só a TCP 8443, junto com as
portas de mídia, e o UPnP consegue fazer isso.

Os links levam a porta, tipo `https://my-group.duckdns.org:8443/r/...`.
Algumas redes rígidas (empresas, escolas) só deixam o navegador chegar na
porta 443, então quem estiver nelas não abre; um domínio na Cloudflare
([Cloudflare Tunnel](#cloudflare-tunnel)) não tem essa limitação.

O primeiro certificado costuma levar de 1 a 3 minutos: o Caddy cria o
registro, espera o DNS público mostrar o registro, e aí o Let's Encrypt
confere. No log, as linhas do Caddy começam com `[caddy]`; procure
`trying to solve challenge` com `dns-01` e depois
`certificate obtained successfully`. O token nunca aparece ali: o Caddy recebe
o token pelo ambiente, o `Caddyfile` gerado só tem um marcador no lugar dele, e
a Telinha apaga o token da saída do Caddy. O certificado precisa do Caddy que a
Telinha baixa ou traz junto, que tem o módulo do DuckDNS; o `telinha doctor`
confere isso (a linha `binaries`) e mostra o método na linha `certificate`.

A Telinha também mantém o nome apontando para a sua rede. Ela atualiza o
registro ao iniciar e depois consulta o IP público a cada 5 minutos. Ela
atualiza o registro quando o IP mudou ou quando a última atualização falhou,
pelo menos uma vez por dia, e na hora quando a [vigia de IP](#ip-dinâmico)
percebe uma mudança. O log mostra `ddns: my-group.duckdns.org -> 203.0.113.9`.

O `DUCKDNS_DOMAIN` é só o subdomínio (`a-z`, `0-9`, `-`); se você colar com
`.duckdns.org`, o final é removido com um aviso. Com `ACME_DNS=duckdns`, o host
do `PUBLIC_URL` precisa estar sob `duckdns.org`: o DuckDNS só cria registros
para os nomes dele.

## Numa VPS

Uma VPS tem IP público próprio e nada na frente dela além do firewall do
provedor, então com as três primeiras opções abaixo o Caddy pega o certificado
do jeito de sempre, pelas portas 80 e 443, que você abre nesse firewall. O
[Cloudflare Tunnel](#cloudflare-tunnel) funciona numa VPS igualzinho a em casa.

### Seu próprio domínio

Crie um registro A num nome que é seu, apontando para o IPv4 público do
servidor. Passo a passo: nas configurações de DNS da empresa onde você comprou
o domínio, adicione um registro do tipo `A`, nome `telinha` (o que dá
`telinha.seudominio.com.br`), valor o IP público do servidor (o assistente e o
`telinha doctor` mostram qual é). A mudança pode levar alguns minutos para
chegar a todo mundo. Depois:

```
PUBLIC_URL=https://telinha.example.com
INGRESS=direct
```

O Caddy pega o certificado sozinho assim que as portas TCP 80 e 443 chegam no
servidor. O `ACME_EMAIL` é opcional e dá ao Let's Encrypt um e-mail para avisos
de vencimento. O assistente e o `telinha doctor` (a verificação `dns`)
comparam o registro com o IP público e avisam quando eles não batem.

### DuckDNS

Um nome grátis no lugar de um domínio, na 443 como o seu próprio domínio, sem
porta no endereço:

```
PUBLIC_URL=https://my-group.duckdns.org
DDNS_PROVIDER=duckdns
DUCKDNS_DOMAIN=my-group
DUCKDNS_TOKEN='...'
```

A Telinha mantém o registro apontando para o servidor como descrito em
[DuckDNS na porta 8443](#duckdns-na-porta-8443). Com `LIVEKIT_NODE_IP`
definido, ela manda esse IP em vez de consultar.

### sslip.io

Sem domínio e com um IPv4 público fixo:
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

### Seu próprio proxy reverso

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

## Avançado: portas 80 e 443 em casa

A pergunta de casa do assistente tem uma terceira resposta, *Avançado*, para
dois casos que ele nunca escolhe sozinho: você mesmo abriu as portas 80 e 443
no roteador pra esta máquina, ou você tem o seu próprio proxy reverso. No
primeiro caso, a Telinha grava os valores de VPS (`HTTP_PORT=80`,
`HTTPS_PORT=443`, sem `ACME_DNS`) para o seu próprio domínio ou o DuckDNS e
pega o certificado por essas portas, mas nunca pede essas portas pro roteador:
mantenha o redirecionamento por sua conta. Um `telinha setup` não interativo
em casa precisa de `--advanced` para gravar qualquer um dos dois, e o
`telinha doctor` mostra isso na linha `certificate` como uma observação, não
como um aviso.

Se o roteador traduz em vez disso (a 443 pública para outra porta da
máquina), coloque essa porta no `HTTPS_PORT` e deixe o `PUBLIC_URL` sem ela.
Uma porta no `PUBLIC_URL` diferente do `HTTPS_PORT` é só um aviso:
`config: PUBLIC_URL port 443 differs from HTTPS_PORT 8443; assuming the router translates 443 -> 8443`.
Com `HTTP_PORT=0`, o Let's Encrypt então valida por TLS na 443 pública (o
desafio TLS-ALPN). Um `PUBLIC_URL` numa porta que não é a 443, sem
`ACME_DNS=duckdns`, é recusado quando `HTTP_PORT=0`, porque o Let's Encrypt
só se conecta na 80 ou na 443 públicas.

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
