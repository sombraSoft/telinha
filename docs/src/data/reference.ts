// The prose of the reference pages, keyed by the code's own identifiers (env
// keys, flag names, service actions, doctor check ids) in EN and pt-BR. The
// drift tests in docs/scripts compare every table with the server code, so a
// key, flag or check added or renamed there fails until its row exists here.
// Backticks in a text render as code (the components split on them).
import type { Config } from '../../../server/src/config.ts';

export type Locale = 'en' | 'pt-BR';
export interface L { en: string; 'pt-BR': string }

export type Section = 'discord' | 'ingress' | 'media' | 'rooms' | 'native' | 'paths' | 'dev';

export interface ConfigKeyDoc {
  section: Section;
  /** 'yes' | 'no' | the condition under which the key is required. */
  required: 'yes' | 'no' | L;
  /** Reads the default off a loaded Config; the test compares String(probe(c)) with `default`. */
  probe?: (c: Config) => unknown;
  /** The default as shown; a string must equal the probe, free text (an L) is for keys without one. */
  default?: string | L;
  notes: L;
}

export interface FlagDoc extends L {
  /** Placeholder for the value column, e.g. 'URL'; booleans have none. */
  value?: string;
  /** setup: the telinha.env key(s) the flag fills. */
  sets?: string;
  /** Shown as --no-<name>: the flag is on by default and only ever turned off. */
  negated?: boolean;
  /** Used by the service loop or the elevated Windows install, not by hand. */
  internal?: boolean;
}

export interface CheckDoc { looksAt: L; fixes: L }

const yes = 'yes' as const;
const no = 'no' as const;
const none: L = { en: 'none', 'pt-BR': 'nenhum' };

export const SECTION_TITLES: Record<Section, L> = {
  discord: { en: 'Identity and Discord', 'pt-BR': 'Identidade e Discord' },
  ingress: { en: 'Public URL and HTTP ingress', 'pt-BR': 'URL pública e entrada HTTP' },
  media: { en: 'Media (LiveKit)', 'pt-BR': 'Mídia (LiveKit)' },
  rooms: { en: 'Rooms', 'pt-BR': 'Salas' },
  native: { en: 'Native install', 'pt-BR': 'Instalação nativa' },
  paths: { en: 'Locations', 'pt-BR': 'Locais' },
  dev: { en: 'Dev only', 'pt-BR': 'Só desenvolvimento' },
};

