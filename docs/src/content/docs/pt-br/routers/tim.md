---
title: TIM Ultrafibra
description: Como liberar as portas da Telinha nos modems da TIM Ultrafibra, com os caminhos dos manuais que a TIM publica e o passo genérico para os outros modelos.
sidebar:
  order: 3
---

Esta página é para quem tem TIM Ultrafibra e roda a Telinha num servidor em
casa, atrás do modem que a TIM instalou. Os nomes dos menus mudam conforme o
modelo e o firmware. A senha da página de configuração vem impressa na
etiqueta do aparelho.

A TIM publica, no Guia TIM Ultrafibra, os manuais de alguns modems: ZTE ZXHN
F6600P, Huawei OptiXstar HG8145X6-10, Blu-Castle BCSKV630, Blu-Castle
BC-UM221E, Kaon PG2447 e Sagemcom F@st5670. Os caminhos abaixo vêm desses
manuais.

Fonte: [Guia TIM Ultrafibra: Suporte, 2ª Via, Funcionalidades e Benefícios](https://www.tim.com.br/internet/guia-funcionalidades-tim-ultrafibra), TIM, acessado em 2026-10-06.

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

O que a TIM e os manuais dizem:

- Pelas perguntas frequentes da TIM, os planos residenciais da TIM Ultrafibra
  têm IP dinâmico, fornecido pela TIM, e os planos para empresas têm IP fixo.
  A Telinha não precisa de IP fixo: ela acompanha a troca de IP sozinha
  ([Endereço, HTTPS e modos de entrada](/telinha/pt-br/guides/domains/)).

  Fonte: [Suporte e dicas TIM Fibra: dúvidas frequentes](https://www.tim.com.br/ajuda/perguntas-frequentes/internet-e-telefone-fixo/tim-fibra/suporte-e-dicas), TIM, acessado em 2026-10-06.

- No Blu-Castle BCSKV630, o IP WAN fica em Status / Wan Info.

  Fonte: [Manual Técnico – CPE BCSKV630](https://timbrasil.widen.net/view/pdf/yrmwa5vu1i/Manual-Tecnico---Blu-Castle---BCSKV630_TIM.pdf?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06.

- Usuários relatam coisas diferentes: num tópico de 2021, um diz que todas as
  operadoras usam CGNAT e que é preciso abrir um chamado para ter IP público;
  outro diz que a TIM não aplicava CGNAT na internet fixa. Isso pode ter
  mudado: faça o teste de qualquer jeito.

  Fonte: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06.

Se der CGNAT, fale com o suporte da TIM e peça um IPv4 público (às vezes
chamado de "tirar do CGNAT" ou "tirar do NAT"). Outras saídas estão em
[CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo).

## UPnP

Com `UPNP=auto` (o padrão), a Telinha pede as portas ao modem sozinha.
Nenhum dos manuais publicados pela TIM descreve uma opção de UPnP.

Rode o `telinha doctor`: a verificação `gateway` diz se algum roteador
respondeu. Se nenhum respondeu, procure uma opção chamada UPnP nas
configurações avançadas, de NAT ou de rede do modem, ligue e salve; o nome e o
lugar mudam conforme o firmware. A Telinha procura o roteador de novo a cada
10 minutos, sem precisar reiniciar. Se não achar a opção, faça o
encaminhamento manual.

## Encaminhamento manual

Para liberar uma porta, as perguntas frequentes da TIM mandam falar com a
Central de Relacionamento da TIM. Você pode pedir por lá ou fazer você mesmo,
nos modelos abaixo.

Fonte: [Suporte e dicas TIM Fibra: dúvidas frequentes](https://www.tim.com.br/ajuda/perguntas-frequentes/internet-e-telefone-fixo/tim-fibra/suporte-e-dicas), TIM, acessado em 2026-10-06.

O Guia TIM Ultrafibra manda abrir `192.168.1.1` no navegador, com o computador
ligado ao modem por cabo, e entrar com o usuário `admin`. Os manuais dos
modelos abaixo dizem que a senha é única de cada aparelho e está na etiqueta
atrás dele, e que a interface completa fica em `192.168.1.1/normal`.

Fontes: [Guia TIM Ultrafibra](https://www.tim.com.br/internet/guia-funcionalidades-tim-ultrafibra), TIM, acessado em 2026-10-06; manuais citados em cada modelo.

Crie uma regra por porta da tabela acima. Em qualquer modelo, depois de
salvar as regras, coloque `UPNP=off` no `telinha.env` e reinicie a Telinha,
para ela não tentar abrir portas que o modem já encaminha.

### Kaon PG2447

1. Entre em `192.168.1.1/normal` com o usuário `admin` e a senha da etiqueta.
2. No menu principal, vá em Security > NAT > Port Forwarding.
3. Para criar uma regra nova, preencha "Application Name" (um nome), "WAN
   Interface" (a interface WAN a usar), "Server IP Address" (o IP fixo do
   computador), o protocolo e as portas. Para uma porta só, o manual manda
   repetir o mesmo número em "External/Internal Port Start" e
   "External/Internal Port End".
4. Clique em "Apply". As regras criadas aparecem abaixo do botão.

Fonte: [Manual Técnico – CPE Kaon PG2447](https://timbrasil.widen.net/view/pdf/rlqmqs0rbx/Manual-Tecnico---Kaon-PG2447_v1.1.docx?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06.

### Blu-Castle BCSKV630

1. Em `192.168.1.1`, com o usuário `admin` e a senha da etiqueta, abre o
   assistente da TIM; a interface completa fica em `192.168.1.1/normal`.
2. Vá no menu Advanced > Port Forwarding.
3. O manual não descreve os campos da regra; preencha o nome, o protocolo, as
   portas e o IP fixo do computador como na tabela acima e salve.

Fonte: [Manual Técnico – CPE BCSKV630](https://timbrasil.widen.net/view/pdf/yrmwa5vu1i/Manual-Tecnico---Blu-Castle---BCSKV630_TIM.pdf?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06.

### Blu-Castle BC-UM221E

O manual descreve o encaminhamento de portas só com um login diferente do que
está na etiqueta. Com o login da etiqueta, peça a liberação das portas à TIM.

Fonte: [Manual Técnico – CPE BLU-CASTLE BC-UM221E](https://timbrasil.widen.net/view/pdf/ficbxvroqn/Manual-Tecnico---Blu-Castle-BC-UM221E_v1.pdf?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06.

### Qualquer outro modelo

Os manuais do ZTE ZXHN F6600P, do Huawei OptiXstar HG8145X6-10 (um guia
rápido) e do Sagemcom F@st5670 publicados pela TIM não falam de encaminhamento
de portas. Nesses e nos outros modelos, o menu costuma ficar nas configurações
avançadas ou de NAT e se chama redirecionamento de portas, servidor virtual ou
mapeamento de portas; o nome muda conforme o firmware. Em cada regra vão um
nome, o protocolo, a porta externa, o IP interno (o IP fixo do computador) e a
porta interna, com o mesmo número da externa; depois salve ou aplique.

Fontes: [ZXHN F6600P GPON ONT User Manual](https://timbrasil.widen.net/view/pdf/b4c2t2irwv/F6600P_Manual-Tecnico-Completo---SJ--20211014111546-001-ZXHN-F6600PV9.0User-Manual1FXS1USB.pdf?t.download=true&u=vv6x5q), ZTE, publicado pela TIM; [Huawei OptiXstar HG8145X6-10 Quick Start](https://timbrasil.widen.net/view/pdf/anqg0u47w8/Huawei-OptiXstar-HG8145X6-10-Quick-Start-for-QR-code-01.pdf?t.download=true&u=vv6x5q), Huawei, publicado pela TIM; [Manual Técnico – CPE Sagemcom F@st5670](https://timbrasil.widen.net/view/pdf/mdyr7akctz/Manual-Tecnico-Completo---Sagemcom-Fst-5670.pdf?t.download=true&u=vv6x5q), TIM; todos acessados em 2026-10-06.

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

- [Guia TIM Ultrafibra: Suporte, 2ª Via, Funcionalidades e Benefícios](https://www.tim.com.br/internet/guia-funcionalidades-tim-ultrafibra), TIM, acessado em 2026-10-06
- [Suporte e dicas TIM Fibra: dúvidas frequentes](https://www.tim.com.br/ajuda/perguntas-frequentes/internet-e-telefone-fixo/tim-fibra/suporte-e-dicas), TIM, acessado em 2026-10-06
- [Manual Técnico – CPE Kaon PG2447](https://timbrasil.widen.net/view/pdf/rlqmqs0rbx/Manual-Tecnico---Kaon-PG2447_v1.1.docx?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06
- [Manual Técnico – CPE BCSKV630](https://timbrasil.widen.net/view/pdf/yrmwa5vu1i/Manual-Tecnico---Blu-Castle---BCSKV630_TIM.pdf?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06
- [Manual Técnico – CPE BLU-CASTLE BC-UM221E](https://timbrasil.widen.net/view/pdf/ficbxvroqn/Manual-Tecnico---Blu-Castle-BC-UM221E_v1.pdf?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06
- [ZXHN F6600P GPON ONT User Manual](https://timbrasil.widen.net/view/pdf/b4c2t2irwv/F6600P_Manual-Tecnico-Completo---SJ--20211014111546-001-ZXHN-F6600PV9.0User-Manual1FXS1USB.pdf?t.download=true&u=vv6x5q), ZTE, publicado pela TIM, acessado em 2026-10-06
- [Huawei OptiXstar HG8145X6-10 Quick Start](https://timbrasil.widen.net/view/pdf/anqg0u47w8/Huawei-OptiXstar-HG8145X6-10-Quick-Start-for-QR-code-01.pdf?t.download=true&u=vv6x5q), Huawei, publicado pela TIM, acessado em 2026-10-06
- [Manual Técnico – CPE Sagemcom F@st5670](https://timbrasil.widen.net/view/pdf/mdyr7akctz/Manual-Tecnico-Completo---Sagemcom-Fst-5670.pdf?t.download=true&u=vv6x5q), TIM, acessado em 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (terceiros), acessado em 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06
