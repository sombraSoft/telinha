---
title: Rodando como serviço
description: Como a Telinha continua rodando em segundo plano no Windows, no Linux como root ou como usuário, e no Docker, e os comandos para cuidar dela.
sidebar:
  order: 5
---

Como serviço, a Telinha inicia junto com o computador, volta depois de um
travamento ou de uma atualização e continua rodando sem ninguém logado. O
`telinha setup` instala o serviço para você; esta página mostra o que ele
configurou e como cuidar disso. A verificação `service` do
[`telinha doctor`](/telinha/pt-br/guides/doctor/) diz se ele está instalado,
rodando e configurado para iniciar com o computador. Todos os comandos e
opções estão em [Linha de comando](/telinha/pt-br/reference/cli/).

## Windows

O `telinha service install` registra uma tarefa do Agendador de Tarefas
chamada `Telinha`. O setup roda ele com um pedido de administrador (UAC),
junto com as regras de firewall; para refazer, rode o `telinha setup` de novo.
A tarefa:

- inicia junto com o computador, com ou sem alguém logado;
- roda com a sua conta, sem guardar senha;
- roda **sem elevação**: o processo da Telinha exposto à internet e os programas
  auxiliares recebem um token de usuário comum. Nada precisa de administrador
  enquanto roda: as regras de firewall são criadas na instalação e as
  atualizações gravam dentro da pasta da Telinha.

A tarefa roda `telinha.exe service run --home "<telinha-folder>"`, um loop pequeno que
inicia o `telinha run`, inicia de novo na hora depois de uma atualização e com
uma pausa crescente depois de um travamento (1 s, dobrando até 60 s), volta
uma atualização que não consegue iniciar e grava o log em `logs\telinha.log`
na pasta da Telinha (girado a cada 10 MB, guardando cinco arquivos). Se o
próprio loop morrer, o Agendador de Tarefas reinicia ele.

```
telinha service status       # instalado / rodando / inicia com o computador, mais o último resultado da tarefa
telinha service stop         # parada suave, depois encerra a tarefa (o Agendador de Tarefas não desfaz)
telinha service start
telinha service restart
telinha service uninstall --firewall   # remove a tarefa e as regras de firewall; os arquivos ficam
Get-Content "$env:LOCALAPPDATA\Telinha\logs\telinha.log" -Tail 50 -Wait
```