export const CONFIG_KEYS: Record<string, ConfigKeyDoc> = {
  // --- Identity and Discord ---
  DISCORD_TOKEN: {
    section: 'discord', required: yes,
    notes: {
      en: 'Bot token: Developer Portal → your app → Bot → Reset Token. On the same page switch on Server Members Intent and Presence Intent (the setup does it through the API).',
      'pt-BR': 'Token do bot: Developer Portal → seu app → Bot → Reset Token. Na mesma página, ligue Server Members Intent e Presence Intent (o setup faz isso pela API).',
    },
  },
  DISCORD_CLIENT_ID: {
    section: 'discord', required: yes,
    notes: {
      en: 'The application id (OAuth2 page). The setup reads it from the bot token.',
      'pt-BR': 'O id da aplicação (página OAuth2). O setup lê do token do bot.',
    },
  },
  DISCORD_CLIENT_SECRET: {
    section: 'discord', required: yes,
    notes: {
      en: 'OAuth2 → Client Secret → Reset Secret. The login redirect `<PUBLIC_URL>/auth/callback` must be registered under OAuth2 → Redirects.',
      'pt-BR': 'OAuth2 → Client Secret → Reset Secret. O redirect de login `<PUBLIC_URL>/auth/callback` precisa estar cadastrado em OAuth2 → Redirects.',
    },
  },
  GUILD_ID: {
    section: 'discord', required: yes,
    notes: {
      en: 'The one Discord server this deployment serves.',
      'pt-BR': 'O único servidor do Discord que esta instalação atende.',
    },
  },
  ROLE_ID: {
    section: 'discord', required: yes,
    notes: {
      en: 'Members with this role may enter.',
      'pt-BR': 'Membros com este cargo podem entrar.',
    },
  },
  CHANNEL_IDS: {
    section: 'discord', required: yes,
    notes: {
      en: 'Comma-separated channel ids; the slash command works only there (text or announcement channels).',
      'pt-BR': 'Ids de canal separados por vírgula; o comando de barra só funciona neles (canais de texto ou de anúncios).',
    },
  },
  COMMAND_NAME: {
    section: 'discord', required: no, probe: (c) => c.commandName, default: 'telinha',
    notes: {
      en: 'Slash command name: lowercase, 1-32 letters, digits, `-` or `_`. Two deployments in one server need different names.',
      'pt-BR': 'Nome do comando de barra: minúsculas, 1-32 letras, dígitos, `-` ou `_`. Duas instalações no mesmo servidor precisam de nomes diferentes.',
    },
  },
  GROUP_NAME: {
    section: 'discord', required: no, default: { en: "the Discord server's name", 'pt-BR': 'o nome do servidor do Discord' },
    notes: {
      en: "Shown in the pages and in the command's replies.",
      'pt-BR': 'Aparece nas páginas e nas respostas do comando.',
    },
  },
  COOKIE_SECRET: {
    section: 'discord', required: yes,
    notes: {
      en: 'Random; `openssl rand -base64 48`. The setup generates it; a new one logs everyone out.',
      'pt-BR': 'Aleatório; `openssl rand -base64 48`. O setup gera; um novo desloga todo mundo.',
    },
  },
  SESSION_DAYS: {
    section: 'discord', required: no, probe: (c) => c.sessionSeconds / 86400, default: '7',
    notes: { en: 'Login session length, in days.', 'pt-BR': 'Duração da sessão de login, em dias.' },
  },
  ROLE_CACHE_SECONDS: {
    section: 'discord', required: no, probe: (c) => c.roleTtlMs / 1000, default: '300',
    notes: {
      en: "How long a member's role check is cached, in seconds.",
      'pt-BR': 'Por quanto tempo a verificação de cargo de um membro fica em cache, em segundos.',
    },
  },

  // --- Public URL and HTTP ingress ---
  PUBLIC_URL: {
    section: 'ingress', required: yes,
    notes: {
      en: 'What people open: `https://host[:port]`. At home with DuckDNS the port is part of it (`https://my-group.duckdns.org:8443`). `http://localhost[:port]` only with `DEV_USER`.',
      'pt-BR': 'O que as pessoas abrem: `https://host[:porta]`. Em casa com DuckDNS a porta faz parte dele (`https://meu-grupo.duckdns.org:8443`). `http://localhost[:porta]` só com `DEV_USER`.',
    },
  },
  HOSTING: {
    section: 'ingress', required: no, default: { en: 'unset', 'pt-BR': 'vazio' },
    notes: {
      en: '`home` or `vps`: where Telinha runs, as answered in `telinha setup`. A re-run of the setup starts from it and the doctor words its advice by it; `telinha run` behaves the same either way.',
      'pt-BR': '`home` ou `vps`: onde a Telinha roda, como respondido no `telinha setup`. Uma nova rodada do setup parte dele e o doctor ajusta os conselhos por ele; o `telinha run` se comporta igual nos dois casos.',
    },
  },
  INGRESS: {
    section: 'ingress', required: no, probe: (c) => c.ingress, default: 'direct',
    notes: {
      en: '`direct`: the bundled Caddy gets a certificate (see `ACME_DNS`) and binds `HTTPS_PORT` (and `HTTP_PORT` unless it is `0`): 443 on a VPS, 8443 at home with DuckDNS. `tunnel`: Cloudflare Tunnel, no open HTTP ports; the home choice with a domain on Cloudflare. `external`: your own reverse proxy forwards to `LISTEN`. With `DEV_USER` the default is `external`.',
      'pt-BR': '`direct`: o Caddy embutido obtém o certificado (veja `ACME_DNS`) e escuta na `HTTPS_PORT` (e na `HTTP_PORT`, a menos que seja `0`): 443 numa VPS, 8443 em casa com DuckDNS. `tunnel`: Cloudflare Tunnel, sem portas HTTP abertas; a escolha em casa com um domínio na Cloudflare. `external`: seu próprio proxy reverso encaminha para `LISTEN`. Com `DEV_USER` o padrão é `external`.',
    },
  },
  LISTEN: {
    section: 'ingress', required: no, probe: (c) => `${c.host}:${c.port}`, default: '127.0.0.1:8081',
    notes: {
      en: "Telinha's own listener; Caddy, cloudflared or your proxy forward here. Loopback only, never forwarded on the router.",
      'pt-BR': 'O listener da própria Telinha; o Caddy, o cloudflared ou o seu proxy encaminham para cá. Só loopback, nunca encaminhado no roteador.',
    },
  },
  HTTP_PORT: {
    section: 'ingress', required: no, probe: (c) => c.httpPort, default: '80',
    notes: {
      en: 'direct: the HTTP→HTTPS redirect and Let’s Encrypt HTTP challenge port (a VPS); `0` turns that listener off. Always `0` at home, where the certificate comes through DuckDNS (`ACME_DNS=duckdns`).',
      'pt-BR': 'direct: a porta do redirecionamento HTTP→HTTPS e do desafio HTTP do Let’s Encrypt (uma VPS); `0` desliga esse listener. Sempre `0` em casa, onde o certificado vem pelo DuckDNS (`ACME_DNS=duckdns`).',
    },
  },
  HTTPS_PORT: {
    section: 'ingress', required: no, probe: (c) => c.httpsPort, default: '443',
    notes: {
      en: 'direct: the port Caddy binds for TLS: 443 on a VPS; at home a high port (8443) that `PUBLIC_URL` also carries. A `PUBLIC_URL` port that differs from it is only a warning.',
      'pt-BR': 'direct: a porta em que o Caddy escuta com TLS: 443 numa VPS; em casa uma porta alta (8443) que a `PUBLIC_URL` também leva. Uma porta da `PUBLIC_URL` diferente dela gera só um aviso.',
    },
  },
  ACME_EMAIL: {
    section: 'ingress', required: no, default: none,
    notes: {
      en: "direct, optional: the Let's Encrypt account email.",
      'pt-BR': "direct, opcional: o e-mail da conta no Let's Encrypt.",
    },
  },
  ACME_DNS: {
    section: 'ingress', required: no, probe: (c) => c.acmeDns?.provider ?? 'none', default: 'none',
    notes: {
      en: 'direct only: how Caddy proves the name to Let’s Encrypt. `duckdns` = DNS challenge through the DuckDNS API with `DUCKDNS_TOKEN`, the home default: nothing on 80 or 443, HTTPS on `HTTPS_PORT`, and the `PUBLIC_URL` host must be under `duckdns.org`. `none` = HTTP challenge over public port 80 (a VPS), or TLS-ALPN over 443 when `HTTP_PORT=0`.',
      'pt-BR': 'Só direct: como o Caddy prova o nome para o Let’s Encrypt. `duckdns` = desafio DNS pela API do DuckDNS com o `DUCKDNS_TOKEN`, o padrão em casa: nada na 80 nem na 443, HTTPS na `HTTPS_PORT`, e o host da `PUBLIC_URL` precisa estar sob `duckdns.org`. `none` = desafio HTTP pela porta pública 80 (uma VPS), ou TLS-ALPN pela 443 quando `HTTP_PORT=0`.',
    },
  },
  TUNNEL_TOKEN: {
    section: 'ingress', required: { en: 'with `INGRESS=tunnel`', 'pt-BR': 'com `INGRESS=tunnel`' },
    notes: {
      en: "The tunnel's token (Cloudflare Zero Trust → Networks → Tunnels). Its public hostname points at `http://localhost:<LISTEN port>`.",
      'pt-BR': 'O token do túnel (Cloudflare Zero Trust → Networks → Tunnels). O hostname público dele aponta para `http://localhost:<porta do LISTEN>`.',
    },
  },
  DDNS_PROVIDER: {
    section: 'ingress', required: no, probe: (c) => (c.ddns ? 'duckdns' : 'none'), default: 'none',
    notes: {
      en: '`duckdns` keeps `<DUCKDNS_DOMAIN>.duckdns.org` pointing at this network whenever the public IP changes.',
      'pt-BR': '`duckdns` mantém `<DUCKDNS_DOMAIN>.duckdns.org` apontando para esta rede sempre que o IP público muda.',
    },
  },
  DUCKDNS_DOMAIN: {
    section: 'ingress', required: { en: 'with `DDNS_PROVIDER=duckdns`', 'pt-BR': 'com `DDNS_PROVIDER=duckdns`' },
    notes: {
      en: 'The subdomain alone, without `.duckdns.org` (`a-z`, `0-9`, `-`).',
      'pt-BR': 'Só o subdomínio, sem `.duckdns.org` (`a-z`, `0-9`, `-`).',
    },
  },
  DUCKDNS_TOKEN: {
    section: 'ingress', required: { en: 'with `DDNS_PROVIDER=duckdns` or `ACME_DNS=duckdns`', 'pt-BR': 'com `DDNS_PROVIDER=duckdns` ou `ACME_DNS=duckdns`' },
    notes: {
      en: 'The token shown on duckdns.org after signing in. It keeps the name pointed at this network and, with `ACME_DNS=duckdns`, answers the certificate’s DNS challenge. Caddy gets it only through its environment: never in the rendered `Caddyfile`, and blanked out of its log lines.',
      'pt-BR': 'O token mostrado no duckdns.org depois de entrar. Ele mantém o nome apontando para esta rede e, com `ACME_DNS=duckdns`, responde o desafio DNS do certificado. O Caddy recebe ele só pelo ambiente: nunca no `Caddyfile` renderizado, e apagado das linhas de log dele.',
    },
  },

  // --- Media (LiveKit) ---
  MEDIA: {
    section: 'media', required: no, probe: (c) => c.media, default: 'self',
    notes: {
      en: '`self` runs the bundled `livekit-server` on this machine, and the media ports must reach it. `cloud` uses a LiveKit Cloud project at `LIVEKIT_CLOUD_URL` instead: no LiveKit child and no media port to open. Its free Build plan allows 5,000 participant-minutes and 50 GB downstream a month, with up to 100 participants connected at once, as a hard cap. Turn automatic room creation off in the project’s settings: Telinha creates and deletes rooms itself.',
      'pt-BR': '`self` roda o `livekit-server` embutido nesta máquina, e as portas de mídia precisam chegar nele. `cloud` usa um projeto do LiveKit Cloud em `LIVEKIT_CLOUD_URL` no lugar: nenhum LiveKit filho e nenhuma porta de mídia para abrir. O plano gratuito Build permite 5.000 participante-minutos e 50 GB de download por mês, com até 100 participantes conectados ao mesmo tempo, como teto rígido. Desligue a criação automática de salas nas configurações do projeto: a Telinha cria e apaga as salas sozinha.',
    },
  },
  LIVEKIT_API_KEY: {
    section: 'media', required: yes,
    notes: {
      en: '`self`: any key you make up (`openssl rand -hex 16`), handed to LiveKit through its environment; the setup generates it. `cloud`: the project’s API key (Settings → Keys).',
      'pt-BR': '`self`: qualquer chave que você inventar (`openssl rand -hex 16`), entregue ao LiveKit pelo ambiente; o setup gera. `cloud`: a chave de API do projeto (Settings → Keys).',
    },
  },
  LIVEKIT_API_SECRET: {
    section: 'media', required: yes,
    notes: {
      en: '`self`: its secret, 32+ characters (`openssl rand -base64 32`); the setup generates it. `cloud`: the secret of the project’s key pair.',
      'pt-BR': '`self`: o segredo correspondente, 32+ caracteres (`openssl rand -base64 32`); o setup gera. `cloud`: o segredo do par de chaves do projeto.',
    },
  },
  LIVEKIT_CLOUD_URL: {
    section: 'media', required: { en: 'with `MEDIA=cloud`', 'pt-BR': 'com `MEDIA=cloud`' },
    notes: {
      en: 'The LiveKit Cloud project’s URL (Settings → Project), `wss://<project>.livekit.cloud`; `https://` works too, and a pasted path, query or trailing slash is dropped. Browsers connect to it directly and Telinha calls its room API over `https://`. `ws://` or `http://` only with `DEV_USER`.',
      'pt-BR': 'A URL do projeto no LiveKit Cloud (Settings → Project), `wss://<projeto>.livekit.cloud`; `https://` também serve, e um caminho, query ou barra final colados são descartados. Os navegadores se conectam direto nela e a Telinha chama a API de salas dela por `https://`. `ws://` ou `http://` só com `DEV_USER`.',
    },
  },
  LIVEKIT_PORT: {
    section: 'media', required: no, probe: (c) => c.livekitPort, default: '7880',
    notes: {
      en: "`MEDIA=self` only: LiveKit's signaling/API port, loopback only; never forwarded.",
      'pt-BR': 'Só `MEDIA=self`: a porta de sinalização/API do LiveKit, só loopback; nunca encaminhada.',
    },
  },
  MEDIA_TCP_PORT: {
    section: 'media', required: no, probe: (c) => c.mediaTcpPort, default: '7881',
    notes: {
      en: '`MEDIA=self` only: WebRTC media over TCP (the fallback where UDP is blocked). Forward it on the router in every ingress mode.',
      'pt-BR': 'Só `MEDIA=self`: mídia WebRTC por TCP (o caminho reserva onde o UDP é bloqueado). Encaminhe no roteador em qualquer modo de entrada.',
    },
  },
  MEDIA_UDP_PORT: {
    section: 'media', required: no, probe: (c) => c.mediaUdpPort, default: '7882',
    notes: {
      en: '`MEDIA=self` only: WebRTC media over UDP (the normal path). Forward it on the router in every ingress mode.',
      'pt-BR': 'Só `MEDIA=self`: mídia WebRTC por UDP (o caminho normal). Encaminhe no roteador em qualquer modo de entrada.',
    },
  },
  UPNP: {
    section: 'media', required: no, probe: (c) => (c.upnp ? 'auto' : 'off'), default: 'auto',
    notes: {
      en: '`auto` asks the router (UPnP IGD, NAT-PMP or PCP) to forward the media ports (`MEDIA=self`), and in direct mode `HTTPS_PORT` when the `PUBLIC_URL` port is not 443 (8443 at home), while Telinha runs; never 80 or 443. `off` when you forward by hand; the setup sets `off` on a VPS.',
      'pt-BR': '`auto` pede ao roteador (UPnP IGD, NAT-PMP ou PCP) para encaminhar as portas de mídia (`MEDIA=self`), e no modo direct a `HTTPS_PORT` quando a porta da `PUBLIC_URL` não é 443 (8443 em casa), enquanto a Telinha roda; nunca a 80 nem a 443. `off` quando você encaminha à mão; o setup põe `off` numa VPS.',
    },
  },
  LIVEKIT_NODE_IP: {
    section: 'media', required: no, default: none,
    notes: {
      en: 'Static public IPv4 of this machine (a VPS): skips STUN and turns the IP watch off.',
      'pt-BR': 'IPv4 público fixo desta máquina (uma VPS): pula o STUN e desliga a vigilância do IP.',
    },
  },
  LIVEKIT_API_URL: {
    section: 'media', required: no, probe: (c) => c.livekitApiUrl, default: 'http://127.0.0.1:7880',
    notes: {
      en: "`MEDIA=self` only: LiveKit's HTTP API as Telinha reaches it; the default follows `LIVEKIT_PORT`.",
      'pt-BR': 'Só `MEDIA=self`: a API HTTP do LiveKit como a Telinha a alcança; o padrão segue `LIVEKIT_PORT`.',
    },
  },
  LIVEKIT_PUBLIC_URL: {
    section: 'media', required: no, default: { en: '`PUBLIC_URL` as `wss://` + `/livekit`', 'pt-BR': 'a `PUBLIC_URL` como `wss://` + `/livekit`' },
    notes: {
      en: "`MEDIA=self` only: the signaling URL browsers use; Telinha relays it, so LiveKit's own API never faces the internet.",
      'pt-BR': 'Só `MEDIA=self`: a URL de sinalização que os navegadores usam; a Telinha faz o relay, então a API do LiveKit nunca fica exposta à internet.',
    },
  },
  IP_WATCH_SECONDS: {
    section: 'media', required: no, probe: (c) => c.ipWatchSeconds, default: '300',
    notes: {
      en: 'How often the public IP is checked; on a change the router mappings are renewed, DuckDNS is nudged and (`MEDIA=self`) the LiveKit child restarts. `0` = off; forced off by `LIVEKIT_NODE_IP`.',
      'pt-BR': 'De quanto em quanto tempo o IP público é conferido; numa mudança os mapeamentos do roteador são renovados, o DuckDNS é avisado e (`MEDIA=self`) o LiveKit reinicia. `0` = desligado; desligado também por `LIVEKIT_NODE_IP`.',
    },
  },
  TURN: {
    section: 'media', required: no, probe: (c) => c.turnSetting, default: 'auto',
    notes: {
      en: 'TURN over TLS on port 443, for viewers on networks that only let 443 through: Caddy routes `turn.<host>` to LiveKit’s TURN. Only for a VPS in direct mode on 443 with `MEDIA=self`. `auto` turns it on only for a VPS install (`HOSTING=vps`) with a DuckDNS or sslip.io name, where `turn.<host>` resolves by itself; with your own domain, or a file without `HOSTING`, create the DNS record `turn.<host>` and set `on`. `on` where it cannot run stops the start with the reason; `off` never.',
      'pt-BR': 'TURN sobre TLS na porta 443, para quem assiste de uma rede que só deixa a 443 passar: o Caddy leva o `turn.<host>` até o TURN do LiveKit. Só para uma VPS no modo direct na 443 com `MEDIA=self`. `auto` liga só numa instalação de VPS (`HOSTING=vps`) com um nome do DuckDNS ou do sslip.io, onde o `turn.<host>` resolve sozinho; com um domínio próprio, ou um arquivo sem `HOSTING`, crie o registro DNS `turn.<host>` e ponha `on`. `on` onde ele não pode rodar impede a inicialização com o motivo; `off` nunca.',
    },
  },
  TURN_PORT: {
    section: 'media', required: no, probe: (c) => c.turnPort, default: '5349',
    notes: {
      en: 'With TURN on: the local TCP port LiveKit’s TURN listens on. Caddy terminates TLS on 443 and forwards the plain stream here with a PROXY protocol header carrying the viewer’s address; LiveKit accepts only Caddy’s connections from the same machine and closes any other. Never forwarded; keep it closed in the firewall anyway.',
      'pt-BR': 'Com o TURN ligado: a porta TCP local em que o TURN do LiveKit escuta. O Caddy termina o TLS na 443 e repassa o fluxo puro para cá com um cabeçalho PROXY protocol que leva o endereço de quem assiste; o LiveKit só aceita as conexões do Caddy na mesma máquina e fecha qualquer outra. Nunca encaminhada; mantenha fechada no firewall mesmo assim.',
    },
  },

  // --- Rooms ---
  CLOSE_EMPTY_SECONDS: {
    section: 'rooms', required: no, probe: (c) => c.closeEmptySeconds, default: '300',
    notes: {
      en: 'A room closes for good after this many seconds with nobody in it (counted from its opening when nobody ever joins).',
      'pt-BR': 'Uma sala fecha de vez depois de tantos segundos sem ninguém dentro (contados da abertura quando ninguém chega a entrar).',
    },
  },
  POLL_SECONDS: {
    section: 'rooms', required: no, probe: (c) => c.pollSeconds, default: '5',
    notes: { en: 'How often rooms are checked.', 'pt-BR': 'De quanto em quanto tempo as salas são conferidas.' },
  },

  // --- Native install ---
  AUTO_UPDATE: {
    section: 'native', required: no, probe: (c) => (c.autoUpdate ? 'on' : 'off'), default: 'on',
    notes: {
      en: '`on` installs new stable releases by itself once no room is open. The default is `on` in the native binary only; in Docker and from source it is always `off` (`on` there is a warning and ignored; Docker has `telinha-update`).',
      'pt-BR': '`on` instala novas versões estáveis sozinha quando nenhuma sala está aberta. O padrão é `on` só no binário nativo; no Docker e a partir do código-fonte é sempre `off` (`on` ali gera um aviso e é ignorado; o Docker tem o `telinha-update`).',
    },
  },
  UPDATE_PIN: {
    section: 'native', required: no, default: none,
    notes: {
      en: 'A release tag (`v0.7.0`, `v0.7.0-rc.1`) to install and stay on; pre-releases and downgrades allowed.',
      'pt-BR': 'Uma tag de versão (`v0.7.0`, `v0.7.0-rc.1`) para instalar e manter; pré-lançamentos e downgrades permitidos.',
    },
  },
  UPDATE_CHECK_HOURS: {
    section: 'native', required: no, probe: (c) => c.updateCheckHours, default: '6',
    notes: { en: 'How often to look for a new release, in hours (1-168).', 'pt-BR': 'De quanto em quanto tempo procurar uma versão nova, em horas (1-168).' },
  },
  UPDATE_MAX_DEFER_HOURS: {
    section: 'native', required: no, probe: (c) => c.updateMaxDeferHours, default: '12',
    notes: {
      en: 'Longest wait for open rooms before an update is applied anyway, in hours (0-720); `0` = do not wait.',
      'pt-BR': 'Espera máxima por salas abertas antes de aplicar a atualização mesmo assim, em horas (0-720); `0` = não esperar.',
    },
  },
  LOCALE: {
    section: 'native', required: no, default: { en: 'the system language', 'pt-BR': 'o idioma do sistema' },
    notes: {
      en: '`en` or `pt-BR` for the command line and the setup; the pages follow the browser. `--lang` overrides it.',
      'pt-BR': '`en` ou `pt-BR` para a linha de comando e o setup; as páginas seguem o navegador. `--lang` sobrepõe.',
    },
  },

  // --- Locations ---
  TELINHA_HOME: {
    section: 'paths', required: no, default: { en: 'per platform (see above)', 'pt-BR': 'por plataforma (veja acima)' },
    notes: {
      en: 'Root of `bin/`, `config/`, `data/` and `logs/`; the Docker image sets `/telinha`. `--home DIR` on any command is the same thing.',
      'pt-BR': 'Raiz de `bin/`, `config/`, `data/` e `logs/`; a imagem Docker usa `/telinha`. `--home DIR` em qualquer comando é a mesma coisa.',
    },
  },
  TELINHA_ENV: {
    section: 'paths', required: no, default: { en: '`<TELINHA_HOME>/config/telinha.env`', 'pt-BR': '`<TELINHA_HOME>/config/telinha.env`' },
    notes: {
      en: 'Which file to load; only meaningful as a real environment variable.',
      'pt-BR': 'Qual arquivo carregar; só faz sentido como variável de ambiente de verdade.',
    },
  },
  DATA_DIR: {
    section: 'paths', required: no, default: { en: '`<TELINHA_HOME>/data`', 'pt-BR': '`<TELINHA_HOME>/data`' },
    notes: {
      en: 'The room registry (`telinha.sqlite`), rendered `livekit.yaml`/`Caddyfile` and state (`run/`), Caddy certificates (`caddy/`).',
      'pt-BR': 'O registro de salas (`telinha.sqlite`), o `livekit.yaml`/`Caddyfile` renderizados e o estado (`run/`), os certificados do Caddy (`caddy/`).',
    },
  },
  BIN_DIR: {
    section: 'paths', required: no, default: { en: '`<TELINHA_HOME>/bin`', 'pt-BR': '`<TELINHA_HOME>/bin`' },
    notes: {
      en: 'Where `livekit-server`, `caddy` and `cloudflared` are looked for before `PATH`.',
      'pt-BR': 'Onde `livekit-server`, `caddy` e `cloudflared` são procurados antes do `PATH`.',
    },
  },
  WEB_DIR: {
    section: 'paths', required: no, default: { en: 'the page inside the native binary, else `web/dist` next to the sources', 'pt-BR': 'a página dentro do binário nativo, senão `web/dist` ao lado do código-fonte' },
    notes: { en: 'The built web app.', 'pt-BR': 'O aplicativo web compilado.' },
  },

  // --- Dev only ---
  DEV_USER: {
    section: 'dev', required: { en: 'dev only', 'pt-BR': 'só em desenvolvimento' },
    notes: {
      en: 'Fake login `<digits>:<name>` for local development; never set it on a real install. Refused unless `PUBLIC_URL` is `http://localhost` or `http://127.0.0.1`, `LISTEN` is loopback and `INGRESS` is `external`.',
      'pt-BR': 'Login falso `<dígitos>:<nome>` para desenvolvimento local; nunca defina numa instalação de verdade. Recusado a menos que a `PUBLIC_URL` seja `http://localhost` ou `http://127.0.0.1`, o `LISTEN` seja loopback e o `INGRESS` seja `external`.',
    },
  },
  DEV_LOCALE: {
    section: 'dev', required: no, default: none,
    notes: { en: 'The fake login’s page language.', 'pt-BR': 'O idioma das páginas do login falso.' },
  },
};

