---
title: TIM Ultrafibra
description: How to open Telinha's ports on TIM Ultrafibra modems, with the paths from the manuals TIM publishes and the generic step for other models.
sidebar:
  order: 3
---

This page is for TIM Ultrafibra customers running Telinha on a home server
behind the modem TIM installed. Menu names change with the model and the
firmware. The admin page password is printed on the device's label.

TIM publishes, in its Guia TIM Ultrafibra, the manuals of some modems: ZTE
ZXHN F6600P, Huawei OptiXstar HG8145X6-10, Blu-Castle BCSKV630, Blu-Castle
BC-UM221E, Kaon PG2447 and Sagemcom F@st5670. The paths below come from those
manuals.

Source: [Guia TIM Ultrafibra: Suporte, 2ª Via, Funcionalidades e Benefícios](https://www.tim.com.br/internet/guia-funcionalidades-tim-ultrafibra), TIM, fetched 2026-10-06.

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

What TIM and the manuals say:

- According to TIM's FAQ, residential TIM Ultrafibra plans have a dynamic IP
  provided by TIM, and business plans have a fixed IP. Telinha does not need a
  fixed IP: it follows IP changes by itself
  ([Dynamic IP](/telinha/guides/domains/#dynamic-ip)).

  Source: [Suporte e dicas TIM Fibra: dúvidas frequentes](https://www.tim.com.br/ajuda/perguntas-frequentes/internet-e-telefone-fixo/tim-fibra/suporte-e-dicas), TIM, fetched 2026-10-06.

- On the Blu-Castle BCSKV630, the WAN IP is under Status / Wan Info.

  Source: [Manual Técnico – CPE BCSKV630](https://timbrasil.widen.net/view/pdf/yrmwa5vu1i/Manual-Tecnico---Blu-Castle---BCSKV630_TIM.pdf?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06.

- Users report different things: in a 2021 thread, one says every ISP uses
  CGNAT and you have to open a ticket to get a public IP; another says TIM did
  not apply CGNAT on fixed internet. That may have changed: run the test
  anyway.

  Source: [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06.

If it is CGNAT, contact TIM's support and ask for a public IPv4 (sometimes
called removing CGNAT or NAT, "tirar do CGNAT"). Other ways out are in
[CGNAT and double NAT](/telinha/guides/domains/#cgnat-and-double-nat).

## UPnP

With `UPNP=auto` (the default), Telinha asks the modem for the ports by
itself. None of the manuals TIM publishes describes a UPnP option.

Run `telinha doctor`: the `gateway` check says whether any router answered.
If none did, look for an option called UPnP in the modem's advanced, NAT or
network settings, turn it on and save; the name and the place change with the
firmware. Telinha looks for the router again every 10 minutes, without a
restart. If you cannot find the option, forward by hand.

## Forwarding by hand

To open a port ("liberar uma porta"), TIM's FAQ says to contact TIM's
customer service (Central de Relacionamento). You can ask there or do it
yourself on the models below.

Source: [Suporte e dicas TIM Fibra: dúvidas frequentes](https://www.tim.com.br/ajuda/perguntas-frequentes/internet-e-telefone-fixo/tim-fibra/suporte-e-dicas), TIM, fetched 2026-10-06.

The Guia TIM Ultrafibra says to open `192.168.1.1` in a browser, with the
machine connected to the modem by cable, and log in with the user `admin`.
The manuals of the models below say the password is unique to each device and
printed on the label on its back, and that the full interface is at
`192.168.1.1/normal`.

Sources: [Guia TIM Ultrafibra](https://www.tim.com.br/internet/guia-funcionalidades-tim-ultrafibra), TIM, fetched 2026-10-06; the manuals cited under each model.

Add one rule per port in the table above. On any model, once the rules are
saved, set `UPNP=off` in `telinha.env` and restart Telinha, so it does not try
to map ports the modem already forwards.

### Kaon PG2447

1. Log in at `192.168.1.1/normal` with the user `admin` and the password on
   the label.
2. In the main menu, go to Security > NAT > Port Forwarding.
3. To create a new rule, fill in "Application Name" (a name), "WAN Interface"
   (the WAN interface to use), "Server IP Address" (the machine's fixed
   address), the protocol and the ports. For a single port, the manual says to
   repeat the same number in "External/Internal Port Start" and
   "External/Internal Port End".
4. Click "Apply". The rules you created show below the button.

Source: [Manual Técnico – CPE Kaon PG2447](https://timbrasil.widen.net/view/pdf/rlqmqs0rbx/Manual-Tecnico---Kaon-PG2447_v1.1.docx?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06.

### Blu-Castle BCSKV630

1. At `192.168.1.1`, the user `admin` and the password on the label open
   TIM's wizard; the full interface is at `192.168.1.1/normal`.
2. Go to the menu Advanced > Port Forwarding.
3. The manual does not describe the rule's fields; fill in the name, the
   protocol, the ports and the machine's fixed address as in the table above,
   and save.

Source: [Manual Técnico – CPE BCSKV630](https://timbrasil.widen.net/view/pdf/yrmwa5vu1i/Manual-Tecnico---Blu-Castle---BCSKV630_TIM.pdf?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06.

### Blu-Castle BC-UM221E

The manual describes port forwarding only with a login other than the one on
the label. With the label's login, ask TIM to open the ports.

Source: [Manual Técnico – CPE BLU-CASTLE BC-UM221E](https://timbrasil.widen.net/view/pdf/ficbxvroqn/Manual-Tecnico---Blu-Castle-BC-UM221E_v1.pdf?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06.

### Any other model

The manuals of the ZTE ZXHN F6600P, the Huawei OptiXstar HG8145X6-10 (a quick
start guide) and the Sagemcom F@st5670 that TIM publishes do not cover port
forwarding. On those and on other models, the menu is usually under the
advanced or NAT settings and is called port forwarding, virtual server or port
mapping; the name changes with the firmware. Each rule takes a name, the
protocol, the external port, the internal IP (the machine's fixed address)
and the internal port, the same number as the external one; then save or
apply.

Sources: [ZXHN F6600P GPON ONT User Manual](https://timbrasil.widen.net/view/pdf/b4c2t2irwv/F6600P_Manual-Tecnico-Completo---SJ--20211014111546-001-ZXHN-F6600PV9.0User-Manual1FXS1USB.pdf?t.download=true&u=vv6x5q), ZTE, published by TIM; [Huawei OptiXstar HG8145X6-10 Quick Start](https://timbrasil.widen.net/view/pdf/anqg0u47w8/Huawei-OptiXstar-HG8145X6-10-Quick-Start-for-QR-code-01.pdf?t.download=true&u=vv6x5q), Huawei, published by TIM; [Manual Técnico – CPE Sagemcom F@st5670](https://timbrasil.widen.net/view/pdf/mdyr7akctz/Manual-Tecnico-Completo---Sagemcom-Fst-5670.pdf?t.download=true&u=vv6x5q), TIM; all fetched 2026-10-06.

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

- [Guia TIM Ultrafibra: Suporte, 2ª Via, Funcionalidades e Benefícios](https://www.tim.com.br/internet/guia-funcionalidades-tim-ultrafibra), TIM, fetched 2026-10-06
- [Suporte e dicas TIM Fibra: dúvidas frequentes](https://www.tim.com.br/ajuda/perguntas-frequentes/internet-e-telefone-fixo/tim-fibra/suporte-e-dicas), TIM, fetched 2026-10-06
- [Manual Técnico – CPE Kaon PG2447](https://timbrasil.widen.net/view/pdf/rlqmqs0rbx/Manual-Tecnico---Kaon-PG2447_v1.1.docx?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06
- [Manual Técnico – CPE BCSKV630](https://timbrasil.widen.net/view/pdf/yrmwa5vu1i/Manual-Tecnico---Blu-Castle---BCSKV630_TIM.pdf?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06
- [Manual Técnico – CPE BLU-CASTLE BC-UM221E](https://timbrasil.widen.net/view/pdf/ficbxvroqn/Manual-Tecnico---Blu-Castle-BC-UM221E_v1.pdf?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06
- [ZXHN F6600P GPON ONT User Manual](https://timbrasil.widen.net/view/pdf/b4c2t2irwv/F6600P_Manual-Tecnico-Completo---SJ--20211014111546-001-ZXHN-F6600PV9.0User-Manual1FXS1USB.pdf?t.download=true&u=vv6x5q), ZTE, published by TIM, fetched 2026-10-06
- [Huawei OptiXstar HG8145X6-10 Quick Start](https://timbrasil.widen.net/view/pdf/anqg0u47w8/Huawei-OptiXstar-HG8145X6-10-Quick-Start-for-QR-code-01.pdf?t.download=true&u=vv6x5q), Huawei, published by TIM, fetched 2026-10-06
- [Manual Técnico – CPE Sagemcom F@st5670](https://timbrasil.widen.net/view/pdf/mdyr7akctz/Manual-Tecnico-Completo---Sagemcom-Fst-5670.pdf?t.download=true&u=vv6x5q), TIM, fetched 2026-10-06
- [O que é CGNAT? Entenda a tecnologia e por que afeta sua internet](https://tecnoblog.net/responde/o-que-e-cgnat/), Tecnoblog (third-party), fetched 2026-10-06
- [Brisanet fará estreia na bolsa de valores para expandir internet por fibra](https://tecnoblog.net/comunidade/t/brisanet-fara-estreia-na-bolsa-de-valores-para-expandir-internet-por-fibra/39024), Tecnoblog Comunidade (forum), fetched 2026-10-06
