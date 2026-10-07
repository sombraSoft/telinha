---
title: Oi Fibra
description: Como liberar as portas da Telinha nos modems da Oi Fibra, com os caminhos dos manuais que a Oi publica e o passo genérico para os outros modelos.
sidebar:
  order: 4
---

Esta página é para quem tem Oi Fibra e roda a Telinha num servidor em casa,
atrás do modem que a Oi instalou. Os nomes dos menus mudam conforme o modelo e
o firmware. O endereço da página de configuração, o usuário e a senha vêm na
etiqueta do aparelho.

A Oi publica, na página Manuais Digitais, os manuais de alguns modems: Huawei
HG8245Q2, HG8245W5-6T e HG8145V5, e Nokia G-140W-H, G-240W-C e G-2425G-A. Os
caminhos abaixo vêm desses manuais.

Fonte: [Manuais Digitais](https://www.oi.com.br/minha-oi/manuais-digitais/), Oi, acessado em 2026-10-06.

## Antes de começar

- Descubra o IP do computador na rede local e deixe esse IP fixo com uma
  reserva de DHCP:
  [Fixe o IP do computador](/telinha/pt-br/guides/port-forwarding/#fixe-o-ip-do-computador).
  Uma regra que aponta para um IP que muda para de funcionar de um dia para o
  outro.
- Estas são as portas que a Telinha usa por padrão
  ([detalhes](/telinha/pt-br/guides/port-forwarding/#quais-portas)):

| Protocolo | Porta | Quando |
| --- | --- | --- |
| TCP | 7881 | sempre |
| UDP | 7882 | sempre |
| TCP | 8443 | endereço do DuckDNS em casa; a sua porta, se você mudou |

Com um Cloudflare Tunnel, só as duas portas de mídia. Nada além disso, nem a 80
nem a 443: a internet de casa em geral não deixa as portas web 80 e 443
entrarem, então a Telinha não usa essas portas. Se você mudou `MEDIA_TCP_PORT`,
`MEDIA_UDP_PORT` ou `HTTPS_PORT` no `telinha.env`, use os seus valores.

## É CGNAT?

Se a operadora divide um IP público entre vários clientes (CGNAT), nada que
vem da internet chega na sua rede, e nenhuma regra no modem muda isso.
Confira antes de mexer no modem:

- Rode `telinha doctor`. Quando o modem responde UPnP, NAT-PMP ou PCP, a
  verificação `cgnat` falha se o IP externo do modem for de CGNAT e avisa se
  houver NAT duplo.
- Ou compare na mão o IP WAN (ou "Internet") da página de status do modem com
  o IP público que o `telinha doctor` mostra. Se forem diferentes, há um NAT na
  frente do seu modem; se o do modem estiver entre `100.64.0.0` e
  `100.127.255.255`, é CGNAT. O Tecnoblog (terceiros) descreve o mesmo teste e
  explica que o CGNAT não se desliga no modem: a saída é pedir um IP público à
  operadora, que aceita ou não conforme a política dela.

  Fonte: [O que é CGNAT?](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog, acessado em 2026-10-06.

O que os manuais e os usuários dizem:

- No Nokia G-240W-C, o usuário da etiqueta pode ver o menu "status", que
  inclui as telas "LAN" e "WAN".

  Fonte: [Guia de Instalação e Ativação da ONT NOKIA G-240W-C para Oi](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G240WC_MANUAL.pdf), Nokia, publicado pela Oi, acessado em 2026-10-06.

- Usuários relatam coisas diferentes: num tópico de 2021, um diz que todas as
  operadoras usam CGNAT e que é preciso abrir um chamado para ter IP público;
  outro diz que a Oi não aplicava CGNAT na internet fixa. Isso pode ter mudado:
  faça o teste de qualquer jeito.

  Fonte: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06.

Se der CGNAT, fale com o suporte da Oi e peça um IPv4 público (às vezes
chamado de "tirar do CGNAT" ou "tirar do NAT"). Outras saídas estão em
[CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo).

## UPnP

Com `UPNP=auto` (o padrão), a Telinha pede as portas ao modem sozinha.
Nenhum dos manuais publicados pela Oi descreve uma opção de UPnP.

Rode o `telinha doctor`: a verificação `gateway` diz se algum roteador
respondeu. Se nenhum respondeu, procure uma opção chamada UPnP nas
configurações avançadas, de NAT ou de rede do modem, ligue e salve; o nome e o
lugar mudam conforme o firmware. A Telinha procura o roteador de novo a cada
10 minutos, sem precisar reiniciar. Se não achar a opção, faça o
encaminhamento manual.

## Encaminhamento manual

Conecte o computador ao modem e abra no navegador o endereço que está na
etiqueta. Os manuais da Oi dão `192.168.1.254` nos modelos Nokia e usam
`192.168.100.1` como exemplo nos modelos Huawei; o usuário e a senha também
estão na etiqueta.

Fontes: manuais citados em cada modelo.

Crie uma regra por porta da tabela acima. Em qualquer modelo, depois de
salvar as regras, coloque `UPNP=off` no `telinha.env` e reinicie a Telinha,
para ela não tentar abrir portas que o modem já encaminha.

### Nokia G-2425G-A

1. Abra `https://192.168.1.254`. O navegador pode mostrar um aviso de
   certificado; o manual manda seguir para o site para abrir a tela de login.
   O usuário e a senha estão na etiqueta atrás do aparelho.
2. Vá no menu Application > Port forwarding.
3. Em "Wan Connection List", escolha a interface que tem "INTERNET" no nome.
   Em "Internal Client", ponha o IP fixo do computador.
4. Em "Application Name" há regras prontas para aplicativos conhecidos. Para
   a Telinha, crie regras próprias com o protocolo e as portas da tabela acima
   (o texto do manual não dá o nome desses campos).
5. Clique em "Add". O manual diz que a regra fica ativa na hora.

Fonte: [Guia de Configuração & Ativação de Campo para a ONT-HGW NOKIA 7368 G-2425G-A](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G2425GA_MANUAL.pdf), Nokia, publicado pela Oi, acessado em 2026-10-06.

### Nokia G-240W-C

O login fica em `http://192.168.1.254`. O manual diz que o usuário da
etiqueta tem restrições de configuração e, para ele, fala só das telas de
status. Se o menu de encaminhamento não aparecer com esse login, peça a
liberação das portas à Oi.

Fonte: [Guia de Instalação e Ativação da ONT NOKIA G-240W-C para Oi](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G240WC_MANUAL.pdf), Nokia, publicado pela Oi, acessado em 2026-10-06.

### Huawei HG8145V5 e HG8245W5-6T

Os guias da Oi para esses dois modelos explicam o que é encaminhamento de
portas, mas o texto não diz em que menu ele fica. O login usa o endereço, o
usuário e a senha da etiqueta (o exemplo do manual é `192.168.100.1`). O menu
costuma ficar nas configurações avançadas ou de NAT e se chama
redirecionamento de portas, servidor virtual ou mapeamento de portas; o nome
muda conforme o firmware.

Fontes: [Guia Rápido de Configuração HG8145V5](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8145V5_MANUAL.pdf), Huawei, publicado pela Oi, acessado em 2026-10-06; [Guia Rápido de Configuração HG8245W5-6T](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245W56T_MANUAL.pdf), Huawei, publicado pela Oi, acessado em 2026-10-06.

### Qualquer outro modelo

Os manuais do Huawei HG8245Q2 e do Nokia G-140W-H publicados pela Oi não
falam de encaminhamento de portas. Nesses e nos outros modelos, o menu costuma
ficar nas configurações avançadas ou de NAT e se chama redirecionamento de
portas, servidor virtual ou mapeamento de portas; o nome muda conforme o
firmware. Em cada regra vão um nome, o protocolo, a porta externa, o IP
interno (o IP fixo do computador) e a porta interna, com o mesmo número da
externa; depois salve ou aplique.

Fontes: [Guia Rápido de Configuração HG8245Q2](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245Q2_V1_26062018_MANUAL.pdf), Huawei, publicado pela Oi, acessado em 2026-10-06; [Guia Rápido de Configuração da ONTHGW NOKIA 7368 G-140W-H](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G140WH_MANUAL.pdf), Nokia, publicado pela Oi, acessado em 2026-10-06.

## Confira

```
telinha doctor
```

A verificação `mappings` lista as portas que o modem não encaminhou, com o
endereço para onde mandar cada uma; com `UPNP=off` ela é pulada e só mostra a
lista. Depois faça o teste pelo celular que o doctor oferece: nos dados
móveis, fora da sua rede, ele mede UDP e TCP separados. Se só o UDP falhar, a
regra da porta UDP está faltando ou errada; o vídeo ainda passa pelo TCP, com
mais atraso. Como ler cada resultado:
[Doctor e solução de problemas](/telinha/pt-br/guides/doctor/).

## Fontes

- [Manuais Digitais](https://www.oi.com.br/minha-oi/manuais-digitais/), Oi, acessado em 2026-10-06
- [Guia de Configuração & Ativação de Campo para a ONT-HGW NOKIA 7368 G-2425G-A](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G2425GA_MANUAL.pdf), Nokia, publicado pela Oi, acessado em 2026-10-06
- [Guia de Instalação e Ativação da ONT NOKIA G-240W-C para Oi](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G240WC_MANUAL.pdf), Nokia, publicado pela Oi, acessado em 2026-10-06
- [Guia Rápido de Configuração da ONTHGW NOKIA 7368 G-140W-H](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G140WH_MANUAL.pdf), Nokia, publicado pela Oi, acessado em 2026-10-06
- [Guia Rápido de Configuração HG8145V5](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8145V5_MANUAL.pdf), Huawei, publicado pela Oi, acessado em 2026-10-06
- [Guia Rápido de Configuração HG8245W5-6T](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245W56T_MANUAL.pdf), Huawei, publicado pela Oi, acessado em 2026-10-06
- [Guia Rápido de Configuração HG8245Q2](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245Q2_V1_26062018_MANUAL.pdf), Huawei, publicado pela Oi, acessado em 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (terceiros), acessado em 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06
