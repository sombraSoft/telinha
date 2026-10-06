---
title: Vivo Fibra
description: How to open Telinha's ports on the Vivo Fibra router, with what Vivo itself publishes and, where there is no source, the generic step.
sidebar:
  order: 1
---

This page is for Vivo Fibra customers running Telinha on a home server behind
the router Vivo installed. Menu names change with the model and the firmware,
so treat the steps below as a map, not an exact recipe. The address of the
router's admin page and its password are printed on the label under the
router.

:::caution
Vivo's help page on the router's admin page says it is not recommended to
change anything other than the Wi-Fi name and password without technical
support, because other changes can affect the network. Port forwarding is one
of those other changes: write down everything you change, so you can undo it.

Source: [Configurações do Wi-Fi](https://vivo.com.br/para-voce/ajuda/autoatendimento/configuracoes-do-wifi), Vivo, fetched 2026-10-06.
:::

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
| TCP | 443 | `direct` mode only |
| TCP | 80 | `direct` mode only, unless `HTTP_PORT=0` |

If you changed `MEDIA_TCP_PORT`, `MEDIA_UDP_PORT`, `HTTP_PORT` or `HTTPS_PORT`
in `telinha.env`, use your own values.

## Is it CGNAT?

If the ISP shares one public IP between many customers (CGNAT), nothing from
the internet reaches your network, and no rule on the router changes that.
Check before you touch the router:

- Run `telinha doctor`. When the router answers UPnP, NAT-PMP or PCP, the
  `cgnat` check fails if the router's external IP is a CGNAT address and warns
  on double NAT.
- Or compare by hand the WAN (or "Internet") IP on the router's status page
  with the public IP `telinha doctor` shows. If they differ, there is a NAT in
  front of your router; if the router's is between `100.64.0.0` and
  `100.127.255.255`, it is CGNAT. Tecnoblog (third-party) describes the same
  test and explains that CGNAT cannot be turned off on the router: the way out
  is asking the ISP for a public IP, which it grants or not by its own policy.

  Source: [O que é CGNAT?](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog, fetched 2026-10-06.

What Vivo publishes about the Vivo Fibra IP:

- The IP Fixo Digital page shows where to see the connection's current IP: in
  the Vivo Smart Wi-Fi app, "Dispositivos" tab, select the Modem. The same page
  says the regular IP is dynamic and usually changes when the router restarts,
  and that Vivo sells a fixed IP separately to Vivo Fibra customers (IP Fixo
  Digital). Telinha does not need a fixed IP: it follows IP changes by itself
  ([Dynamic IP](/telinha/guides/domains/#dynamic-ip)).

  Source: [Ativação IP Fixo Digital](https://vivo.com.br/para-voce/produtos-e-servicos/servicos-digitais/ativacao-servicos-digitais/ativacao-ip-fixo-digital), Vivo, fetched 2026-10-06.

- Users report different things: in a 2021 thread, one says every ISP uses
  CGNAT and you have to open a ticket to get a public IP; others say Vivo did
  not use CGNAT on fixed internet. That may have changed: run the test anyway.

  Source: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06.

If it is CGNAT, contact Vivo's support and ask for a public IPv4 (sometimes
called removing CGNAT or NAT, "tirar do CGNAT"). Other ways out are in
[CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat).

## UPnP

With `UPNP=auto` (the default), Telinha asks the router for the ports by
itself. No Vivo or manufacturer page consulted says whether the Vivo Fibra
router ships with UPnP on, or where the option is.

Run `telinha doctor`: the `gateway` check says whether any router answered.
If none did, look for an option called UPnP in the router's advanced, NAT or
network settings, turn it on and save; the name and the place change with the
firmware. Telinha looks for the router again every 10 minutes, without a
restart. If you cannot find the option, forward by hand.

## Forwarding by hand

1. With the machine on Vivo's network, open `192.168.15.1` in a browser.
   Vivo gives this address (in a private window) and says it is also on the
   label under the router, together with the password; the user is `admin`.

   Source: [Configurações do Wi-Fi](https://vivo.com.br/para-voce/ajuda/autoatendimento/configuracoes-do-wifi), Vivo, fetched 2026-10-06.

2. Find the forwarding menu. The menu is usually under the advanced or NAT
   settings and is called port forwarding, virtual server or port mapping; the
   name changes with the firmware. No Vivo or manufacturer page consulted shows
   this path on Vivo Fibra routers.
3. Add one rule per port in the table above: a name, the protocol, the
   external port, the internal IP (the machine's fixed address) and the
   internal port, the same number as the external one.
4. Save or apply.
5. Set `UPNP=off` in `telinha.env` and restart Telinha, so it does not try to
   map ports the router already forwards.

## Check

```
telinha doctor
```

The `mappings` check lists the ports the router did not forward, with the
address to send each one to; with `UPNP=off` it is skipped and prints the
list. Then do the phone test the doctor offers: on mobile data, outside your
network, it measures UDP and TCP separately. If only UDP fails, the UDP rule
is missing or wrong; video still goes over TCP, with more delay. How to read
each result: [Doctor and troubleshooting](/telinha/guides/doctor/).

## Sources

- [Configurações do Wi-Fi](https://vivo.com.br/para-voce/ajuda/autoatendimento/configuracoes-do-wifi), Vivo, fetched 2026-10-06
- [Ativação IP Fixo Digital](https://vivo.com.br/para-voce/produtos-e-servicos/servicos-digitais/ativacao-servicos-digitais/ativacao-ip-fixo-digital), Vivo, fetched 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (third-party), fetched 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06