export const GLOBAL_FLAG_DOCS: Record<string, FlagDoc> = {
  lang: {
    value: 'en|pt-BR',
    en: 'Language of the output; otherwise `LOCALE` in `telinha.env`, else the system’s.',
    'pt-BR': 'Idioma da saída; senão o `LOCALE` do `telinha.env`, senão o do sistema.',
  },
  home: {
    value: 'DIR',
    en: 'The install directory (same as `TELINHA_HOME`); every path follows it.',
    'pt-BR': 'A pasta da instalação (o mesmo que `TELINHA_HOME`); todos os caminhos seguem ela.',
  },
  yes: {
    en: 'Setup only: every question that already has an answer (from a flag, the existing file or the machine) counts as answered, so the setup screens open on the first question with none, or on the Review when all have one. Nothing is written before you apply there.',
    'pt-BR': 'Só no setup: toda pergunta que já tem resposta (de uma opção, do arquivo existente ou da máquina) conta como respondida, então as telas de configuração abrem na primeira pergunta sem resposta, ou na Revisão quando todas têm. Nada é gravado antes de você aplicar lá.',
  },
  'non-interactive': {
    en: 'Never open screens or ask (implied without a terminal). `setup` then takes every answer from flags, the environment and the existing file, prints plain lines, and exits 2 naming a flag that breaks a rule or what is missing. On a terminal the same flag mistakes show as a notice in the screens instead.',
    'pt-BR': 'Nunca abre telas nem pergunta (implícito sem terminal). O `setup` então tira cada resposta das opções, do ambiente e do arquivo existente, imprime linhas simples e sai com 2 dizendo a opção que quebra uma regra ou o que falta. Num terminal os mesmos erros de opção aparecem como um aviso nas telas.',
  },
  help: { en: 'Print the help of `telinha` or of the command.', 'pt-BR': 'Mostra a ajuda da `telinha` ou do comando.' },
  version: { en: 'Print the version line and exit.', 'pt-BR': 'Mostra a linha de versão e sai.' },
};

