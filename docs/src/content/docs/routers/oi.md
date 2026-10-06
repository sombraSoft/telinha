---
title: Oi Fibra
description: How to open Telinha's ports on Oi Fibra modems, with the paths from the manuals Oi publishes and the generic step for other models.
sidebar:
  order: 4
---

This page is for Oi Fibra customers running Telinha on a home server behind
the modem Oi installed. Menu names change with the model and the firmware.
The admin page address, user and password are on the device's label.

Oi publishes, on its Manuais Digitais page, the manuals of some modems:
Huawei HG8245Q2, HG8245W5-6T and HG8145V5, and Nokia G-140W-H, G-240W-C and
G-2425G-A. The paths below come from those manuals.

Source: [Manuais Digitais](https://www.oi.com.br/minha-oi/manuais-digitais/), Oi, fetched 2026-10-06.

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

What the manuals and users say:

- On the Nokia G-240W-C, the label's user can see the "status" menu, which
  includes the "LAN" and "WAN" pages.

  Source: [Guia de Instalação e Ativação da ONT NOKIA G-240W-C para Oi](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G240WC_MANUAL.pdf), Nokia, published by Oi, fetched 2026-10-06.

- Users report different things: in a 2021 thread, one says every ISP uses
  CGNAT and you have to open a ticket to get a public IP; another says Oi did
  not apply CGNAT on fixed internet. That may have changed: run the test
  anyway.

  Source: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06.

If it is CGNAT, contact Oi's support and ask for a public IPv4 (sometimes
called removing CGNAT or NAT, "tirar do CGNAT"). Other ways out are in
[CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat).

## UPnP

With `UPNP=auto` (the default), Telinha asks the modem for the ports by
itself. None of the manuals Oi publishes describes a UPnP option.

Run `telinha doctor`: the `gateway` check says whether any router answered.
If none did, look for an option called UPnP in the modem's advanced, NAT or
network settings, turn it on and save; the name and the place change with the
firmware. Telinha looks for the router again every 10 minutes, without a
restart. If you cannot find the option, forward by hand.

## Forwarding by hand

Connect the machine to the modem and open the address on the label in a
browser. Oi's manuals give `192.168.1.254` for the Nokia models and use
`192.168.100.1` as the example for the Huawei models; the user and password
are on the label too.

Sources: the manuals cited under each model.

Add one rule per port in the table above. On any model, once the rules are
saved, set `UPNP=off` in `telinha.env` and restart Telinha, so it does not try
to map ports the modem already forwards.

### Nokia G-2425G-A

1. Open `https://192.168.1.254`. The browser may show a certificate warning;
   the manual says to continue to the site to reach the login page. The user
   and password are on the label on the back of the device.
2. Go to the menu Application > Port forwarding.
3. In "Wan Connection List", pick the interface with "INTERNET" in its name.
   In "Internal Client", enter the machine's fixed address.
4. "Application Name" offers ready-made rules for well-known applications.
   For Telinha, create your own rules with the protocol and ports from the
   table above (the manual's text does not name those fields).
5. Click "Add". The manual says the rule takes effect at once.

Source: [Guia de Configuração & Ativação de Campo para a ONT-HGW NOKIA 7368 G-2425G-A](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G2425GA_MANUAL.pdf), Nokia, published by Oi, fetched 2026-10-06.

### Nokia G-240W-C

The login is at `http://192.168.1.254`. The manual says the label's user has
configuration restrictions and, for that user, mentions only the status
pages. If the forwarding menu does not show with that login, ask Oi to open
the ports.

Source: [Guia de Instalação e Ativação da ONT NOKIA G-240W-C para Oi](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G240WC_MANUAL.pdf), Nokia, published by Oi, fetched 2026-10-06.

### Huawei HG8145V5 and HG8245W5-6T

Oi's guides for these two models explain what port forwarding is, but the
text does not say which menu it is in. Log in with the address, user and
password on the label (the manual's example is `192.168.100.1`). The menu is
usually under the advanced or NAT settings and is called port forwarding,
virtual server or port mapping; the name changes with the firmware.

Sources: [Guia Rápido de Configuração HG8145V5](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8145V5_MANUAL.pdf), Huawei, published by Oi, fetched 2026-10-06; [Guia Rápido de Configuração HG8245W5-6T](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245W56T_MANUAL.pdf), Huawei, published by Oi, fetched 2026-10-06.

### Any other model

The manuals of the Huawei HG8245Q2 and the Nokia G-140W-H that Oi publishes
do not cover port forwarding. On those and on other models, the menu is
usually under the advanced or NAT settings and is called port forwarding,
virtual server or port mapping; the name changes with the firmware. Each rule
takes a name, the protocol, the external port, the internal IP (the machine's
fixed address) and the internal port, the same number as the external one;
then save or apply.

Sources: [Guia Rápido de Configuração HG8245Q2](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245Q2_V1_26062018_MANUAL.pdf), Huawei, published by Oi, fetched 2026-10-06; [Guia Rápido de Configuração da ONTHGW NOKIA 7368 G-140W-H](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G140WH_MANUAL.pdf), Nokia, published by Oi, fetched 2026-10-06.

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

- [Manuais Digitais](https://www.oi.com.br/minha-oi/manuais-digitais/), Oi, fetched 2026-10-06
- [Guia de Configuração & Ativação de Campo para a ONT-HGW NOKIA 7368 G-2425G-A](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G2425GA_MANUAL.pdf), Nokia, published by Oi, fetched 2026-10-06
- [Guia de Instalação e Ativação da ONT NOKIA G-240W-C para Oi](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G240WC_MANUAL.pdf), Nokia, published by Oi, fetched 2026-10-06
- [Guia Rápido de Configuração da ONTHGW NOKIA 7368 G-140W-H](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_NOKIA_G140WH_MANUAL.pdf), Nokia, published by Oi, fetched 2026-10-06
- [Guia Rápido de Configuração HG8145V5](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8145V5_MANUAL.pdf), Huawei, published by Oi, fetched 2026-10-06
- [Guia Rápido de Configuração HG8245W5-6T](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245W56T_MANUAL.pdf), Huawei, published by Oi, fetched 2026-10-06
- [Guia Rápido de Configuração HG8245Q2](https://oi.com.br/minha-oi/estaticos-portal-oi/manuais-digitais/INTERNET_HUAWEI_HG8245Q2_V1_26062018_MANUAL.pdf), Huawei, published by Oi, fetched 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (third-party), fetched 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06
