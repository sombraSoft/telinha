---
title: Assinatura de código
description: Quais programas da Telinha têm assinatura de código, como conferir uma assinatura no Windows, como é um build sem assinatura, e a política de assinatura de código com a declaração de privacidade.
sidebar:
  order: 7
---

Os programas para Windows de uma versão da Telinha, o `telinha.exe` e o
`telinha-tray.exe`, recebem uma assinatura Authenticode no workflow de
lançamento. Free code signing provided by [SignPath.io](https://signpath.io),
certificate by [SignPath Foundation](https://signpath.org). (Assinatura de
código gratuita oferecida pela SignPath.io, certificado da SignPath
Foundation.)

Uma assinatura diz ao Windows, e a você, quem publicou o arquivo e que ninguém
mexeu nele desde então. Os binários do Linux não são assinados; todo pacote de
uma versão, nos dois sistemas, também é coberto pelo `SHA256SUMS` da versão e
por uma atestação de build do GitHub, como descrito em
[Conferir uma versão na mão](/telinha/pt-br/guides/updates/#conferir-uma-versão-na-mão).

## Conferindo uma assinatura

**No Explorador de Arquivos.** Clique com o botão direito no `telinha.exe` (em
`%LOCALAPPDATA%\Telinha\bin` depois de instalado) → *Propriedades* →
*Assinaturas Digitais*. A lista mostra quem assinou e quando;
*Detalhes* → *Exibir Certificado* mostra o certificado. Um arquivo sem
assinatura não tem a aba *Assinaturas Digitais*. A aba *Detalhes* mostra o
nome do produto `Telinha` e a versão.

**No PowerShell:**

```powershell
Get-AuthenticodeSignature "$env:LOCALAPPDATA\Telinha\bin\telinha.exe" | Format-List Status, StatusMessage, SignerCertificate
```

`Valid` quer dizer assinado, pelo certificado mostrado, e sem mudança desde
então. `NotSigned` é um build sem assinatura. `HashMismatch` quer dizer que o
arquivo foi alterado depois de assinado: não rode.

**Com a Telinha.** A verificação `tray` do
[`telinha doctor`](/telinha/pt-br/guides/doctor/) acrescenta `assinado por …`
ou `sem assinatura de código` para o arquivo do
[ícone na bandeja](/telinha/pt-br/guides/tray/).

## Como é um build sem assinatura

Só os builds feitos pelo workflow de lançamento são assinados. Uma versão
também pode sair sem assinatura, e tudo que você compila por conta própria
(`bun run compile`) não tem assinatura. Um build assim funciona igual, mas o
Windows diz menos sobre ele:

- Um zip baixado à mão da página de versões pode ser barrado pela tela do
  SmartScreen *O Windows protegeu o computador*. Clique em *Mais informações*,
  confira o nome do arquivo e depois em *Executar assim mesmo*. (O instalador
  de PowerShell baixa o zip ele mesmo e confere o sha256, então essa tela não
  aparece por ali.)
- O pedido de administrador (UAC) do setup mostra
  *Editor: Desconhecido*. *Mostrar mais detalhes* mostra o caminho: deve ser o
  `telinha.exe` em `%LOCALAPPDATA%\Telinha\bin`.

Um build assinado mostra o editor nos dois lugares. Uma versão nova ainda pode
encontrar o SmartScreen por um tempo, até o Windows ter visto o certificado o
bastante; *Mais informações* então mostra o editor, não *Editor desconhecido*.

## Política de assinatura de código

Esta política cobre os programas para Windows assinados pela SignPath
Foundation para o [projeto Telinha](https://github.com/sombraSoft/telinha).

### Papéis da equipe

- **Committers:** os mantenedores com acesso de escrita ao repositório
  ([sombraSoft](https://github.com/sombraSoft)). Eles podem mudar o código sem
  outra revisão.
- **Reviewers (revisores):** toda mudança de qualquer outra pessoa, como um
  pull request de um colaborador, é revisada por um committer antes do merge.
- **Approvers (aprovadores):** um mantenedor aprova à mão cada pedido de
  assinatura antes de qualquer coisa ser assinada.

Os membros da equipe usam autenticação de múltiplos fatores no GitHub e na
SignPath.

### O que é assinado

Só o `telinha.exe` (os builds `windows-x64` e `windows-arm64`) e o
`telinha-tray.exe`, compilados do código da própria Telinha pelo workflow de
lançamento no GitHub Actions, a partir do commit da versão na `main`. Nunca
builds locais, builds de pull request nem builds de um fork. Todo arquivo
assinado traz o nome de produto `Telinha` e a versão.

Os programas auxiliares que a Telinha baixa não são assinados por este
projeto: o `livekit-server.exe` e o `cloudflared.exe` vêm das versões dos
próprios autores do jeito que estão, e o build do `caddy.exe` da Telinha não é
assinado.

### Privacidade

This program will not transfer any information to other networked systems
unless specifically requested by the user. (Este programa não transfere
nenhuma informação para outros sistemas em rede a menos que o usuário peça
especificamente.)

A Telinha é um servidor: hospedar salas de compartilhamento de tela para o seu
servidor do Discord é o que você pede para ela fazer. Estes são todos os
sistemas com que uma Telinha configurada fala para isso, cada um com a chave do
`telinha.env` que controla ele.

**Sempre, enquanto ela roda:**

- **Discord** (`discord.com` e o gateway dele): a conexão e as chamadas de API
  do bot (o comando de barra, os cartões das salas, a lista de membros com
  presença) e o login de cada participante pelo Discord (OAuth2). Usa
  `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET`.
- **Os navegadores dos participantes:** as páginas, e o vídeo pelo LiveKit,
  que roda nesta máquina. As páginas carregam os avatares do servidor de
  imagens do Discord (`cdn.discordapp.com`), e o LiveKit passa aos navegadores
  os servidores STUN embutidos nele (`stun.l.google.com`, `stun1.l.google.com`
  e `global.stun.twilio.com`) para eles acharem o próprio endereço público. A
  Telinha não configura nenhum outro.
- **As consultas STUN do LiveKit:** a cada início o LiveKit pergunta a esses
  mesmos servidores STUN o IP público desta máquina, a menos que a
  `LIVEKIT_NODE_IP` esteja definida.
- **GitHub, para os programas auxiliares** (instalações nativas): o
  `livekit-server` das versões do LiveKit, o `cloudflared` das da Cloudflare
  (com túnel) e o `caddy` da própria versão da Telinha (com `INGRESS=direct`),
  baixados de `github.com` quando um falta ou quando uma versão nova da Telinha
  fixa outra versão, cada um conferido com um sha256.

**Ligado por padrão, e dá para desligar:**

- **Consultas do IP público** em `https://1.1.1.1/cdn-cgi/trace`, e em
  `https://api.ipify.org` se essa falhar: a cada `IP_WATCH_SECONDS` (300) para
  perceber um IP novo em casa, e a cada 5 minutos para o DuckDNS.
  `IP_WATCH_SECONDS=0` desliga a vigilância; uma `LIVEKIT_NODE_IP` fixa desliga
  as duas.
- **Verificação de atualizações no GitHub** (instalações nativas):
  `https://github.com/sombraSoft/telinha/releases/latest` alguns minutos
  depois do início e depois a cada `UPDATE_CHECK_HOURS`, e o pacote da versão e
  o `SHA256SUMS` dela ao instalar. O `telinha setup` pergunta;
  `AUTO_UPDATE=off` desliga.
- **O roteador, na sua rede local,** por UPnP, NAT-PMP e PCP, para encaminhar
  as portas que a Telinha precisa e ler o IP externo dele. `UPNP=off` desliga.

**Só quando você escolhe:**

- **Let's Encrypt**, com `INGRESS=direct`: o Caddy obtém e renova o
  certificado HTTPS com ele, pelas portas 80 e 443 (o Let's Encrypt conecta de
  volta para conferir) ou, com `ACME_DNS=duckdns`, por um registro DNS que o
  Caddy cria no DuckDNS e depois consulta em 1.1.1.1 e 8.8.8.8. Com
  `ACME_EMAIL` definida e sem `ACME_DNS`, o ZeroSSL é a alternativa quando o
  Let's Encrypt falha, e o endereço vai para os dois.
- **DuckDNS**, com `DDNS_PROVIDER=duckdns`: `https://www.duckdns.org/update`
  com `DUCKDNS_DOMAIN` e `DUCKDNS_TOKEN`, a cada 5 minutos e quando o IP muda.
- **Cloudflare Tunnel**, com `INGRESS=tunnel`: o `cloudflared` mantém conexões
  de saída com a Cloudflare, que levam as páginas, usando o `TUNNEL_TOKEN`. Ele
  roda com a própria verificação de atualizações desligada.

**Quando você roda um comando.** O `telinha setup`, o `telinha doctor`, o
`telinha update`, os instaladores e o menu do ícone na bandeja fazem algumas
dessas mesmas chamadas quando você usa eles: a API do Discord (para conferir o
token, as intents, o servidor do Discord, o cargo, os canais e o redirect do login), as
consultas do IP público, o registro DNS do endereço em 1.1.1.1 e 8.8.8.8, um
acesso à sua própria `PUBLIC_URL` (o certificado e o `/healthz`), uma conferência do token do
DuckDNS, o teste do roteador e as versões no GitHub. O teste pelo celular do
doctor é uma página que o seu celular abre na sua própria Telinha.

A Telinha não coleta telemetria: nenhuma estatística de uso, relatório de
falha ou análise vai para os autores dela nem para mais ninguém.
