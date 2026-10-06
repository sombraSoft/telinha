---
title: Perguntas frequentes
description: Respostas sobre custo, domínio, CGNAT, dados, segurança, remoção e o que está planejado.
---

## É grátis?

Sim. A Telinha usa a licença MIT. Os únicos custos são os que você escolher: uma VPS, se a sua rede de casa não puder hospedar, e um domínio, se quiser um próprio (DuckDNS e sslip.io são alternativas gratuitas, veja [Endereço, HTTPS e modos de entrada](/telinha/pt-br/guides/domains/)).

## Por que não usar o Go Live do Discord?

O Go Live é bloqueado no Brasil. A Telinha dá ao grupo a mesma coisa numa máquina que você controla: os membros entram com o Discord, uma verificação de cargo controla o acesso, e o comando `/telinha` abre uma sala e publica um card ao vivo no canal.

## Quantas pessoas podem assistir?

A Telinha não impõe um limite fixo. Quem compartilha envia um único vídeo para o LiveKit, e o LiveKit entrega uma cópia a cada espectador, então o que pesa é a velocidade de upload da máquina que roda a Telinha. Em casa, olhe a velocidade de upload da sua linha; numa VPS, a banda do plano.

## Funciona no celular?

Assistir funciona no navegador do celular. Compartilhar a tela é um recurso do navegador, então depende do que o navegador do celular oferece; o computador é o jeito confiável de compartilhar.

## Quais navegadores compartilham melhor?

Os da família do Chrome. O vídeo usa AV1 quando o navegador tem um codificador por hardware, senão H.265, senão H.264, sempre com uma cópia reserva em H.264 para quem não consegue decodificar a primeira escolha.

## Dá para usar sem domínio?

Dá. Em casa, responda *Não* a *Você tem um domínio na Cloudflare?* no setup: a Telinha usa um nome grátis do DuckDNS, que também acompanha um IP que muda, e serve HTTPS na porta 8443 com um certificado que ela pega pelo DuckDNS, então nada precisa abrir na 80 ou na 443. Os links passam a levar a porta (`https://my-group.duckdns.org:8443/r/...`), e algumas redes rígidas (empresas, escolas) só deixam o navegador chegar na porta 443, então quem estiver nelas não abre; um domínio na Cloudflare (Cloudflare Tunnel) evita isso. Numa VPS com IPv4 público fixo, o sslip.io não exige configuração nenhuma. Veja [Endereço, HTTPS e modos de entrada](/telinha/pt-br/guides/domains/) e [Escolha a sua instalação](/telinha/pt-br/start/choose/).

## Por que o meu link tem :8443?

