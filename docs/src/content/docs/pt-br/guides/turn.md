---
title: TURN sobre TLS na porta 443
description: Como uma instalação em VPS retransmite o vídeo por turn.<host> na porta 443 para quem está numa rede que só libera a 443, e como ligar, conferir e desligar.
sidebar:
  order: 9
---

Algumas redes só deixam o navegador chegar na porta TCP 443: empresas,
escolas, algumas operadoras de celular e Wi-Fi públicos. Nelas a página da
sala abre (é HTTPS na 443), mas o vídeo nunca conecta, porque o WebRTC quer a
UDP `MEDIA_UDP_PORT` ou a TCP `MEDIA_TCP_PORT`. O TURN é o jeito padrão do
WebRTC de contornar isso: o navegador manda a mídia por um servidor de
retransmissão, aqui por uma conexão TLS até `turn.<host>:443`, que para a rede
parece um site HTTPS qualquer. O LiveKit tem um servidor TURN embutido, e numa
VPS a Telinha coloca ele atrás da mesma porta 443 das páginas.

O navegador só retransmite quando um caminho direto falha, então para todo o
resto nada muda.

## Quem tem

O TURN sobre TLS roda numa VPS no modo direct na porta 443:

- `MEDIA=self` (com `MEDIA=cloud`, o
  [LiveKit Cloud](/telinha/pt-br/guides/livekit-cloud/) traz o TURN dele);
- `INGRESS=direct`, porque o Caddy precisa ser o dono da porta 443;
- uma VPS: `HOSTING` diferente de `home`;
- `HTTPS_PORT=443` e uma `PUBLIC_URL` sem porta, porque o LiveKit sempre
  informa `turn.<host>:443` aos navegadores;
- um nome DNS na `PUBLIC_URL`, não um endereço IP.

Instalações em casa não têm TURN: a internet de casa não deixa a porta 443
entrar. Para quem assiste de redes rígidas com a Telinha em casa, use o
[LiveKit Cloud](/telinha/pt-br/guides/livekit-cloud/).

`TURN=on` onde uma dessas condições não vale impede a inicialização com o
motivo, por exemplo:

```
TURN=on is not possible here: it needs INGRESS=direct (Caddy must own port 443). TURN over TLS on 443 is for a VPS in direct mode on port 443.
```

Os outros motivos que ele dá são
`MEDIA=cloud brings LiveKit Cloud's own TURN`,
`home installs get no TURN: home connections do not let port 443 in`,
`it needs HTTPS on port 443 (HTTPS_PORT=443 and a PUBLIC_URL without a port)`
e `it needs a DNS name in PUBLIC_URL (turn.<host> must resolve)`.

## Como funciona

```
browser --> turn.<host>:443   TLS, the name (SNI) says turn.<host>
  --> caddy :443, layer4: matches the name, terminates TLS with its turn.<host> certificate
  --> PROXY protocol v2 header + plain TCP
  --> LiveKit TURN 127.0.0.1:5349 (TURN_PORT)  --> relay --> LiveKit SFU, same machine

any other name on :443 --> caddy's HTTPS sites, as always
```

- O listener do Caddy na 443 lê o nome que cada conexão nova pede (SNI) antes
  de qualquer outra coisa. Uma conexão para `turn.<host>` é separada pelo
  módulo layer4 do build do Caddy da Telinha; todas as outras seguem para as
  páginas.
- O Caddy termina o TLS dela com o certificado que ele mantém para
  `turn.<host>`, obtido e renovado do mesmo jeito que o do endereço principal.
- O Caddy entrega o fluxo decifrado, TCP puro, ao servidor TURN do LiveKit na
  `TURN_PORT` (5349), que roda sem TLS próprio (o `external_tls` do LiveKit).
- Como o Caddy se conecta da mesma máquina, o LiveKit veria todo mundo como
  `127.0.0.1`. Por isso o Caddy põe na frente do fluxo um cabeçalho PROXY
  protocol com o endereço real do celular, e o TURN do LiveKit lê esse
  cabeçalho: assim ele informa ao navegador o endereço real dele, e não o
  loopback da VPS, que alguns navegadores (o Firefox, por exemplo) rejeitam.
- O LiveKit põe `turns:turn.<host>:443?transport=tcp` na lista de servidores
  que entrega a cada navegador. O navegador tenta primeiro os caminhos diretos
  por UDP e TCP e só cai na retransmissão quando eles falham.

## DNS

