// The prose of the reference pages, keyed by the code's own identifiers (env
// keys, flag names, service actions, doctor check ids) in EN and pt-BR. The
// drift tests in docs/scripts compare every table with the server code, so a
// key, flag or check added or renamed there fails until its row exists here.
// Backticks in a text render as code (the components split on them).
import type { Config } from '../../../server/src/config.ts';

export type Locale = 'en' | 'pt-BR';
export interface L { en: string; 'pt-BR': string }

export type Section = 'discord' | 'ingress' | 'media' | 'rooms' | 'native' | 'paths' | 'dev' | 'reserved';

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
  reserved: { en: 'Reserved for LiveKit Cloud / TURN', 'pt-BR': 'Reservado para LiveKit Cloud / TURN' },
};

export const CONFIG_KEYS: Record<string, ConfigKeyDoc> = {
  // --- Identity and Discord ---
  DISCORD_TOKEN: {
    section: 'discord', required: yes,
    notes: {
      en: 'Bot token: Developer Portal → your app → Bot → Reset Token. On the same page switch on Server Members Intent and Presence Intent (the wizard does it through the API).',
      'pt-BR': 'Token do bot: Developer Portal → seu app → Bot → Reset Token. Na mesma página, ligue Server Members Intent e Presence Intent (o assistente faz isso pela API).',
    },
  },
  DISCORD_CLIENT_ID: {
    section: 'discord', required: yes,
    notes: {
      en: 'The application id (OAuth2 page). The wizard reads it from the bot token.',
      'pt-BR': 'O id da aplicação (página OAuth2). O assistente lê do token do bot.',
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
      en: 'Random; `openssl rand -base64 48`. The wizard generates it; a new one logs everyone out.',
      'pt-BR': 'Aleatório; `openssl rand -base64 48`. O assistente gera; um novo desloga todo mundo.',
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
      en: 'What people open: `https://host[:port]`. `http://localhost[:port]` only with `DEV_USER`.',
      'pt-BR': 'O que as pessoas abrem: `https://host[:porta]`. `http://localhost[:porta]` só com `DEV_USER`.',
    },
  },
  INGRESS: {
    section: 'ingress', required: no, probe: (c) => c.ingress, default: 'direct',
    notes: {
      en: '`direct`: the bundled Caddy gets a certificate and binds `HTTP_PORT`/`HTTPS_PORT`; `tunnel`: Cloudflare Tunnel, no open HTTP ports; `external`: your own reverse proxy forwards to `LISTEN`. With `DEV_USER` the default is `external`.',
      'pt-BR': '`direct`: o Caddy embutido obtém o certificado e escuta em `HTTP_PORT`/`HTTPS_PORT`; `tunnel`: Cloudflare Tunnel, sem portas HTTP abertas; `external`: seu próprio proxy reverso encaminha para `LISTEN`. Com `DEV_USER` o padrão é `external`.',
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
      en: 'direct: the HTTP→HTTPS redirect and ACME challenge port; `0` turns that listener off (the certificate then comes through TLS-ALPN on `HTTPS_PORT`).',
      'pt-BR': 'direct: a porta do redirecionamento HTTP→HTTPS e do desafio ACME; `0` desliga esse listener (o certificado então vem por TLS-ALPN em `HTTPS_PORT`).',
    },
  },
  HTTPS_PORT: {
    section: 'ingress', required: no, probe: (c) => c.httpsPort, default: '443',
    notes: {
      en: 'direct: the port Caddy binds for TLS. Normally the `PUBLIC_URL` port; when the router translates (public 443 → this host’s 8443) set the internal one here; a difference is only a warning.',
      'pt-BR': 'direct: a porta em que o Caddy escuta com TLS. Normalmente a porta da `PUBLIC_URL`; se o roteador traduz (443 pública → 8443 nesta máquina), coloque aqui a interna; a diferença gera só um aviso.',
    },
  },
  ACME_EMAIL: {
    section: 'ingress', required: no, default: none,
    notes: {
      en: "direct, optional: the Let's Encrypt account email.",
      'pt-BR': "direct, opcional: o e-mail da conta no Let's Encrypt.",
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
    section: 'ingress', required: { en: 'with `DDNS_PROVIDER=duckdns`', 'pt-BR': 'com `DDNS_PROVIDER=duckdns`' },
    notes: {
      en: 'The token shown on duckdns.org after signing in.',
      'pt-BR': 'O token mostrado no duckdns.org depois de entrar.',
    },
  },

  // --- Media (LiveKit) ---
  MEDIA: {
    section: 'media', required: no, probe: (c) => c.media, default: 'self',
    notes: {
      en: '`self` runs the bundled `livekit-server`; `cloud` is reserved and rejected for now.',
      'pt-BR': '`self` roda o `livekit-server` embutido; `cloud` está reservado e é recusado por enquanto.',
    },
  },
  LIVEKIT_API_KEY: {
    section: 'media', required: yes,
    notes: {
      en: 'Any key you make up (`openssl rand -hex 16`); handed to LiveKit through its environment. The wizard generates it.',
      'pt-BR': 'Qualquer chave que você inventar (`openssl rand -hex 16`); entregue ao LiveKit pelo ambiente. O assistente gera.',
    },
  },
  LIVEKIT_API_SECRET: {
    section: 'media', required: yes,
    notes: {
      en: 'Its secret, 32+ characters (`openssl rand -base64 32`). The wizard generates it.',
      'pt-BR': 'O segredo correspondente, 32+ caracteres (`openssl rand -base64 32`). O assistente gera.',
    },
  },
  LIVEKIT_PORT: {
    section: 'media', required: no, probe: (c) => c.livekitPort, default: '7880',
    notes: {
      en: "LiveKit's signaling/API port, loopback only; never forwarded.",
      'pt-BR': 'A porta de sinalização/API do LiveKit, só loopback; nunca encaminhada.',
    },
  },
  MEDIA_TCP_PORT: {
    section: 'media', required: no, probe: (c) => c.mediaTcpPort, default: '7881',
    notes: {
      en: 'WebRTC media over TCP (the fallback where UDP is blocked). Forward it on the router in every ingress mode.',
      'pt-BR': 'Mídia WebRTC por TCP (o caminho reserva onde o UDP é bloqueado). Encaminhe no roteador em qualquer modo de entrada.',
    },
  },
  MEDIA_UDP_PORT: {
    section: 'media', required: no, probe: (c) => c.mediaUdpPort, default: '7882',
    notes: {
      en: 'WebRTC media over UDP (the normal path). Forward it on the router in every ingress mode.',
      'pt-BR': 'Mídia WebRTC por UDP (o caminho normal). Encaminhe no roteador em qualquer modo de entrada.',
    },
  },
  UPNP: {
    section: 'media', required: no, probe: (c) => (c.upnp ? 'auto' : 'off'), default: 'auto',
    notes: {
      en: '`auto` asks the router (UPnP IGD, NAT-PMP or PCP) to forward the media ports, and `HTTPS_PORT`/`HTTP_PORT` in direct mode, while Telinha runs; `off` when you forward by hand.',
      'pt-BR': '`auto` pede ao roteador (UPnP IGD, NAT-PMP ou PCP) para encaminhar as portas de mídia, e `HTTPS_PORT`/`HTTP_PORT` no modo direct, enquanto a Telinha roda; `off` quando você encaminha à mão.',
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
      en: "LiveKit's HTTP API as Telinha reaches it; the default follows `LIVEKIT_PORT`.",
      'pt-BR': 'A API HTTP do LiveKit como a Telinha a alcança; o padrão segue `LIVEKIT_PORT`.',
    },
  },
  LIVEKIT_PUBLIC_URL: {
    section: 'media', required: no, default: { en: '`PUBLIC_URL` as `wss://` + `/livekit`', 'pt-BR': 'a `PUBLIC_URL` como `wss://` + `/livekit`' },
    notes: {
      en: "The signaling URL browsers use; Telinha relays it, so LiveKit's own API never faces the internet.",
      'pt-BR': 'A URL de sinalização que os navegadores usam; a Telinha faz o relay, então a API do LiveKit nunca fica exposta à internet.',
    },
  },
  IP_WATCH_SECONDS: {
    section: 'media', required: no, probe: (c) => c.ipWatchSeconds, default: '300',
    notes: {
      en: 'How often the public IP is checked; on a change the router mappings are renewed, DuckDNS is nudged and the LiveKit child restarts. `0` = off; forced off by `LIVEKIT_NODE_IP`.',
      'pt-BR': 'De quanto em quanto tempo o IP público é conferido; numa mudança os mapeamentos do roteador são renovados, o DuckDNS é avisado e o LiveKit reinicia. `0` = desligado; desligado também por `LIVEKIT_NODE_IP`.',
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
      en: '`en` or `pt-BR` for the command line and the wizard; the pages follow the browser. `--lang` overrides it.',
      'pt-BR': '`en` ou `pt-BR` para a linha de comando e o assistente; as páginas seguem o navegador. `--lang` sobrepõe.',
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

  // --- Reserved ---
  LIVEKIT_CLOUD_URL: {
    section: 'reserved', required: no,
    notes: {
      en: 'Reserved for a LiveKit Cloud mode; accepted without a warning and ignored for now.',
      'pt-BR': 'Reservado para um modo LiveKit Cloud; aceito sem aviso e ignorado por enquanto.',
    },
  },
  TURN_TLS_PORT: {
    section: 'reserved', required: no,
    notes: {
      en: 'Reserved for TURN over TLS; accepted without a warning and ignored for now.',
      'pt-BR': 'Reservado para TURN sobre TLS; aceito sem aviso e ignorado por enquanto.',
    },
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
  yes: { en: 'Accept the defaults without asking.', 'pt-BR': 'Aceita os padrões sem perguntar.' },
  'non-interactive': {
    en: 'Never prompt (implied without a terminal). `setup` then takes every answer from flags, the environment and the existing file, and exits 2 naming what is missing.',
    'pt-BR': 'Nunca pergunta (implícito sem terminal). O `setup` então tira cada resposta das opções, do ambiente e do arquivo existente, e sai com 2 dizendo o que falta.',
  },
  help: { en: 'Print the help of `telinha` or of the command.', 'pt-BR': 'Mostra a ajuda da `telinha` ou do comando.' },
  version: { en: 'Print the version line and exit.', 'pt-BR': 'Mostra a linha de versão e sai.' },
};

export const SETUP_FLAG_DOCS: Record<string, FlagDoc> = {
  docker: {
    en: 'Inside the image: ask the questions (except updates), write `telinha.env` and stop; no binaries, service, firewall, router probe or doctor.',
    'pt-BR': 'Dentro da imagem: faz as perguntas (menos a de atualizações), escreve o `telinha.env` e para; sem binários, serviço, firewall, teste do roteador nem doctor.',
  },
  'public-url': { value: 'URL', sets: 'PUBLIC_URL', en: 'The address people open.', 'pt-BR': 'O endereço que as pessoas abrem.' },
  ingress: { value: 'direct|tunnel|external', sets: 'INGRESS', en: 'How HTTP reaches Telinha.', 'pt-BR': 'Como o HTTP chega à Telinha.' },
  'http-port': { value: 'N', sets: 'HTTP_PORT', en: 'direct: the redirect/ACME port; `0` turns it off.', 'pt-BR': 'direct: a porta do redirecionamento/ACME; `0` desliga.' },
  'https-port': { value: 'N', sets: 'HTTPS_PORT', en: 'direct: the TLS port Caddy binds.', 'pt-BR': 'direct: a porta TLS em que o Caddy escuta.' },
  'tunnel-token-file': {
    value: 'PATH|-', sets: 'TUNNEL_TOKEN',
    en: 'File holding the Cloudflare tunnel token; `-` reads stdin. The token never goes on the command line.',
    'pt-BR': 'Arquivo com o token do túnel da Cloudflare; `-` lê do stdin. O token nunca vai na linha de comando.',
  },
  'duckdns-domain': {
    value: 'NAME', sets: 'DDNS_PROVIDER=duckdns, DUCKDNS_DOMAIN',
    en: 'The DuckDNS subdomain; also sets `PUBLIC_URL=https://NAME.duckdns.org` unless `--public-url` is given.',
    'pt-BR': 'O subdomínio do DuckDNS; também define `PUBLIC_URL=https://NAME.duckdns.org` a menos que `--public-url` seja dado.',
  },
  'duckdns-token-file': { value: 'PATH|-', sets: 'DUCKDNS_TOKEN', en: 'File holding the DuckDNS token; `-` reads stdin.', 'pt-BR': 'Arquivo com o token do DuckDNS; `-` lê do stdin.' },
  'media-tcp': { value: 'N', sets: 'MEDIA_TCP_PORT', en: 'WebRTC TCP port.', 'pt-BR': 'Porta TCP do WebRTC.' },
  'media-udp': { value: 'N', sets: 'MEDIA_UDP_PORT', en: 'WebRTC UDP port.', 'pt-BR': 'Porta UDP do WebRTC.' },
  'node-ip': { value: 'IP', sets: 'LIVEKIT_NODE_IP', en: 'Static public IPv4 (a VPS).', 'pt-BR': 'IPv4 público fixo (uma VPS).' },
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
  upnp: { value: 'auto|off', sets: 'UPNP', en: 'Let Telinha ask the router to forward the ports.', 'pt-BR': 'Deixar a Telinha pedir ao roteador para encaminhar as portas.' },
  'auto-update': { value: 'on|off', sets: 'AUTO_UPDATE', en: 'Native binary: install new stable releases by itself.', 'pt-BR': 'Binário nativo: instalar novas versões estáveis sozinho.' },
  'no-service': { en: 'Skip the service install.', 'pt-BR': 'Pula a instalação do serviço.' },
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
      en: 'The helper programs this configuration needs (`livekit-server`; `caddy` or `cloudflared`) are in `bin/` at the pinned versions, or on `PATH`.',
      'pt-BR': 'Os programas auxiliares que esta configuração precisa (`livekit-server`; `caddy` ou `cloudflared`) estão em `bin/` nas versões fixadas, ou no `PATH`.',
    },
    fixes: {
      en: 'Start Telinha (the native binary downloads what is missing) or run `telinha setup`. From source: `bun scripts/bins.ts`.',
      'pt-BR': 'Inicie a Telinha (o binário nativo baixa o que falta) ou rode o `telinha setup`. A partir do código-fonte: `bun scripts/bins.ts`.',
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
      en: 'The A record of the `PUBLIC_URL` host (asked of 1.1.1.1 and 8.8.8.8) against the public IP (or `LIVEKIT_NODE_IP`); for a tunnel, only that it resolves.',
      'pt-BR': 'O registro A do host da `PUBLIC_URL` (perguntado a 1.1.1.1 e 8.8.8.8) comparado ao IP público (ou a `LIVEKIT_NODE_IP`); para um túnel, só que ele resolve.',
    },
    fixes: {
      en: 'Create or change the A record. DuckDNS: the running service updates it by itself.',
      'pt-BR': 'Crie ou altere o registro A. DuckDNS: o serviço rodando atualiza sozinho.',
    },
  },
  tls: {
    looksAt: {
      en: 'The certificate is valid for the host (warning under 14 days left) and `<PUBLIC_URL>/healthz` answers from the internet.',
      'pt-BR': 'O certificado é válido para o host (aviso com menos de 14 dias restantes) e `<PUBLIC_URL>/healthz` responde pela internet.',
    },
    fixes: {
      en: 'direct: Caddy gets the certificate by itself once ports 80 and 443 reach the machine (see `dns`, `listeners`, `mappings`). tunnel/external: check the proxy or tunnel in front.',
      'pt-BR': 'direct: o Caddy obtém o certificado sozinho quando as portas 80 e 443 chegam à máquina (veja `dns`, `listeners`, `mappings`). tunnel/external: confira o proxy ou o túnel na frente.',
    },
  },
  listeners: {
    looksAt: {
      en: 'Telinha answers on `LISTEN`, every child is up, LiveKit and the media TCP port listen, and in direct mode `HTTPS_PORT` listens. Prints the ufw/firewalld commands and the low-port hint for Linux users.',
      'pt-BR': 'A Telinha responde em `LISTEN`, todos os filhos estão de pé, o LiveKit e a porta TCP de mídia escutam, e no modo direct a `HTTPS_PORT` escuta. Imprime os comandos do ufw/firewalld e a dica de portas baixas para usuários Linux.',
    },
    fixes: {
      en: '`telinha service start` (or `telinha run`). Linux user install on 80/443: the one-time sysctl it prints, or `HTTPS_PORT=8443` with `HTTP_PORT=0` and the router forwarding 443 → 8443. Open the firewall with the printed commands.',
      'pt-BR': '`telinha service start` (ou `telinha run`). Instalação Linux de usuário em 80/443: o sysctl único que ele imprime, ou `HTTPS_PORT=8443` com `HTTP_PORT=0` e o roteador encaminhando 443 → 8443. Abra o firewall com os comandos impressos.',
    },
  },
  service: {
    looksAt: { en: 'The service is installed, running and starts at boot.', 'pt-BR': 'O serviço está instalado, rodando e inicia com o sistema.' },
    fixes: {
      en: '`telinha service install` or `telinha service start`; Windows: `telinha setup` again (one administrator prompt). Skipped for Docker and source runs.',
      'pt-BR': '`telinha service install` ou `telinha service start`; Windows: `telinha setup` de novo (um pedido de administrador). Pulado no Docker e rodando do código-fonte.',
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
      en: 'The router’s external IP against the public IP: an address in `100.64.0.0/10` (CGNAT) fails; a private address (double NAT) or a mismatch warns.',
      'pt-BR': 'O IP externo do roteador comparado ao IP público: um endereço em `100.64.0.0/10` (CGNAT) falha; um endereço privado (NAT duplo) ou uma diferença gera aviso.',
    },
    fixes: {
      en: 'CGNAT: ask the provider for a public IPv4, or use a VPS (`INGRESS=tunnel` carries the pages but not the media). Double NAT: bridge mode on the provider’s modem, or forward the ports on both devices.',
      'pt-BR': 'CGNAT: peça um IPv4 público à operadora, ou use uma VPS (`INGRESS=tunnel` leva as páginas, mas não a mídia). NAT duplo: modo bridge no modem da operadora, ou encaminhe as portas nos dois aparelhos.',
    },
  },
  mappings: {
    looksAt: {
      en: 'Every needed port is mapped by the router (with `UPNP=auto` and the service running); otherwise the list to forward by hand.',
      'pt-BR': 'Cada porta necessária está mapeada pelo roteador (com `UPNP=auto` e o serviço rodando); senão, a lista para encaminhar à mão.',
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
