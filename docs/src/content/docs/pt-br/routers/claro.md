---
title: Claro (NET)
description: Como liberar as portas da Telinha nos modems da Claro, com os caminhos dos manuais que a Claro publica e o passo genérico para os outros modelos.
sidebar:
  order: 2
---

Esta página é para quem tem internet fixa da Claro (NET) e roda a Telinha num
servidor em casa, atrás do modem que a Claro instalou. A Claro usa muitos
modelos de modem, e os nomes dos menus mudam conforme o modelo e o firmware.
O login e a senha da página de configuração vêm impressos numa etiqueta no
próprio aparelho.

O site de configuração de aparelhos da Claro tem uma lista de modems Wi-Fi,
com páginas por modelo; procure o seu ali. A Claro também publica no próprio
site o manual de alguns modelos, e os caminhos abaixo vêm de três deles.

Fonte: [Escolha um tipo de aparelho: Modem Wi-Fi](https://configuraraparelhos.claro.com.br/tipos-de-aparelhos/internet-fixa/Modem-WiFi), Claro, acessado em 2026-10-06.

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

Onde os manuais publicados pela Claro mostram o IP WAN:

- Humax HGJ310: Status > Conexão IP, campo "Endereço IPv4".

  Fonte: [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, publicado pela Claro, acessado em 2026-10-06.

- Technicolor TC3102: menu Conexão > WAN, que "exibe as informações sobre
  seus endereços IP públicos".

  Fonte: [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, publicado pela Claro, acessado em 2026-10-06.

O que usuários relatam sobre a Claro:

- Num tópico de 2021, usuários dizem que na Claro o CGNAT varia conforme a
  localidade, e que quem caiu em NAT duplo e reclamou com uma boa justificativa
  conseguiu um IPv4 válido, com algum trabalho.

  Fonte: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06.

- Num tópico de 2023, um usuário da Claro estava atrás de CGNAT, e a resposta
  aceita foi pedir ao suporte a volta para IP público; quem respondeu avisa que
  isso depende de quem atende e de a Claro ter IPv4 disponível.

  Fonte: [Configuração Banda Larga Claro/NET](https://tecnoblog.net/comunidade/t/configuracao-banda-larga-claro-net/82446), Tecnoblog Comunidade (fórum), acessado em 2026-10-06.

Se der CGNAT, fale com o suporte da Claro e peça um IPv4 público (às vezes
chamado de "tirar do CGNAT" ou "tirar do NAT"). Outras saídas estão em
[CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo).

## UPnP

Com `UPNP=auto` (o padrão), a Telinha pede as portas ao modem sozinha. Rode o
`telinha doctor`: a verificação `gateway` diz se algum roteador respondeu. Se
nenhum respondeu, ligue o UPnP no modem; a Telinha procura de novo a cada 10
minutos, sem precisar reiniciar.

- Humax HGJ310: Avançado > Opções avançadas, opção "UPNP ATIVAR", depois
  "APLICAR AJUSTES".

  Fonte: [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, publicado pela Claro, acessado em 2026-10-06.

- Humax HP610: AVANÇADO > UPnP tem as configurações do UPnP e a "Tabela de
  Mapeamento de Porta UPnP", onde aparecem as portas abertas por UPnP; é um
  bom lugar para ver se as portas da Telinha entraram.

  Fonte: [HP610 Manual do Usuário](https://www.claro.com.br/files/104379/x/3cdf74534e/manuais-equipamentos-humax-hp610.pdf), Humax, publicado pela Claro, acessado em 2026-10-06.

- Technicolor TC3102: menu Solicitação > UPnP, onde o recurso é habilitado.

  Fonte: [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, publicado pela Claro, acessado em 2026-10-06.

Nos outros modelos, procure uma opção chamada UPnP nas configurações
avançadas, de NAT ou de rede; o nome e o lugar mudam conforme o firmware.

## Encaminhamento manual

Com o computador conectado ao modem (por cabo ou pelo Wi-Fi dele), abra
`192.168.0.1` no navegador e entre com o login e a senha da etiqueta do
aparelho. As páginas da Claro para os modelos consultados indicam esse
endereço; se a página não abrir, a Claro sugere digitar `http://192.168.0.1`.

Fontes: [Como acessar as configurações do modem Wi-Fi pelo computador (F@st 3486)](https://configuraraparelhos.claro.com.br/sagemcom/f-st-3486/funcoes-basicas/como-acessar-as-configuracoes-do-modem-wi-fi-pelo-computador), Claro, acessado em 2026-10-06; [Onde localizar as informações de acesso do modem Wi-Fi (F680)](https://configuraraparelhos.claro.com.br/zte/f680/primeiros-passos/onde-localizar-as-informacoes-de-acesso-do-modem-wi-fi), Claro, acessado em 2026-10-06.

Crie uma regra por porta da tabela acima. Em qualquer modelo, depois de
salvar as regras, coloque `UPNP=off` no `telinha.env` e reinicie a Telinha,
para ela não tentar abrir portas que o modem já encaminha.

### Humax HGJ310

1. Depois do login aparece a tela de configuração rápida; clique em
   "Configurações avançadas".
2. No menu, vá em Avançado > Encaminhamento de porta e clique em "CRIAR".
3. Deixe "Selecione um serviço" desmarcado e preencha: "Serviço Customizado"
   (um nome), "Endereço IP do Servidor" (o IP fixo do computador), "Porta
   externa inicial" e "Porta externa final" (a porta), "Protocolo" (TCP ou
   UDP), "Porta inicial interna" e "Porta final interna" (o mesmo número).
4. Clique em "APLICAR AJUSTES".

Fonte: [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, publicado pela Claro, acessado em 2026-10-06.

### Humax HP610

1. No menu, vá em AVANÇADO > Encaminhamento de Porta/DMZ.
2. Em "Encaminhamento de porta", clique em "ADICIONAR" e preencha: "Tipo de
   Serviço", "Endereço IP" (o IP fixo do computador; o próprio manual recomenda
   IP fixo), "Porta Local (Inicial-Final)" e "Porta Externa (Inicial-Final)"
   (a porta, com o mesmo número nos dois) e "Protocolo" (TCP ou UDP).
3. Clique em "Salvar" e depois em "Aplicar".

Fonte: [HP610 Manual do Usuário](https://www.claro.com.br/files/104379/x/3cdf74534e/manuais-equipamentos-humax-hp610.pdf), Humax, publicado pela Claro, acessado em 2026-10-06.

### Technicolor TC3102

1. A página de boas-vindas pede só a senha; se você não a trocou, ela está
   na etiqueta embaixo do aparelho.
2. No menu superior, vá em Solicitação > Port Forwarding (Redirecionamento de
   portas).
3. O manual não descreve os campos da regra; preencha o nome, o protocolo, as
   portas e o IP fixo do computador como na tabela acima e salve.

Fonte: [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, publicado pela Claro, acessado em 2026-10-06.

### Qualquer outro modelo

O menu costuma ficar nas configurações avançadas ou de NAT e se chama
redirecionamento de portas, servidor virtual ou mapeamento de portas; o nome
muda conforme o firmware. Nenhuma página da Claro consultada mostra esse
caminho para os outros modelos. Em cada regra vão um nome, o protocolo, a
porta externa, o IP interno (o IP fixo do computador) e a porta interna, com o
mesmo número da externa; depois salve ou aplique.

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

- [Escolha um tipo de aparelho: Modem Wi-Fi](https://configuraraparelhos.claro.com.br/tipos-de-aparelhos/internet-fixa/Modem-WiFi), Claro, acessado em 2026-10-06
- [Como acessar as configurações do modem Wi-Fi pelo computador (F@st 3486)](https://configuraraparelhos.claro.com.br/sagemcom/f-st-3486/funcoes-basicas/como-acessar-as-configuracoes-do-modem-wi-fi-pelo-computador), Claro, acessado em 2026-10-06
- [Onde localizar as informações de acesso do modem Wi-Fi (F680)](https://configuraraparelhos.claro.com.br/zte/f680/primeiros-passos/onde-localizar-as-informacoes-de-acesso-do-modem-wi-fi), Claro, acessado em 2026-10-06
- [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, publicado pela Claro, acessado em 2026-10-06
- [HP610 Manual do Usuário](https://www.claro.com.br/files/104379/x/3cdf74534e/manuais-equipamentos-humax-hp610.pdf), Humax, publicado pela Claro, acessado em 2026-10-06
- [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, publicado pela Claro, acessado em 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (terceiros), acessado em 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06
- [Configuração Banda Larga Claro/NET](https://tecnoblog.net/comunidade/t/configuracao-banda-larga-claro-net/82446), Tecnoblog Comunidade (fórum), acessado em 2026-10-06