As regras de firewall estão descritas em
[Encaminhamento de portas](/telinha/pt-br/guides/port-forwarding/#firewalls).

O [ícone na bandeja](/telinha/pt-br/guides/tray/), ao lado do relógio, é uma
frente para a mesma tarefa: o *Iniciar* e o *Parar* dele rodam o
`telinha service start` e o `telinha service stop`, e o *Reiniciar* pede para
a Telinha sair, e o loop inicia ela de novo. Enquanto o loop sobe a Telinha de
novo (depois de um reinício, de uma atualização ou de um travamento), o ícone
mostra `Telinha: iniciando…`, não *parada*. O `telinha service uninstall`
também fecha o ícone e remove a entrada de *Iniciar com o Windows* dele.

Rodar num console também funciona: `telinha run` num terminal, ou um clique
duplo no `telinha.exe`; Ctrl+C para. Só um `telinha run` por pasta da Telinha:
um segundo (rodar num console com o serviço no ar, um segundo clique duplo)
deixa o primeiro em paz e sai com 1, mostrando
"A Telinha já está rodando (pid N). Use: telinha service status | telinha service stop".
Depois de um clique duplo ele espera um Enter, para a janela não sumir.

## Linux como root

O `sudo telinha service install` (o setup roda numa instalação como
root) cria um usuário de sistema `telinha` e a unit
`/etc/systemd/system/telinha.service`, e depois ativa e inicia o serviço. A
unit:

- roda `"/opt/telinha/bin/telinha" service run` como o usuário `telinha`, o
  mesmo loop do Windows, com `Restart=on-failure` por cima;
- dá a `CAP_NET_BIND_SERVICE`, para o Caddy poder usar as portas 80 e 443
  numa VPS. É uma capability do processo, que o Caddy herda, então um Caddy
  baixado de novo continua com ela;
- usa `ProtectSystem=strict`, com só `bin/`, `data/` e `logs/` graváveis.

O usuário do serviço é dono só dessas três pastas (ele atualiza o próprio
binário em `bin/`). O `/opt/telinha` e o `config/` continuam do root, e o
`config/telinha.env` é `root:telinha` com modo 0640; assim nada que o root
grava ou executa fica numa pasta que o usuário do serviço controla. Pelo mesmo
motivo, o `sudo telinha` roda a cópia da linha de comando do próprio root
(`/usr/local/bin/telinha`), nunca a do serviço.

```
sudo systemctl status telinha
journalctl -u telinha -f        # as linhas da Telinha mais [livekit], [caddy], [cloudflared]
sudo telinha doctor             # a cópia do root, conversando com o serviço
```

O `systemctl` cuida dele como de qualquer outra unit, e
`telinha service start|stop|restart|status|uninstall` fazem as mesmas
chamadas.

## Linux como usuário

Sem root (ou como root com `--user`), o `telinha service install` grava uma
unit de usuário em `~/.config/systemd/user/telinha.service` e inicia o
serviço:

```
systemctl --user status telinha
journalctl --user -u telinha -f
loginctl enable-linger $USER
```

Um serviço de usuário normalmente para quando você sai da sessão, e o fim de
uma sessão SSH conta. O linger mantém ele rodando: a instalação roda o
`loginctl enable-linger` para você, e mostra o comando com `sudo` quando ele
pede autenticação.

Em casa as instalações padrão não precisam de porta baixa: um endereço do
DuckDNS escuta na 8443 e um Cloudflare Tunnel não escuta em nenhuma, então uma
instalação de usuário funciona do jeito que está.

### Portas baixas numa instalação de usuário na VPS

Um serviço de usuário não consegue usar portas abaixo de 1024, a não ser que
o kernel libere portas baixas sem privilégio, e o modo `direct` numa VPS
precisa da 80 e da 443. O setup oferece este passo único com `sudo`,
que continua valendo em todas as atualizações:

```
sudo sh -c 'printf "net.ipv4.ip_unprivileged_port_start=80\n" > /etc/sysctl.d/50-telinha.conf && sysctl --system'
```

Apesar do nome, ele vale para IPv6 também. Quando você recusa, o setup
mostra o comando pra depois e não muda mais nada; a verificação `listeners` do
`telinha doctor` mostra o comando de novo enquanto nada escuta na porta HTTPS.
Uma instalação como root não precisa de nada disso.

## Docker

O serviço é o compose: o `deploy/compose.yml` define
`restart: unless-stopped`, então o contêiner volta junto com o Docker depois
de um reinício ou de um travamento. Cuide dele a partir de `/opt/telinha`:

```
cd /opt/telinha && docker compose up -d
docker compose restart
docker compose down
docker logs -f telinha
```

Os seus ajustes vão em `/opt/telinha/compose.override.yml`, que o compose e o
`telinha-update` leem sozinhos. Um arquivo só guarda todos eles, por exemplo
o log no journald (assim o log sobrevive quando o contêiner é recriado, e você
lê com `journalctl -t telinha`) e um limite de memória, LiveKit incluído:

```yaml
services:
  telinha:
    logging:
      driver: journald
      options:
        tag: telinha
    mem_limit: 1g
```

A parte do journald também vem pronta em `/opt/telinha/compose.journald.yml`;
copie para `compose.override.yml` quando é só isso que você quer.

O healthcheck busca `http://127.0.0.1:8081/healthz`. Se você mudar a porta do
`LISTEN`, sobrescreva o healthcheck no mesmo arquivo com a sua porta:

```yaml
services:
  telinha:
    healthcheck:
      test:
        - CMD-SHELL
        - >-
          body=$$(wget -qO- http://127.0.0.1:9000/healthz) &&
          case "$$body" in *'"restarting"'*) exit 1 ;; esac
```

Para instalar: [Docker](/telinha/pt-br/start/docker/). Para manter em dia:
[Atualizações](/telinha/pt-br/guides/updates/#máquina-com-docker).