export const SETUP_FLAG_DOCS: Record<string, FlagDoc> = {
  docker: {
    en: 'Inside the image: ask the questions (except updates), write `telinha.env` and stop; no binaries, service, firewall, router probe or doctor.',
    'pt-BR': 'Dentro da imagem: faz as perguntas (menos a de atualizações), escreve o `telinha.env` e para; sem binários, serviço, firewall, teste do roteador nem doctor.',
  },
  host: {
    value: 'home|vps', sets: 'HOSTING',
    en: 'Where Telinha runs; picks the defaults. Without it the existing file decides, else a guess from this machine (`home` unless it clearly is a VPS).',
    'pt-BR': 'Onde a Telinha roda; escolhe os padrões. Sem ela, vale o arquivo existente, senão um palpite a partir desta máquina (`home`, a menos que seja claramente uma VPS).',
  },
  'public-url': { value: 'URL', sets: 'PUBLIC_URL', en: 'The address people open.', 'pt-BR': 'O endereço que as pessoas abrem.' },
  ingress: { value: 'direct|tunnel|external', sets: 'INGRESS', en: 'How HTTP reaches Telinha.', 'pt-BR': 'Como o HTTP chega à Telinha.' },
  advanced: {
    en: 'At home: confirm you opened 80 and 443 on the router yourself, or run your own reverse proxy. Without it a home run refuses what relies on them (direct without `--duckdns-domain`, a port below 1024, `--http-port` other than `0`, `--ingress external`); a re-run of a file that already is such a setup counts as confirmed unless it changes the address or the ports. Ignored on a VPS.',
    'pt-BR': 'Em casa: confirma que você mesmo abriu a 80 e a 443 no roteador, ou que tem seu próprio proxy reverso. Sem ela, uma rodada em casa recusa o que depende disso (direct sem `--duckdns-domain`, uma porta abaixo de 1024, `--http-port` diferente de `0`, `--ingress external`); uma nova rodada de um arquivo que já é uma configuração assim conta como confirmada, a menos que mude o endereço ou as portas. Ignorada numa VPS.',
  },
  'http-port': { value: 'N', sets: 'HTTP_PORT', en: 'direct on a VPS: the redirect and HTTP challenge port; `0` turns it off. At home only `0` (anything else needs `--advanced`).', 'pt-BR': 'direct numa VPS: a porta do redirecionamento e do desafio HTTP; `0` desliga. Em casa só `0` (qualquer outra precisa de `--advanced`).' },
  'https-port': { value: 'N', sets: 'HTTPS_PORT', en: 'direct: the TLS port Caddy binds; at home the high port in the address (8443 by default, 1024-65535).', 'pt-BR': 'direct: a porta TLS em que o Caddy escuta; em casa a porta alta do endereço (8443 por padrão, 1024-65535).' },
  'tunnel-token-file': {
    value: 'PATH|-', sets: 'TUNNEL_TOKEN',
    en: 'File holding the Cloudflare tunnel token; `-` reads stdin. The token never goes on the command line.',
    'pt-BR': 'Arquivo com o token do túnel da Cloudflare; `-` lê do stdin. O token nunca vai na linha de comando.',
  },
  'duckdns-domain': {
    value: 'NAME', sets: 'DDNS_PROVIDER=duckdns, DUCKDNS_DOMAIN',
    en: 'The DuckDNS subdomain. At home: HTTPS on `--https-port` (8443) with a DNS certificate (`ACME_DNS=duckdns`, `HTTP_PORT=0`), and `PUBLIC_URL=https://NAME.duckdns.org:8443` carries the port. On a VPS: direct on 443, `PUBLIC_URL=https://NAME.duckdns.org`. A `--public-url` given with it must match.',
    'pt-BR': 'O subdomínio do DuckDNS. Em casa: HTTPS na `--https-port` (8443) com certificado por DNS (`ACME_DNS=duckdns`, `HTTP_PORT=0`), e a `PUBLIC_URL=https://NAME.duckdns.org:8443` leva a porta. Numa VPS: direct na 443, `PUBLIC_URL=https://NAME.duckdns.org`. Uma `--public-url` dada junto precisa bater.',
  },
  'duckdns-token-file': { value: 'PATH|-', sets: 'DUCKDNS_TOKEN', en: 'File holding the DuckDNS token (it also answers the DNS challenge at home); `-` reads stdin.', 'pt-BR': 'Arquivo com o token do DuckDNS (em casa ele também responde o desafio DNS); `-` lê do stdin.' },
  'media-tcp': { value: 'N', sets: 'MEDIA_TCP_PORT', en: 'WebRTC TCP port.', 'pt-BR': 'Porta TCP do WebRTC.' },
  'media-udp': { value: 'N', sets: 'MEDIA_UDP_PORT', en: 'WebRTC UDP port.', 'pt-BR': 'Porta UDP do WebRTC.' },
  'node-ip': { value: 'IP', sets: 'LIVEKIT_NODE_IP', en: 'Static public IPv4 (a VPS).', 'pt-BR': 'IPv4 público fixo (uma VPS).' },
  media: {
    value: 'self|cloud', sets: 'MEDIA',
    en: 'Where the video goes through: `self` (the bundled LiveKit, the default) or `cloud` (a LiveKit Cloud project; needs `--cloud-url`, `--livekit-key` and the secret). `cloud` drops the media ports from the file; switching back to `self` drops the Cloud URL and key pair and generates a local pair.',
    'pt-BR': 'Por onde o vídeo passa: `self` (o LiveKit embutido, o padrão) ou `cloud` (um projeto do LiveKit Cloud; precisa de `--cloud-url`, `--livekit-key` e do segredo). `cloud` tira as portas de mídia do arquivo; voltar para `self` tira a URL e o par de chaves do Cloud e gera um par local.',
  },
  'cloud-url': { value: 'URL', sets: 'LIVEKIT_CLOUD_URL', en: 'The LiveKit Cloud project’s URL, `wss://<project>.livekit.cloud`.', 'pt-BR': 'A URL do projeto no LiveKit Cloud, `wss://<projeto>.livekit.cloud`.' },
  'livekit-key': { value: 'KEY', sets: 'LIVEKIT_API_KEY', en: 'With `--media cloud`: the project’s API key (an identifier, not a secret).', 'pt-BR': 'Com `--media cloud`: a chave de API do projeto (um identificador, não um segredo).' },
  'livekit-secret-file': {
    value: 'PATH|-', sets: 'LIVEKIT_API_SECRET',
    en: 'With `--media cloud`: file holding the project’s API secret; `-` reads stdin. Or set `LIVEKIT_API_SECRET` in the environment.',
    'pt-BR': 'Com `--media cloud`: arquivo com o segredo de API do projeto; `-` lê do stdin. Ou defina `LIVEKIT_API_SECRET` no ambiente.',
  },
  turn: {
    value: 'auto|on|off', sets: 'TURN',
    en: 'TURN over TLS on 443 (a VPS in direct mode on 443 only). `on` where it cannot run exits 1 with the reason.',
    'pt-BR': 'TURN sobre TLS na 443 (só numa VPS no modo direct na 443). `on` onde ele não pode rodar sai com 1 e o motivo.',
  },
  'discord-token-file': { value: 'PATH|-', sets: 'DISCORD_TOKEN', en: 'File holding the bot token; `-` reads stdin.', 'pt-BR': 'Arquivo com o token do bot; `-` lê do stdin.' },
  'client-secret-file': { value: 'PATH|-', sets: 'DISCORD_CLIENT_SECRET', en: 'File holding the OAuth2 client secret; `-` reads stdin.', 'pt-BR': 'Arquivo com o client secret do OAuth2; `-` lê do stdin.' },
  'client-id': {
    value: 'ID', sets: 'DISCORD_CLIENT_ID',
    en: 'Read from the token otherwise; required with `--no-discord-check`.',
    'pt-BR': 'Lido do token quando ausente; obrigatório com `--no-discord-check`.',
  },
  guild: { value: 'ID', sets: 'GUILD_ID', en: 'The Discord server.', 'pt-BR': 'O servidor do Discord.' },
  role: { value: 'ID', sets: 'ROLE_ID', en: 'The role that may enter.', 'pt-BR': 'O cargo que pode entrar.' },
  channels: { value: 'ID,ID', sets: 'CHANNEL_IDS', en: 'The command channels.', 'pt-BR': 'Os canais do comando.' },
  command: { value: 'NAME', sets: 'COMMAND_NAME', en: 'The slash command name.', 'pt-BR': 'O nome do comando de barra.' },
  group: { value: 'NAME', sets: 'GROUP_NAME', en: 'The group name shown in pages.', 'pt-BR': 'O nome do grupo mostrado nas páginas.' },
  upnp: { value: 'auto|off', sets: 'UPNP', en: 'Let Telinha ask the router to forward the ports. Defaults to `off` on a VPS.', 'pt-BR': 'Deixar a Telinha pedir ao roteador para encaminhar as portas. O padrão é `off` numa VPS.' },
  'auto-update': { value: 'on|off', sets: 'AUTO_UPDATE', en: 'Native binary: install new stable releases by itself.', 'pt-BR': 'Binário nativo: instalar novas versões estáveis sozinho.' },
  'no-service': { en: 'Skip the service install.', 'pt-BR': 'Pula a instalação do serviço.' },
  'no-tray': {
    en: 'Windows: do not install the tray icon; removes an installed one and turns its logon autostart off.',
    'pt-BR': 'Windows: não instala o ícone na bandeja; remove um já instalado e desliga o início junto com o Windows.',
  },
  'tray-autostart': {
    en: 'Windows: start the tray icon when you sign in (off by default).',
    'pt-BR': 'Windows: inicia o ícone na bandeja quando você entra no Windows (desligado por padrão).',
  },
  'no-firewall': { en: 'Skip the Windows Firewall rules.', 'pt-BR': 'Pula as regras do Firewall do Windows.' },
  'no-upnp': { en: 'Skip the router probe.', 'pt-BR': 'Pula o teste do roteador.' },
  'no-doctor': { en: 'Skip the doctor run at the end.', 'pt-BR': 'Pula o doctor no final.' },
  'no-discord-check': {
    en: 'No Discord API calls: the ids are taken as given and the intents and redirect are not checked or set.',
    'pt-BR': 'Nenhuma chamada à API do Discord: os ids são aceitos como vieram, e as intents e o redirect não são conferidos nem definidos.',
  },
};

