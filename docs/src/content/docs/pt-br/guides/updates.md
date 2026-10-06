---
title: Atualizações
description: Como o binário nativo, um servidor com Docker e um clone do código recebem as versões novas da Telinha, e como fixar uma versão, voltar atrás ou desligar as atualizações.
sidebar:
  order: 4
---

O jeito como a Telinha se atualiza depende de como você instalou:

| Instalação | Atualiza por | Padrão |
| --- | --- | --- |
| Binário nativo (Windows, Linux) | A própria Telinha (`AUTO_UPDATE`) | ligado |
| Servidor com Docker | `telinha-update`, um timer do systemd | desligado até você ativar o timer |
| Um clone do repositório | `git pull` | na mão |

`AUTO_UPDATE=on` em qualquer lugar que não seja o binário nativo gera um aviso
e é ignorado.

## Binário nativo

### Como decide

Só versões estáveis: o alvo é o que
`https://github.com/sombraSoft/telinha/releases/latest` aponta, e uma
pré-versão nunca é instalada por ali. Com o `UPDATE_PIN` definido (uma tag
como `v0.7.0`), ela instala exatamente essa tag, pré-versões e versões mais
antigas inclusive, e fica nela.

### Quando

A primeira verificação roda 2 minutos depois de a Telinha iniciar, e depois a
cada `UPDATE_CHECK_HOURS` (6). Com salas abertas a atualização espera, mas no
máximo `UPDATE_MAX_DEFER_HOURS` (12; `0` quer dizer não esperar) por versão,
para uma sala presa aberta não segurar a versão que conserta justamente isso.
Uma versão cujos arquivos ainda não foram publicados, ou uma falha de rede, é
tentada de novo na próxima verificação.

### Como

A Telinha baixa o arquivo desta máquina (`telinha-<target>.tar.gz` ou `.zip`)
e o `SHA256SUMS` da versão, e não instala nada se o sha256 não bater. O
executável em uso é renomeado para `telinha.old-<version>` e o novo toma o
lugar dele; o loop do serviço inicia o novo na hora. Quando a versão nova fixa
programas auxiliares mais novos, esse primeiro início baixa os programas e
registra `binaries updated: livekit` (ou o que tiver mudado). Com
`INGRESS=direct` ela também baixa o build do Caddy da versão nova, conferido
com o `SHA256SUMS` dessa versão, já que cada versão traz o seu.

Rodando num console, a Telinha instala a atualização mas não reinicia
sozinha; ela registra "update to vX installed; restart telinha to apply it".
O executável do próprio loop do serviço é trocado no próximo
`telinha service restart` ou reinício do computador.

### Voltar atrás

Quando a versão nova falha ao iniciar duas vezes seguidas, o loop do serviço
coloca o executável anterior de volta, guarda o novo como
`telinha.failed-<tag>` e anota a tag como falha em `data/run/update.json`.
Essa tag é ignorada até sair uma versão mais nova; o `telinha update --now`
tenta de novo.

### Comandos

```
telinha update --check     # versão atual, estável mais nova (ou a fixada), preparada / falha / pendente
telinha update             # com o serviço rodando: confere e instala agora, a menos que haja salas abertas
telinha update --now       # instala mesmo com salas abertas; também tenta de novo uma tag que falhou
```

Com o serviço parado, o `telinha update` instala na hora e o próximo início
já usa a versão nova. Numa instalação Linux como root, a pasta `bin/` é do
usuário do serviço, então é o serviço que se atualiza: inicie ele
(`sudo telinha service start`) antes de rodar `sudo telinha update`. A
verificação `update` do [`telinha doctor`](/telinha/pt-br/guides/doctor/)
mostra uma versão mais nova, ou uma atualização instalada, com falha ou
pendente.

### Fixar uma versão

Coloque `UPDATE_PIN=v0.7.0` no `telinha.env` e reinicie a Telinha
(`telinha service restart`). Apague a linha para voltar a seguir as versões
estáveis.

### Desligar

`AUTO_UPDATE=off` para a verificação periódica. O `telinha update` continua
funcionando quando você roda.

## Servidor com Docker

### Como decide

O `telinha-update` implanta a tag que está em `/opt/telinha/pin`, se houver,
senão a versão estável mais nova do GitHub (que deixa as pré-versões de fora).
A versão precisa trazer o `telinha-image.digest`, o digest da imagem publicada
com ela; uma versão sem ele ainda não está completa e é tentada de novo na
próxima rodada.

### Quando

O timer roda o `telinha-update` 3 minutos depois de ligar o computador e
depois a cada 5 minutos. Ele é opcional: o `sh install-docker.sh --auto-update`
ativa o timer assim que o `telinha.env` estiver preenchido, ou ative você
mesmo:

```
systemctl enable --now telinha-update.timer
```

Com salas abertas (o `/healthz` na porta do `LISTEN` informa `rooms` acima de
0), a implantação espera, mas no máximo `MAX_DEFER_HOURS` (12) por versão. O
`--now` pula a espera. Quando o `/healthz` não responde, não tem nada rodando
para proteger, então ele não espera.