O `turn.<host>` precisa resolver para a VPS, o mesmo IP do host da
`PUBLIC_URL`:

- **DuckDNS**: nada a fazer. O DuckDNS responde por todos os nomes abaixo do
  seu, então `turn.my-group.duckdns.org` já resolve para o mesmo IP de
  `my-group.duckdns.org`.
- **sslip.io**: nada a fazer. `turn.203-0-113-9.sslip.io` resolve para
  `203.0.113.9`, igual ao próprio endereço.
- **Domínio próprio**: crie um registro A. Com
  `PUBLIC_URL=https://telinha.example.com`, crie um registro do tipo `A`, nome
  `turn.telinha` (o que dá `turn.telinha.example.com`), valor o IPv4 público
  da VPS, nas mesmas configurações de DNS do primeiro registro.

## Como ligar

`TURN=auto`, o padrão, liga só numa instalação de VPS (`HOSTING=vps`, que o
setup escreve) com um nome do DuckDNS ou do sslip.io, onde o `turn.<host>`
resolve sem trabalho nenhum do seu lado. Ali ele simplesmente está ligado.

Com domínio próprio, ou com um `telinha.env` sem `HOSTING` (escrito à mão, ou
uma instalação Docker que recebeu as chaves por `-e`), ele fica desligado: senão
o Caddy ficaria pedindo ao Let's Encrypt um certificado para um nome que ainda
não existe. Crie o registro DNS primeiro, depois ponha:

```
TURN=on
```

no `telinha.env` e reinicie (`telinha service restart`), ou rode o
`telinha setup` e responda sim a *Também passar o vídeo pela porta 443 para
redes rígidas?* no passo Vídeo (ele mostra o registro a criar e confere se ele
resolve), ou `telinha setup --non-interactive --turn on`. Numa VPS com domínio próprio, a
linha `turn` do `telinha doctor` lembra os dois passos, com o registro a
criar.

Ligado, a linha de início da Telinha no log termina com `turn=turn.<host>`. A
`TURN_PORT` (5349) é a porta local entre o Caddy e o LiveKit; mude só quando
outra coisa na máquina usar a 5349.

## Firewall

Nada novo para abrir: o TURN chega pela 443, que já está aberta para as
páginas.

A `TURN_PORT` escuta em todas as interfaces (o LiveKit liga o TURN e a
retransmissão aos mesmos endereços), mas o LiveKit só aceita nela as conexões
que vêm do Caddy na mesma máquina, com o cabeçalho PROXY, e fecha na hora
qualquer outra. Mantenha a porta fechada no firewall do provedor e no ufw ou
firewalld mesmo assim, junto com a UDP 30000-40000, a faixa de sockets de
retransmissão que o TURN do LiveKit usa para chegar no próprio SFU do LiveKit
na máquina. Nada de fora precisa de nenhuma das duas.

## Verifique

```
telinha doctor
```

A linha **TURN sobre TLS** (`turn`) confere as peças:

1. o `turn.<host>` resolve para o IP público (ou para o `LIVEKIT_NODE_IP`);
2. o `turn.<host>:443` apresenta um certificado válido;
3. o TURN do LiveKit está escutando em `127.0.0.1:<TURN_PORT>`.

Quando as três passam, ela diz isso, e que se um celular consegue retransmitir
é o que o teste pelo celular mostra. O passo 3 só abre e fecha uma conexão,
então o LiveKit pode registrar no log uma conexão recusada a cada vez que o
doctor roda. A linha **Portas locais** mostra a mesma porta local como
`TURN (TURN_PORT)`.

A retransmissão em si é provada pelo **teste pelo celular**: com o TURN ligado
ele ganha um último passo, *TURN sobre TLS na 443* no celular e **TURN/TLS
443** no terminal, que força a conexão por `turn.<host>:443` e confere se a
mídia foi retransmitida por TLS. Uma falha ali é um aviso, não uma falha do
teste inteiro (os caminhos diretos podem estar funcionando); olhe a linha
`turn` para o registro DNS e o certificado. Veja
[Doctor e solução de problemas](/telinha/pt-br/guides/doctor/#o-teste-pelo-celular).

## Como desligar

Ponha `TURN=off` no `telinha.env` e reinicie, ou responda não à pergunta do
TURN no `telinha setup`, ou rode `telinha setup --non-interactive --turn off`. Aí o Caddy para de separar o
`turn.<host>` e o LiveKit para de oferecer a retransmissão; quem está numa
rede rígida perde o vídeo, e o resto não percebe nada.