export const DOCTOR_FLAG_DOCS: Record<string, FlagDoc> = {
  json: { en: 'Print `{ checks, phone }` as JSON instead of the table.', 'pt-BR': 'Imprime `{ checks, phone }` em JSON em vez da tabela.' },
  phone: {
    negated: true,
    en: 'Skip the phone test. It is also skipped without a terminal or with the service stopped.',
    'pt-BR': 'Pula o teste pelo celular. Ele também é pulado sem terminal ou com o serviço parado.',
  },
  local: { en: 'Skip the checks that need the internet, and the phone test.', 'pt-BR': 'Pula as verificações que precisam de internet, e o teste pelo celular.' },
};

export const UPDATE_FLAG_DOCS: Record<string, FlagDoc> = {
  check: {
    en: 'Only show the current version, the newest stable release (or the pin) and any staged, failed or pending update; install nothing.',
    'pt-BR': 'Só mostra a versão atual, a versão estável mais nova (ou a fixada) e qualquer atualização preparada, falha ou pendente; não instala nada.',
  },
  now: {
    en: 'Install even while rooms are open; also retries a tag that failed before.',
    'pt-BR': 'Instala mesmo com salas abertas; também tenta de novo uma tag que falhou antes.',
  },
};

export const SERVICE_FLAG_DOCS: Record<string, FlagDoc> = {
  firewall: {
    en: '`install`: add the Windows Firewall rules for the helper programs (and first remove stale Block rules); `uninstall`: remove them. No effect on Linux.',
    'pt-BR': '`install`: adiciona as regras do Firewall do Windows para os programas auxiliares (e antes remove regras de bloqueio antigas); `uninstall`: remove elas. Sem efeito no Linux.',
  },
  user: {
    value: 'DOMAIN\\user',
    en: 'Linux: a switch; install a user unit (`systemctl --user`) instead of the system one. Windows: takes a value, the account the task runs as (the elevated install passes the caller’s).',
    'pt-BR': 'Linux: uma chave; instala uma unidade de usuário (`systemctl --user`) em vez da do sistema. Windows: recebe um valor, a conta com que a tarefa roda (a instalação elevada passa a de quem chamou).',
  },
  sid: { value: 'SID', internal: true, en: 'Windows: the SID of that account, passed by the elevated install.', 'pt-BR': 'Windows: o SID dessa conta, passado pela instalação elevada.' },
  result: { value: 'PATH', internal: true, en: 'Windows: where the elevated install writes `install-result.json`.', 'pt-BR': 'Windows: onde a instalação elevada escreve o `install-result.json`.' },
  'log-file': { value: 'PATH', internal: true, en: '`service run`: the log file (Windows defaults to `logs/telinha.log`; Linux writes to the journal).', 'pt-BR': '`service run`: o arquivo de log (no Windows o padrão é `logs/telinha.log`; o Linux escreve no journal).' },
};