### Como

Ele baixa `ghcr.io/sombrasoft/telinha:<version>` e a mesma imagem pelo digest
publicado, e se recusa a implantar (apagando a tag baixada) quando as duas não
são a mesma imagem. Depois roda
`docker compose up -d --remove-orphans --wait --wait-timeout 180` em
`/opt/telinha` e, só depois que o healthcheck passa, grava a versão e o digest
em `/opt/telinha/.env` e apaga a imagem anterior.

O `/opt/telinha/compose.yml` nunca é alterado. Ele só muda quando você roda de
novo o `install-docker.sh` de um `telinha-deploy.tar.gz` (ou clone) mais novo;
faça isso quando as notas de uma versão falarem de mudança no compose.

### Voltar atrás

Quando a versão nova nunca fica saudável, o `telinha-update` volta para a
anterior (o `.env` ainda aponta para ela e a imagem ainda está lá) e anota a
tag em `/opt/telinha/failed`, que o `telinha-update status` mostra. O timer
ignora essa tag até sair uma versão mais nova, para o servidor não ficar
pulando entre versões a cada 5 minutos; `--now`, `pin` e `unpin` tentam de
novo. Na primeira implantação não tem para onde voltar: arrume o
`telinha.env` e rode `telinha-update --now`.

### Comandos

```
telinha-update                  # implanta a tag fixada, senão a estável mais nova
telinha-update --now            # o mesmo, sem esperar as salas abertas
telinha-update status           # tag fixada, versão e digest implantados, estável mais nova, espera
journalctl -t telinha-update    # o que o timer fez
```

Todo subcomando precisa de root (`/opt/telinha` tem modo 700). Sem o
`telinha-update`, na mão:

```
cd /opt/telinha && docker compose pull && docker compose up -d
```

Isso segue a `latest`, ou a `TELINHA_VERSION` do `/opt/telinha/.env`.

### Fixar uma versão

```
telinha-update pin v0.6.0       # fica numa tag (pré-versões como v0.7.0-rc.1 também) e implanta agora
telinha-update unpin            # volta a seguir a estável mais nova e implanta agora
```

O `pin` confere antes se a versão existe. Os dois aceitam um `--now` no final
para não esperar as salas abertas.

### Desligar

Não ative o timer, ou desative:

```
systemctl disable --now telinha-update.timer
```

Os ajustes do `telinha-update` vão num drop-in
(`systemctl edit telinha-update.service`, que o `install-docker.sh` nunca
sobrescreve) como linhas `Environment=`, ou no shell para uma execução na mão:

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `TELINHA_DIR` | `/opt/telinha` | Onde ficam o compose e o estado |
| `MAX_DEFER_HOURS` | `12` | Espera máxima por salas abertas, por versão |
| `VERIFY_ATTESTATION` | vazio | `1`: confere também a atestação da imagem no GitHub com `gh attestation verify`; precisa do `gh` instalado e logado (`GH_TOKEN` no drop-in, ou `gh auth login` como root), senão a implantação é recusada |
| `ALLOW_UNVERIFIED` | vazio | `1`: pula a conferência do digest publicado (saída de emergência, registrada com destaque no log) |

## A partir do código

### Como decide

Quem decide é você: a Telinha roda o que estiver no checkout.

### Quando

Quando você der pull.

### Como

```
git pull
bun install --frozen-lockfile
bun run build
```

Depois reinicie o `bun server/src/index.ts`. Rodando do código, nada é baixado
ao iniciar; quando uma versão fixa programas auxiliares mais novos, a
verificação `binaries` do `bun server/src/index.ts doctor` avisa e mostra o
comando que baixa os programas.

### Voltar atrás

Faça checkout da tag da versão anterior (`git checkout v0.6.0`), depois
instale, compile e reinicie como acima.

### Comandos

`git pull`, `git checkout <tag>` e os comandos de build acima.

### Fixar uma versão

Fique numa tag: `git checkout v0.6.0`.

### Desligar

Nada se atualiza sozinho; não tem o que desligar.

## Conferir uma versão na mão

Toda versão traz o `SHA256SUMS` e uma atestação de proveniência de build do
GitHub que cobre os quatro pacotes do binário, o `telinha-deploy.tar.gz`, o
`telinha-image.digest` e o `SHA256SUMS`. Com os arquivos baixados numa pasta:

```
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify telinha-linux-x64.tar.gz --repo sombraSoft/telinha
gh attestation verify telinha-windows-x64.zip --repo sombraSoft/telinha
```

No Windows, sem `sha256sum`, rode `Get-FileHash telinha-windows-x64.zip` no
PowerShell e compare o hash com a linha do arquivo no `SHA256SUMS`. A imagem
Docker é atestada pelo digest, a linha `sha256:...` do
`telinha-image.digest`:

```
gh attestation verify oci://ghcr.io/sombrasoft/telinha@sha256:... --repo sombraSoft/telinha
```

O atualizador nativo confere o sha256 de cada atualização com o `SHA256SUMS`
da versão; ele não confere a atestação. Os binários do Windows não têm
assinatura de código.
