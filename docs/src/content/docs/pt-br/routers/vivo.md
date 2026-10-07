---
title: Vivo Fibra
description: Como liberar as portas da Telinha no roteador da Vivo Fibra, com o que a própria Vivo publica e, onde não há fonte, o passo genérico.
sidebar:
  order: 1
---

Esta página é para quem tem Vivo Fibra e roda a Telinha num servidor em casa,
atrás do roteador que a Vivo instalou. Os nomes dos menus mudam conforme o
modelo e o firmware, então use os passos abaixo como mapa, não como receita
exata. O endereço da página de configuração e a senha de acesso vêm impressos
na etiqueta embaixo do roteador.

:::caution
A página de ajuda da Vivo sobre a configuração do roteador diz que não é
recomendado mudar nada além do nome e da senha do Wi-Fi sem apoio técnico,
porque outras mudanças podem afetar a rede. Encaminhar portas é uma dessas
outras mudanças: anote tudo o que você mudar, para poder desfazer.

Fonte: [Configurações do Wi-Fi](https://vivo.com.br/para-voce/ajuda/autoatendimento/configuracoes-do-wifi), Vivo, acessado em 2026-10-06.
:::

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
vem da internet chega na sua rede, e nenhuma regra no roteador muda isso.
Confira antes de mexer no roteador:

- Rode `telinha doctor`. Quando o roteador responde UPnP, NAT-PMP ou PCP, a
  verificação `cgnat` falha se o IP externo do roteador for de CGNAT e avisa
  se houver NAT duplo.
- Ou compare na mão o IP WAN (ou "Internet") da página de status do roteador
  com o IP público que o `telinha doctor` mostra. Se forem diferentes, há um
  NAT na frente do seu roteador; se o do roteador estiver entre `100.64.0.0` e
  `100.127.255.255`, é CGNAT. O Tecnoblog (terceiros) descreve o mesmo teste e
  explica que o CGNAT não se desliga no roteador: a saída é pedir um IP
  público à operadora, que aceita ou não conforme a política dela.

  Fonte: [O que é CGNAT?](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog, acessado em 2026-10-06.

O que a Vivo publica sobre o IP da Vivo Fibra:

- A página do IP Fixo Digital mostra onde ver o IP atual da conexão: no
  aplicativo Vivo Smart Wi-Fi, aba "Dispositivos", selecione o Modem. A mesma
  página diz que o IP normal é dinâmico e costuma mudar quando o roteador
  reinicia, e que a Vivo vende um IP fixo à parte para clientes Vivo Fibra
  (o IP Fixo Digital). A Telinha não precisa de IP fixo: ela acompanha a troca
  de IP sozinha
  ([Endereço, HTTPS e modos de entrada](/telinha/pt-br/guides/domains/)).

  Fonte: [Ativação IP Fixo Digital](https://vivo.com.br/para-voce/produtos-e-servicos/servicos-digitais/ativacao-servicos-digitais/ativacao-ip-fixo-digital), Vivo, acessado em 2026-10-06.

- Usuários relatam coisas diferentes: num tópico de 2021, um diz que todas as
  operadoras usam CGNAT e que é preciso abrir um chamado para ter IP público;
  outros dizem que a Vivo não usava CGNAT na internet fixa. Isso pode ter
  mudado: faça o teste de qualquer jeito.

  Fonte: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06.

Se der CGNAT, fale com o suporte da Vivo e peça um IPv4 público (às vezes
chamado de "tirar do CGNAT" ou "tirar do NAT"). Outras saídas estão em
[CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo).

## UPnP

Com `UPNP=auto` (o padrão), a Telinha pede as portas ao roteador sozinha.
Nenhuma página da Vivo ou de fabricante consultada diz se o roteador da Vivo
Fibra vem com UPnP ligado, nem onde fica a opção.

Rode o `telinha doctor`: a verificação `gateway` diz se algum roteador
respondeu. Se nenhum respondeu, procure uma opção chamada UPnP nas
configurações avançadas, de NAT ou de rede do roteador, ligue e salve; o nome
e o lugar mudam conforme o firmware. A Telinha procura o roteador de novo a
cada 10 minutos, sem precisar reiniciar. Se não achar a opção, faça o
encaminhamento manual.

## Encaminhamento manual

1. Com o computador na rede da Vivo, abra `192.168.15.1` no navegador. A Vivo
   indica esse endereço (numa aba anônima) e diz que ele também está na
   etiqueta embaixo do roteador, junto com a senha de acesso; o usuário é
   `admin`.

   Fonte: [Configurações do Wi-Fi](https://vivo.com.br/para-voce/ajuda/autoatendimento/configuracoes-do-wifi), Vivo, acessado em 2026-10-06.

2. Procure o menu de encaminhamento. O menu costuma ficar nas configurações
   avançadas ou de NAT e se chama redirecionamento de portas, servidor virtual
   ou mapeamento de portas; o nome muda conforme o firmware. Nenhuma página da
   Vivo ou de fabricante consultada mostra esse caminho nos roteadores da Vivo
   Fibra.
3. Crie uma regra por porta da tabela acima: um nome, o protocolo, a porta
   externa, o IP interno (o IP fixo do computador) e a porta interna, com o
   mesmo número da externa.
4. Salve ou aplique.
5. Coloque `UPNP=off` no `telinha.env` e reinicie a Telinha, para ela não
   tentar abrir portas que o roteador já encaminha.

## Confira

```
telinha doctor
```

A verificação `mappings` lista as portas que o roteador não encaminhou, com o
endereço para onde mandar cada uma; com `UPNP=off` ela é pulada e só mostra a
lista. Depois faça o teste pelo celular que o doctor oferece: nos dados
móveis, fora da sua rede, ele mede UDP e TCP separados. Se só o UDP falhar, a
regra da porta UDP está faltando ou errada; o vídeo ainda passa pelo TCP, com
mais atraso. Como ler cada resultado:
[Doctor e solução de problemas](/telinha/pt-br/guides/doctor/).

## Fontes

- [Configurações do Wi-Fi](https://vivo.com.br/para-voce/ajuda/autoatendimento/configuracoes-do-wifi), Vivo, acessado em 2026-10-06
- [Ativação IP Fixo Digital](https://vivo.com.br/para-voce/produtos-e-servicos/servicos-digitais/ativacao-servicos-digitais/ativacao-ip-fixo-digital), Vivo, acessado em 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (terceiros), acessado em 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (fórum), acessado em 2026-10-06