export const SERVICE_ACTION_DOCS: Record<string, L & { internal?: boolean }> = {
  install: {
    en: 'Register the service and start it. Windows: a Task Scheduler task named `Telinha`, from an administrator terminal (`telinha setup` does it with one UAC prompt). Linux: a systemd unit; as root a system unit running as the `telinha` user, otherwise (or with `--user`) a user unit.',
    'pt-BR': 'Registra o serviço e inicia. Windows: uma tarefa do Agendador de Tarefas chamada `Telinha`, a partir de um terminal de administrador (o `telinha setup` faz isso com um pedido de UAC). Linux: uma unidade do systemd; como root uma unidade do sistema rodando como o usuário `telinha`, senão (ou com `--user`) uma unidade de usuário.',
  },
  uninstall: { en: 'Remove the service (and with `--firewall` the Windows rules); the files stay.', 'pt-BR': 'Remove o serviço (e com `--firewall` as regras do Windows); os arquivos ficam.' },
  start: { en: 'Start the service.', 'pt-BR': 'Inicia o serviço.' },
  stop: {
    en: 'Stop it. Windows: a graceful stop through the local control endpoint, then the task is ended; Linux: `systemctl stop` (SIGTERM, which Telinha handles gracefully).',
    'pt-BR': 'Para o serviço. Windows: uma parada limpa pelo ponto de controle local, depois a tarefa é encerrada; Linux: `systemctl stop` (SIGTERM, que a Telinha trata com uma parada limpa).',
  },
  restart: { en: 'Stop and start it (also what applies an edited `telinha.env`).', 'pt-BR': 'Para e inicia de novo (também é o que aplica um `telinha.env` editado).' },
  status: {
    en: 'Installed, running and starts at boot (Windows: plus the task’s last result). Exit 1 when not installed or not running.',
    'pt-BR': 'Instalado, rodando e inicia com o sistema (Windows: mais o último resultado da tarefa). Sai com 1 quando não está instalado ou não está rodando.',
  },
  run: {
    internal: true,
    en: 'The supervising loop the service manager starts: runs `telinha run`, restarts it after an update or a crash (with backoff) and rolls back an update that fails to start. Not for hand use.',
    'pt-BR': 'O laço supervisor que o gerenciador de serviços inicia: roda o `telinha run`, reinicia depois de uma atualização ou de uma queda (com espera crescente) e desfaz uma atualização que não sobe. Não é para uso manual.',
  },
};

export const TRAY_ACTION_DOCS: Record<string, L> = {
  start: {
    en: 'Start the tray icon. Refused from an administrator terminal (every command its menu runs would run elevated too), and when `telinha-tray.exe` is not in `bin`.',
    'pt-BR': 'Inicia o ícone na bandeja. Recusado num terminal de administrador (todo comando que o menu dele roda rodaria elevado também), e quando o `telinha-tray.exe` não está em `bin`.',
  },
  stop: { en: 'Close the tray icon; the service keeps running.', 'pt-BR': 'Fecha o ícone na bandeja; o serviço continua rodando.' },
  status: {
    en: 'Running (with its pid and version), not running or not installed, and whether it starts with Windows. Exit 1 when it is not running.',
    'pt-BR': 'Rodando (com o pid e a versão), parado ou não instalado, e se inicia com o Windows. Sai com 1 quando não está rodando.',
  },
  autostart: {
    en: '`on` or `off`: start the tray icon when you sign in to Windows (the `Telinha` value of your user’s `Run` registry key). Off by default.',
    'pt-BR': '`on` ou `off`: inicia o ícone na bandeja quando você entra no Windows (o valor `Telinha` da chave `Run` do registro do seu usuário). Desligado por padrão.',
  },
};

