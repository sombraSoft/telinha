---
title: Claro (NET)
description: How to open Telinha's ports on Claro's modems, with the paths from the manuals Claro publishes and the generic step for other models.
sidebar:
  order: 2
---

This page is for Claro (NET) fixed internet customers running Telinha on a
home server behind the modem Claro installed. Claro uses many modem models,
and menu names change with the model and the firmware. The login and password
of the admin page are printed on a label on the device itself.

Claro's device setup site has a list of Wi-Fi modems, with pages per model;
look for yours there. Claro also hosts the manuals of some models on its own
site, and the paths below come from three of them.

Source: [Escolha um tipo de aparelho: Modem Wi-Fi](https://configuraraparelhos.claro.com.br/tipos-de-aparelhos/internet-fixa/Modem-WiFi), Claro, fetched 2026-10-06.

## Before you start

- Find the machine's address on your network and keep it fixed with a DHCP
  reservation:
  [Give the machine a fixed address](/telinha/guides/port-forwarding/#give-the-machine-a-fixed-address).
  A rule that points at an address that changes stops working from one day to
  the next.
- These are the ports Telinha uses by default
  ([details](/telinha/guides/port-forwarding/#which-ports)):

| Protocol | Port | When |
| --- | --- | --- |
| TCP | 7881 | always |
| UDP | 7882 | always |
| TCP | 8443 | DuckDNS address at home; your port if you changed it |

With a Cloudflare Tunnel only the two media ports. Nothing else, not 80 and
not 443: home connections usually do not let them in, so Telinha does not use
them. If you changed `MEDIA_TCP_PORT`, `MEDIA_UDP_PORT` or `HTTPS_PORT` in
`telinha.env`, use your own values.

## Is it CGNAT?

If the ISP shares one public IP between many customers (CGNAT), nothing from
the internet reaches your network, and no rule on the modem changes that.
Check before you touch the modem:

- Run `telinha doctor`. When the modem answers UPnP, NAT-PMP or PCP, the
  `cgnat` check fails if the modem's external IP is a CGNAT address and warns
  on double NAT.
- Or compare by hand the WAN (or "Internet") IP on the modem's status page
  with the public IP `telinha doctor` shows. If they differ, there is a NAT in
  front of your modem; if the modem's is between `100.64.0.0` and
  `100.127.255.255`, it is CGNAT. Tecnoblog (third-party) describes the same
  test and explains that CGNAT cannot be turned off on the modem: the way out
  is asking the ISP for a public IP, which it grants or not by its own policy.

  Source: [O que é CGNAT?](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog, fetched 2026-10-06.

Where the manuals Claro publishes show the WAN IP:

- Humax HGJ310: Status > Conexão IP, field "Endereço IPv4".

  Source: [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, published by Claro, fetched 2026-10-06.

- Technicolor TC3102: menu Conexão > WAN, which "shows the information about
  your public IP addresses".

  Source: [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, published by Claro, fetched 2026-10-06.

What users report about Claro:

- In a 2021 thread, users say CGNAT at Claro varies by location, and that
  people who ended up behind double NAT and complained with a good reason got
  a valid IPv4, with some effort.

  Source: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06.

- In a 2023 thread, a Claro customer was behind CGNAT, and the accepted answer
  was to ask support to switch back to a public IP; the person answering warns
  that it depends on who handles the call and on Claro having IPv4 addresses
  available.

  Source: [Configuração Banda Larga Claro/NET](https://tecnoblog.net/comunidade/t/configuracao-banda-larga-claro-net/82446), Tecnoblog Comunidade (forum), fetched 2026-10-06.

If it is CGNAT, contact Claro's support and ask for a public IPv4 (sometimes
called removing CGNAT or NAT, "tirar do CGNAT"). Other ways out are in
[CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat).

## UPnP

With `UPNP=auto` (the default), Telinha asks the modem for the ports by
itself. Run `telinha doctor`: the `gateway` check says whether any router
answered. If none did, turn UPnP on in the modem; Telinha looks again every
10 minutes, without a restart.

- Humax HGJ310: Avançado > Opções avançadas, option "UPNP ATIVAR", then
  "APLICAR AJUSTES".

  Source: [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, published by Claro, fetched 2026-10-06.

- Humax HP610: AVANÇADO > UPnP holds the UPnP settings and the "Tabela de
  Mapeamento de Porta UPnP", which lists the ports opened through UPnP; a good
  place to see whether Telinha's ports went in.

  Source: [HP610 Manual do Usuário](https://www.claro.com.br/files/104379/x/3cdf74534e/manuais-equipamentos-humax-hp610.pdf), Humax, published by Claro, fetched 2026-10-06.

- Technicolor TC3102: menu Solicitação > UPnP, where the feature is enabled.

  Source: [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, published by Claro, fetched 2026-10-06.

On other models, look for an option called UPnP in the advanced, NAT or
network settings; the name and the place change with the firmware.

## Forwarding by hand

With the machine connected to the modem (by cable or over its Wi-Fi), open
`192.168.0.1` in a browser and log in with the login and password on the
device's label. Claro's pages for the models consulted give this address; if
the page does not open, Claro suggests typing `http://192.168.0.1`.

Sources: [Como acessar as configurações do modem Wi-Fi pelo computador (F@st 3486)](https://configuraraparelhos.claro.com.br/sagemcom/f-st-3486/funcoes-basicas/como-acessar-as-configuracoes-do-modem-wi-fi-pelo-computador), Claro, fetched 2026-10-06; [Onde localizar as informações de acesso do modem Wi-Fi (F680)](https://configuraraparelhos.claro.com.br/zte/f680/primeiros-passos/onde-localizar-as-informacoes-de-acesso-do-modem-wi-fi), Claro, fetched 2026-10-06.

Add one rule per port in the table above. On any model, once the rules are
saved, set `UPNP=off` in `telinha.env` and restart Telinha, so it does not try
to map ports the modem already forwards.

### Humax HGJ310

1. After logging in, the quick setup screen shows; click "Configurações
   avançadas".
2. In the menu, go to Avançado > Encaminhamento de porta and click "CRIAR".
3. Leave "Selecione um serviço" unticked and fill in: "Serviço Customizado"
   (a name), "Endereço IP do Servidor" (the machine's fixed address), "Porta
   externa inicial" and "Porta externa final" (the port), "Protocolo" (TCP or
   UDP), "Porta inicial interna" and "Porta final interna" (the same number).
4. Click "APLICAR AJUSTES".

Source: [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, published by Claro, fetched 2026-10-06.

### Humax HP610

1. In the menu, go to AVANÇADO > Encaminhamento de Porta/DMZ.
2. Under "Encaminhamento de porta", click "ADICIONAR" and fill in: "Tipo de
   Serviço", "Endereço IP" (the machine's fixed address; the manual itself
   recommends a fixed address), "Porta Local (Inicial-Final)" and "Porta
   Externa (Inicial-Final)" (the port, the same number in both) and
   "Protocolo" (TCP or UDP).
3. Click "Salvar", then "Aplicar".

Source: [HP610 Manual do Usuário](https://www.claro.com.br/files/104379/x/3cdf74534e/manuais-equipamentos-humax-hp610.pdf), Humax, published by Claro, fetched 2026-10-06.

### Technicolor TC3102

1. The welcome page asks only for the password; if you did not change it, it
   is on the label under the device.
2. In the top menu, go to Solicitação > Port Forwarding (Redirecionamento de
   portas).
3. The manual does not describe the rule's fields; fill in the name, the
   protocol, the ports and the machine's fixed address as in the table above,
   and save.

Source: [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, published by Claro, fetched 2026-10-06.

### Any other model

The menu is usually under the advanced or NAT settings and is called port
forwarding, virtual server or port mapping; the name changes with the
firmware. No Claro page consulted shows this path for other models. Each rule
takes a name, the protocol, the external port, the internal IP (the machine's
fixed address) and the internal port, the same number as the external one;
then save or apply.

## Check

```
telinha doctor
```

The `mappings` check lists the ports the modem did not forward, with the
address to send each one to; with `UPNP=off` it is skipped and prints the
list. Then do the phone test the doctor offers: on mobile data, outside your
network, it measures UDP and TCP separately. If only UDP fails, the UDP rule
is missing or wrong; video still goes over TCP, with more delay. How to read
each result: [Doctor and troubleshooting](/telinha/guides/doctor/).

## Sources

- [Escolha um tipo de aparelho: Modem Wi-Fi](https://configuraraparelhos.claro.com.br/tipos-de-aparelhos/internet-fixa/Modem-WiFi), Claro, fetched 2026-10-06
- [Como acessar as configurações do modem Wi-Fi pelo computador (F@st 3486)](https://configuraraparelhos.claro.com.br/sagemcom/f-st-3486/funcoes-basicas/como-acessar-as-configuracoes-do-modem-wi-fi-pelo-computador), Claro, fetched 2026-10-06
- [Onde localizar as informações de acesso do modem Wi-Fi (F680)](https://configuraraparelhos.claro.com.br/zte/f680/primeiros-passos/onde-localizar-as-informacoes-de-acesso-do-modem-wi-fi), Claro, fetched 2026-10-06
- [HUMAX HGJ310 Manual do Usuário](https://www.claro.com.br/files/104379/x/f33df318bd/manuais-equipamentos-humax-hgj310.pdf), Humax, published by Claro, fetched 2026-10-06
- [HP610 Manual do Usuário](https://www.claro.com.br/files/104379/x/3cdf74534e/manuais-equipamentos-humax-hp610.pdf), Humax, published by Claro, fetched 2026-10-06
- [Guia de configuração e do usuário TC3102](https://www.claro.com.br/files/104379/x/331ed6ba88/manual_public_tc3102_v3.pdf), Technicolor, published by Claro, fetched 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (third-party), fetched 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06
- [Configuração Banda Larga Claro/NET](https://tecnoblog.net/comunidade/t/configuracao-banda-larga-claro-net/82446), Tecnoblog Comunidade (forum), fetched 2026-10-06