Porque a Telinha roda em casa com um endereço do DuckDNS. A internet de casa em geral não deixa as portas web 80 e 443 entrarem, então a Telinha serve HTTPS numa porta própria, a 8443 (ou a que você escolheu), e o endereço precisa dizer qual. É um endereço HTTPS normal, com certificado válido. Se quem está numa rede rígida não consegue abrir, use um domínio na Cloudflare: rode `telinha setup` de novo e responda *Sim* a *Você tem um domínio na Cloudflare?* Veja [DuckDNS na porta 8443](/telinha/pt-br/guides/domains/#duckdns-na-porta-8443).

## Dá para rodar atrás de CGNAT?

Em casa, não. Com CGNAT a operadora divide um IPv4 público entre vários clientes e nada da internet chega à sua rede, então encaminhamento de portas e UPnP não ajudam. Peça à operadora um IPv4 público (muitas vezes é de graça) ou rode a Telinha numa VPS pequena. Um Cloudflare Tunnel leva as páginas até você, mas as portas de mídia continuam precisando ser alcançáveis. O `telinha doctor` detecta o problema com a verificação `cgnat`. Um modo LiveKit Cloud, para quem não consegue abrir portas, está planejado. Detalhes: [CGNAT e NAT duplo](/telinha/pt-br/guides/domains/#cgnat-e-nat-duplo).

## Duas instalações da Telinha podem usar o mesmo servidor do Discord?

Podem, desde que cada uma tenha um `COMMAND_NAME` diferente (e o seu próprio aplicativo do Discord), para os comandos de barra não colidirem. Cada instalação atende um servidor do Discord e um cargo.

## Como mudo as configurações?

Rode `telinha setup` de novo: cada pergunta já vem com o valor atual, o Enter mantém um segredo como está, os segredos gerados continuam os mesmos, e as chaves que o setup não administra (`ACME_EMAIL`, `SESSION_DAYS`, ...) ficam guardadas numa seção `Other settings` do arquivo. Na Revisão dá para gerar um novo segredo de cookie, o que desloga todo mundo. Um serviço rodando reinicia com o arquivo novo; uma execução no console precisa ser reiniciada à mão. Ou edite o `telinha.env` e reinicie (`telinha service restart`, ou reinicie o contêiner). Todas as chaves estão em [Configuração](/telinha/pt-br/reference/configuration/).

## Onde ficam os meus dados?

Tudo fica na pasta da Telinha:

| Plataforma | Pasta |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Telinha` |
| Linux, como root | `/opt/telinha` |
| Linux, como usuário | `~/.local/share/telinha` |
| Docker | `/opt/telinha` no host para os arquivos do compose e o `config/telinha.env`, e o volume `telinha-data` para os dados |

Dentro dela (`TELINHA_HOME`, ou `--home DIR` em qualquer comando, aponta para outra):

| Caminho | O que é |
| --- | --- |
| `bin/telinha[.exe]` | O programa (os instaladores e o atualizador escrevem nele) |
| `bin/telinha.old-<version>[.exe]`, `bin/telinha.failed-<tag>[.exe]` | O executável que uma atualização substituiu, ou um que foi revertido; apagado depois da próxima partida bem-sucedida (no Windows, um que o serviço ainda usa fica até o serviço reiniciar) |
| `bin/livekit-server`, `caddy`, `cloudflared` (`.exe` no Windows) e `<tool>.version` | Os binários auxiliares de que esta configuração precisa, conferidos por sha256 quando baixados (pelo setup, ou num início que não os encontra ou os encontra numa versão fixada mais antiga); o `PATH` é consultado depois do `bin/`. O `caddy` é o build do Caddy da própria Telinha (com o módulo DNS do DuckDNS e o layer4), baixado da versão da Telinha e conferido com o `SHA256SUMS` dela |
| `config/telinha.env` | A configuração, só do dono: Linux, instalação de usuário, modo 0600; Linux, instalação como root, `root:telinha` 0640 numa `config/` `root:telinha` 0750 (o serviço lê pelo grupo); no Windows uma ACL só com você, SYSTEM e Administradores |
| `data/telinha.sqlite` | O registro das salas. Se ele se perder, só os links das salas abertas naquele momento deixam de funcionar |
| `data/run/` | O `livekit.yaml` e o `Caddyfile` gerados (reescritos antes de cada início: edite o `telinha.env`, nunca estes) e o estado da execução: `children.json`, `public-ip`, `telinha.pid` (um `run` por pasta), `service.pid`, `control.token`, `update.json`, `upnp.json` |
| `data/caddy/` | Os certificados e a conta ACME do Caddy (modo direto) |
| `logs/telinha.log` (`.1` a `.5`) | O log do serviço no Windows, rotacionado a cada 10 MB (no Linux o log vai para o journal) |
| `service/telinha-task.xml`, `install-result.json` | Windows: a tarefa registrada e o que a instalação elevada fez |

## É seguro deixar exposto?

Todas as páginas ficam atrás do login do Discord e da verificação de cargo. A própria Telinha repassa a sinalização do LiveKit e encaminha só `/livekit/rtc`, então a API do LiveKit nunca fica acessível de fora. Segredos nunca vão na linha de comando (o setup recusa `--discord-token` e parecidos e lê do ambiente ou de um arquivo), e o `telinha.env` só pode ser lido pelo dono (e pelo grupo do serviço numa instalação como root no Linux). Os binários auxiliares são fixados por sha256, e cada versão traz o `SHA256SUMS` e uma atestação de proveniência do build que você pode conferir à mão; os dois cobrem também o build do Caddy da Telinha, veja [Atualizações](/telinha/pt-br/guides/updates/).

## Como removo?

Instalação nativa: remova o serviço e depois apague a pasta da Telinha.

```
telinha service uninstall --firewall
```

No Windows, rode em um terminal de administrador. O `uninstall` mantém os arquivos, então apague a pasta você mesmo depois (veja a tabela acima). Uma instalação Linux como root também tem `/usr/local/lib/telinha` e `/usr/local/bin/telinha`.

Docker:

```
cd /opt/telinha && docker compose down -v
sudo systemctl disable --now telinha-update.timer
sudo rm -f /usr/local/sbin/telinha-update /etc/systemd/system/telinha-update.service /etc/systemd/system/telinha-update.timer
sudo rm -rf /opt/telinha
```

O `down -v` também remove o volume `telinha-data` (o registro das salas e os certificados).

## O que está planejado?

- Windows: um app de bandeja e binários assinados.
- Mídia: LiveKit Cloud (`MEDIA=cloud`) para quem não consegue abrir portas, e TURN sobre TLS na 443 (o módulo layer4 de que isso precisa já está no build do Caddy da Telinha).

Nada disso tem data.