export const DOCTOR_CHECK_DOCS: Record<string, CheckDoc> = {
  config: {
    looksAt: {
      en: '`telinha.env` loads and validates; warnings and unknown keys; fails when other users of the computer can read the file.',
      'pt-BR': 'O `telinha.env` carrega e valida; avisos e chaves desconhecidas; falha quando outros usuários do computador conseguem ler o arquivo.',
    },
    fixes: {
      en: 'Edit the file or run `telinha setup` again. Permissions: Linux `chmod 600`; Windows `telinha setup` locks the file down again.',
      'pt-BR': 'Edite o arquivo ou rode o `telinha setup` de novo. Permissões: Linux `chmod 600`; Windows o `telinha setup` tranca o arquivo de novo.',
    },
  },
  binaries: {
    looksAt: {
      en: 'The helper programs this configuration needs (`livekit-server` with `MEDIA=self`; `caddy` or `cloudflared`) are in `bin/` at the pinned versions (`caddy`: the build of this release), or on `PATH`. With `ACME_DNS=duckdns` it reads the `caddy` file (never runs it) and fails when the DuckDNS module is missing (an upstream or distro Caddy).',
      'pt-BR': 'Os programas auxiliares que esta configuração precisa (`livekit-server` com `MEDIA=self`; `caddy` ou `cloudflared`) estão em `bin/` nas versões fixadas (`caddy`: o build desta versão), ou no `PATH`. Com `ACME_DNS=duckdns` ela lê o arquivo do `caddy` (sem nunca rodar ele) e falha quando falta o módulo do DuckDNS (um Caddy oficial ou de distribuição).',
    },
    fixes: {
      en: 'Start Telinha (the native binary downloads what is missing) or run `telinha setup`. A `caddy` in `bin/` without the DuckDNS module: delete it and run `telinha setup` again, which fetches Telinha’s own build; one on `PATH` (used only when that download failed) stays as it is, and `telinha setup` run again while online puts Telinha’s build in `bin/`. From source: `bun scripts/bins.ts --out <bin>` (or `bun run caddy --out <bin>` to build `caddy`), with the `bin/` folder the check names.',
      'pt-BR': 'Inicie a Telinha (o binário nativo baixa o que falta) ou rode o `telinha setup`. Um `caddy` em `bin/` sem o módulo do DuckDNS: apague ele e rode o `telinha setup` de novo, que baixa o build da própria Telinha; um no `PATH` (usado só quando esse download falhou) fica como está, e o `telinha setup` rodado de novo com internet põe o build da Telinha em `bin/`. A partir do código-fonte: `bun scripts/bins.ts --out <bin>` (ou `bun run caddy --out <bin>` para compilar o `caddy`), com a pasta `bin/` que a verificação indica.',
    },
  },
  'discord-token': {
    looksAt: { en: 'The bot token works and `DISCORD_CLIENT_ID` is its application.', 'pt-BR': 'O token do bot funciona e o `DISCORD_CLIENT_ID` é a aplicação dele.' },
    fixes: {
      en: 'Developer Portal → your app → Bot → Reset Token, then `telinha setup`; or set the `DISCORD_CLIENT_ID` it names.',
      'pt-BR': 'Developer Portal → seu app → Bot → Reset Token, depois `telinha setup`; ou defina o `DISCORD_CLIENT_ID` que ele indica.',
    },
  },
  'discord-intents': {
    looksAt: { en: 'The Server Members and Presence intents are on.', 'pt-BR': 'As intents Server Members e Presence estão ligadas.' },
    fixes: { en: '`telinha setup` switches them on; or toggle them on the Bot page of the Developer Portal.', 'pt-BR': 'O `telinha setup` liga elas; ou ligue na página Bot do Developer Portal.' },
  },
  'discord-guild': {
    looksAt: { en: 'The bot is in the server `GUILD_ID`.', 'pt-BR': 'O bot está no servidor `GUILD_ID`.' },
    fixes: { en: 'Open the invite link the check prints.', 'pt-BR': 'Abra o link de convite que a verificação imprime.' },
  },
  'discord-role': {
    looksAt: { en: '`ROLE_ID` is a role of that server.', 'pt-BR': 'O `ROLE_ID` é um cargo desse servidor.' },
    fixes: { en: '`telinha setup` again: it lists the roles to pick from.', 'pt-BR': '`telinha setup` de novo: ele lista os cargos para escolher.' },
  },
  'discord-channels': {
    looksAt: { en: 'Every `CHANNEL_IDS` entry is a text or announcement channel of that server.', 'pt-BR': 'Cada entrada de `CHANNEL_IDS` é um canal de texto ou de anúncios desse servidor.' },
    fixes: { en: '`telinha setup` again: it lists the channels the bot can see.', 'pt-BR': '`telinha setup` de novo: ele lista os canais que o bot vê.' },
  },
  'discord-redirect': {
    looksAt: { en: '`<PUBLIC_URL>/auth/callback` is a registered redirect of the app.', 'pt-BR': '`<PUBLIC_URL>/auth/callback` é um redirect cadastrado do app.' },
    fixes: {
      en: 'Developer Portal → OAuth2 → Redirects → Add Redirect with that URL, then Save Changes. The only step Discord’s API cannot do.',
      'pt-BR': 'Developer Portal → OAuth2 → Redirects → Add Redirect com essa URL, depois Save Changes. O único passo que a API do Discord não faz.',
    },
  },
  'public-ip': {
    looksAt: { en: 'The IP the internet sees this network as.', 'pt-BR': 'O IP com que a internet vê esta rede.' },
    fixes: { en: 'Fails only offline: check the connection.', 'pt-BR': 'Só falha sem internet: confira a conexão.' },
  },
  dns: {
    looksAt: {
      en: 'The A record of the `PUBLIC_URL` host (asked of 1.1.1.1 and 8.8.8.8) against the public IP (or `LIVEKIT_NODE_IP`); for a tunnel, only that it resolves. A DuckDNS name also has its token checked: DuckDNS is sent the IP the record already holds, so nothing changes.',
      'pt-BR': 'O registro A do host da `PUBLIC_URL` (perguntado a 1.1.1.1 e 8.8.8.8) comparado ao IP público (ou a `LIVEKIT_NODE_IP`); para um túnel, só que ele resolve. Um nome do DuckDNS também tem o token conferido: o DuckDNS recebe o IP que o registro já tem, então nada muda.',
    },
    fixes: {
      en: 'Create or change the A record. DuckDNS: the running service updates it by itself; a token DuckDNS rejects is entered again with `telinha setup`.',
      'pt-BR': 'Crie ou altere o registro A. DuckDNS: o serviço rodando atualiza sozinho; um token que o DuckDNS recusa é digitado de novo no `telinha setup`.',
    },
  },
  certificate: {
    looksAt: {
      en: 'How the certificate is obtained, from the configuration: Cloudflare (tunnel), your proxy (external), Let’s Encrypt through DuckDNS (DNS challenge, nothing on 80/443), or Let’s Encrypt over ports 80 and 443 (HTTP or TLS-ALPN challenge, a VPS). Informational: it never warns. On the advanced home setup it adds a note that 80 and 443 must be forwarded by hand.',
      'pt-BR': 'Como o certificado é obtido, pela configuração: a Cloudflare (tunnel), o seu proxy (external), o Let’s Encrypt pelo DuckDNS (desafio DNS, nada na 80/443), ou o Let’s Encrypt pelas portas 80 e 443 (desafio HTTP ou TLS-ALPN, uma VPS). Informativa: nunca dá aviso. Na configuração avançada em casa ela acrescenta uma nota de que a 80 e a 443 precisam ser encaminhadas à mão.',
    },
    fixes: {
      en: 'Nothing to fix here; `tls` says whether the certificate actually came.',
      'pt-BR': 'Nada para resolver aqui; a `tls` diz se o certificado chegou de fato.',
    },
  },
  tls: {
    looksAt: {
      en: 'The certificate is valid for the host (warning under 14 days left) and `<PUBLIC_URL>/healthz` answers from the internet.',
      'pt-BR': 'O certificado é válido para o host (aviso com menos de 14 dias restantes) e `<PUBLIC_URL>/healthz` responde pela internet.',
    },
    fixes: {
      en: 'direct with DuckDNS (home): check the DuckDNS token (`dns`), that `HTTPS_PORT` is free for Caddy (`listeners`) and the `[caddy]` lines in the log; a fresh install takes a few minutes. direct on a VPS: Caddy gets the certificate by itself once ports 80 and 443 reach the machine (see `dns`, `listeners`). tunnel/external: check the proxy or tunnel in front.',
      'pt-BR': 'direct com DuckDNS (em casa): confira o token do DuckDNS (`dns`), se a `HTTPS_PORT` está livre para o Caddy (`listeners`) e as linhas `[caddy]` do log; uma instalação nova leva alguns minutos. direct numa VPS: o Caddy obtém o certificado sozinho quando as portas 80 e 443 chegam à máquina (veja `dns`, `listeners`). tunnel/external: confira o proxy ou o túnel na frente.',
    },
  },
  'livekit-cloud': {
    looksAt: {
      en: '`MEDIA=cloud` only: lists the project’s rooms with `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, which proves both the URL and the key pair. Detail lines repeat the auto-create advice and the free plan’s limits.',
      'pt-BR': 'Só com `MEDIA=cloud`: lista as salas do projeto com `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, o que prova a URL e o par de chaves. As linhas de detalhe repetem o conselho sobre a criação automática de salas e os limites do plano gratuito.',
    },
    fixes: {
      en: 'Rejected key: copy the key and secret again from the project’s Settings → Keys. Unreachable: check `LIVEKIT_CLOUD_URL` (Settings → Project) and the machine’s internet access.',
      'pt-BR': 'Chave recusada: copie a chave e o segredo de novo em Settings → Keys do projeto. Inalcançável: confira a `LIVEKIT_CLOUD_URL` (Settings → Project) e a internet da máquina.',
    },
  },
  turn: {
    looksAt: {
      en: 'With TURN on: the DNS record of `turn.<host>` against the public IP, the certificate `turn.<host>` presents on 443, and whether LiveKit’s TURN is listening locally on `TURN_PORT`. Skipped with the reason where TURN cannot run; on a VPS with your own domain and `TURN=auto` it says how to turn it on.',
      'pt-BR': 'Com o TURN ligado: o registro DNS de `turn.<host>` comparado ao IP público, o certificado que o `turn.<host>` apresenta na 443, e se o TURN do LiveKit está escutando localmente na `TURN_PORT`. Pulada com o motivo onde o TURN não pode rodar; numa VPS com domínio próprio e `TURN=auto` ela diz como ligar.',
    },
    fixes: {
      en: 'Create the A record `turn.<host>` → the VPS IP (DuckDNS and sslip.io names need nothing); the certificate comes from Caddy a few minutes after the start (`[caddy]` lines in the log). Whether a phone relays through it is the phone test’s TURN/TLS row.',
      'pt-BR': 'Crie o registro A `turn.<host>` → o IP da VPS (nomes do DuckDNS e do sslip.io não precisam de nada); o certificado vem do Caddy alguns minutos depois da inicialização (linhas `[caddy]` do log). Se um celular consegue passar por ele é o que a linha TURN/TLS do teste pelo celular mostra.',
    },
  },
  listeners: {
    looksAt: {
      en: 'Telinha answers on `LISTEN`, every child is up, LiveKit and the media TCP port listen (`MEDIA=self`; with TURN on also `TURN_PORT` on 127.0.0.1), and in direct mode `HTTPS_PORT` listens. Prints the ufw/firewalld commands and the low-port hint for Linux users.',
      'pt-BR': 'A Telinha responde em `LISTEN`, todos os filhos estão de pé, o LiveKit e a porta TCP de mídia escutam (`MEDIA=self`; com o TURN ligado também a `TURN_PORT` em 127.0.0.1), e no modo direct a `HTTPS_PORT` escuta. Imprime os comandos do ufw/firewalld e a dica de portas baixas para usuários Linux.',
    },
    fixes: {
      en: '`telinha service start` (or `telinha run`). Linux user install on 80/443 (a VPS): the one-time sysctl it prints; the standard home setups need no low port. Open the firewall with the printed commands.',
      'pt-BR': '`telinha service start` (ou `telinha run`). Instalação Linux de usuário em 80/443 (uma VPS): o sysctl único que ele imprime; as configurações padrão em casa não precisam de porta baixa. Abra o firewall com os comandos impressos.',
    },
  },
  service: {
    looksAt: { en: 'The service is installed, running and starts at boot.', 'pt-BR': 'O serviço está instalado, rodando e inicia com o sistema.' },
    fixes: {
      en: '`telinha service install` or `telinha service start`; Windows: `telinha setup` again (one administrator prompt). Skipped for Docker and source runs.',
      'pt-BR': '`telinha service install` ou `telinha service start`; Windows: `telinha setup` de novo (um pedido de administrador). Pulado no Docker e rodando do código-fonte.',
    },
  },
  tray: {
    looksAt: {
      en: 'Native Windows installs only: whether `telinha-tray.exe` is in `bin` (not installed is fine), whether it runs and at the same version as Telinha, and a *Start with Windows* entry left pointing at a missing file. Detail lines say whether it starts with Windows and who signed it (an unsigned build is never a warning).',
      'pt-BR': 'Só em instalações nativas no Windows: se o `telinha-tray.exe` está em `bin` (não instalado está ok), se ele roda e na mesma versão da Telinha, e uma entrada de *Iniciar com o Windows* apontando pra um arquivo que não existe. As linhas de detalhe dizem se ele inicia com o Windows e quem assinou (um build sem assinatura nunca é aviso).',
    },
    fixes: {
      en: 'Not running: `telinha tray start`. A different version: `telinha tray stop`, then `telinha tray start`. A leftover autostart: `telinha tray autostart off`. To install it: `telinha setup`, answering yes to the tray icon.',
      'pt-BR': 'Parado: `telinha tray start`. Outra versão: `telinha tray stop`, depois `telinha tray start`. Um início automático que sobrou: `telinha tray autostart off`. Pra instalar: `telinha setup`, respondendo sim ao ícone.',
    },
  },
  gateway: {
    looksAt: {
      en: 'A router that speaks UPnP, NAT-PMP or PCP, and the external IP it reports. A machine with a public address of its own (a VPS) passes.',
      'pt-BR': 'Um roteador que fala UPnP, NAT-PMP ou PCP, e o IP externo que ele informa. Uma máquina com endereço público próprio (uma VPS) passa.',
    },
    fixes: {
      en: 'No router answered: turn UPnP on in the router, or forward the listed ports by hand.',
      'pt-BR': 'Nenhum roteador respondeu: ligue o UPnP no roteador, ou encaminhe as portas listadas à mão.',
    },
  },
  cgnat: {
    looksAt: {
      en: 'The router’s external IP against the public IP: an address in `100.64.0.0/10` (CGNAT) fails (only warns with `MEDIA=cloud`, where just the pages need a way in); a private address (double NAT) or a mismatch warns.',
      'pt-BR': 'O IP externo do roteador comparado ao IP público: um endereço em `100.64.0.0/10` (CGNAT) falha (com `MEDIA=cloud` só avisa, porque só as páginas precisam de uma entrada); um endereço privado (NAT duplo) ou uma diferença gera aviso.',
    },
    fixes: {
      en: 'CGNAT: for the pages, `INGRESS=tunnel` or a VPS; for the video, a public IPv4 from the provider or `MEDIA=cloud` (LiveKit Cloud needs no open port). Double NAT: bridge mode on the provider’s modem, or forward the ports on both devices.',
      'pt-BR': 'CGNAT: para as páginas, `INGRESS=tunnel` ou uma VPS; para o vídeo, um IPv4 público da operadora ou `MEDIA=cloud` (o LiveKit Cloud não precisa de porta aberta). NAT duplo: modo bridge no modem da operadora, ou encaminhe as portas nos dois aparelhos.',
    },
  },
  mappings: {
    looksAt: {
      en: 'The ports Telinha asks the router for (the media ports with `MEDIA=self`, and 8443 at home with DuckDNS) are mapped (with `UPNP=auto` and the service running); otherwise the list to forward by hand. Ports it never asks for, such as 80 and 443 on the advanced home setup, show up as a detail line, not a problem.',
      'pt-BR': 'As portas que a Telinha pede ao roteador (as de mídia com `MEDIA=self`, e a 8443 em casa com DuckDNS) estão mapeadas (com `UPNP=auto` e o serviço rodando); senão, a lista para encaminhar à mão. Portas que ela nunca pede, como a 80 e a 443 na configuração avançada em casa, aparecem numa linha de detalhe, não como problema.',
    },
    fixes: { en: 'Forward the listed ports on the router to this machine’s LAN IP.', 'pt-BR': 'Encaminhe as portas listadas no roteador para o IP desta máquina na rede local.' },
  },
  update: {
    looksAt: {
      en: 'Native binary only: a newer stable release, or a staged, failed or pending update in `data/run/update.json`.',
      'pt-BR': 'Só no binário nativo: uma versão estável mais nova, ou uma atualização preparada, falha ou pendente em `data/run/update.json`.',
    },
    fixes: { en: 'It installs by itself when no room is open, or now with `telinha update --now`.', 'pt-BR': 'Instala sozinha quando nenhuma sala está aberta, ou agora com `telinha update --now`.' },
  },
};

/** Column headers and small labels of the components. */
export const UI: Record<string, L> = {
  key: { en: 'Key', 'pt-BR': 'Chave' },
  default: { en: 'Default', 'pt-BR': 'Padrão' },
  required: { en: 'Required', 'pt-BR': 'Obrigatória' },
  notes: { en: 'Notes', 'pt-BR': 'Notas' },
  yes: { en: 'yes', 'pt-BR': 'sim' },
  no: { en: 'no', 'pt-BR': 'não' },
  flag: { en: 'Flag', 'pt-BR': 'Opção' },
  value: { en: 'Value', 'pt-BR': 'Valor' },
  sets: { en: 'Sets', 'pt-BR': 'Define' },
  meaning: { en: 'Meaning', 'pt-BR': 'Significado' },
  internal: { en: '(internal)', 'pt-BR': '(interno)' },
  action: { en: 'Action', 'pt-BR': 'Ação' },
  check: { en: 'Check', 'pt-BR': 'Verificação' },
  title: { en: 'Title', 'pt-BR': 'Título' },
  looksAt: { en: 'What it looks at', 'pt-BR': 'O que ela olha' },
  fixes: { en: 'What fixes it', 'pt-BR': 'O que resolve' },
  pins: { en: 'This release pins', 'pt-BR': 'Esta versão fixa' },
  and: { en: 'and', 'pt-BR': 'e' },
  pinsCaddy: { en: 'built by Telinha with', 'pt-BR': 'compilado pela Telinha com' },
  linux: { en: 'Linux', 'pt-BR': 'Linux' },
  windows: { en: 'Windows', 'pt-BR': 'Windows' },
  none: { en: 'none', 'pt-BR': 'nenhum' },
};

/** The text of an L in a locale; a plain string is the same in both. */
export function pick(text: string | L, locale: Locale): string {
  return typeof text === 'string' ? text : text[locale];
}

/** Splits "a `code` b" into alternating plain/code segments (odd indexes are code). */
export function codeSegments(text: string): string[] {
  return text.split('`');
}
