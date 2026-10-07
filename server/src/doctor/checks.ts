// The doctor's checks, in the order a person fixes things: config, binaries,
// Discord, the public address and media path, the local service, the router,
// updates. Every outside call goes through the CheckContext so tests run
// offline.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { RoomServiceClient } from 'livekit-server-sdk';
import versionsJson from '../../../versions.json' with { type: 'json' };
import { type Config, KNOWN_KEYS, turnIneligibility, upnpMappings } from '../config.ts';
import { createDuckDns, DUCKDNS_REJECTED } from '../ddns.ts';
import { parseEnvFile } from '../envfile.ts';
import { footprintOf } from '../footprint.ts';
import type { Locale } from '../i18n.ts';
import * as netinfo from '../netinfo.ts';
import { TRAY_EXE } from '../release.ts';
import { SYSCTL_SCRIPT } from '../service/systemd.ts';
import { defaultProcessInfo, sameExe } from '../supervisor.ts';
import { compareVersions as compareSemver } from '../update/updater.ts';
import type {
  Check,
  CheckContext,
  CheckResult,
  CheckStatus,
  MapperStatusLike,
  MappingLike,
  NatProbeLike,
  NetLike,
  SysLike,
  UpdateStatusLike,
} from './types.ts';

const DISCORD_API = 'https://discord.com/api/v10';
const DAY_MS = 86_400_000;
const SIGNATURE_TIMEOUT_MS = 5_000;
// Under runChecks' 10 s cap, so a slow Cloud reads as unreachable rather than a timed-out check.
const CLOUD_TIMEOUT_MS = 8_000;
const RUN_KEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Run`;
// VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY
const BOT_PERMISSIONS = 68608;
// Either the limited (unverified app) or the full intent bit counts.
const PRESENCE_BITS = (1 << 12) | (1 << 13);
const MEMBERS_BITS = (1 << 14) | (1 << 15);

// ---------- strings ----------

const en = {
  'title.config': 'Configuration',
  'title.binaries': 'Helper programs',
  'title.discord-token': 'Discord bot token',
  'title.discord-intents': 'Discord intents',
  'title.discord-guild': 'Discord server',
  'title.discord-role': 'Discord role',
  'title.discord-channels': 'Discord channels',
  'title.discord-redirect': 'Discord login redirect',
  'title.public-ip': 'Public IP',
  'title.dns': 'DNS',
  'title.certificate': 'Certificate method',
  'title.tls': 'HTTPS certificate',
  'title.livekit-cloud': 'LiveKit Cloud',
  'title.turn': 'TURN over TLS',
  'title.listeners': 'Local listeners',
  'title.service': 'Background service',
  'title.tray': 'Tray icon',
  'title.gateway': 'Router',
  'title.cgnat': 'Carrier NAT',
  'title.mappings': 'Port forwarding',
  'title.update': 'Updates',

  skipLocal: 'Skipped (--local: no internet checks).',
  timedOut: 'Did not finish within {s} s.',
  crashed: 'The check itself failed: {error}',
  needConfig: 'Skipped: fix the configuration first.',
  devLogin: 'Skipped: DEV_USER fake login does not use Discord.',
  needToken: 'Skipped: the bot token check did not pass.',
  needGuild: 'Skipped: the bot is not in the server yet.',
  discordUnreachable: 'Could not reach Discord: {error}',
  discordHttp: 'Discord answered HTTP {status}.',
  rerunSetup: 'Run telinha setup.',

  configOk: 'telinha.env is valid.',
  configEnvOnly: 'No telinha.env: the configuration comes from the environment.',
  configError: 'The configuration has an error: {error}',
  configErrorFix: 'Edit {file} (or run telinha setup again).',
  configWarning: '{warning}',
  configUnknown: 'Unknown key {key} in telinha.env (typo?).',
  permSkipped: 'No telinha.env, so there are no file permissions to check.',
  permOpen: 'telinha.env can be read by other users of this computer, and it holds secrets.',
  permOpenFixLinux: 'Run: chmod 600 "{file}"',
  permOpenFixWindows:
    'Run telinha setup again (it locks the file down), or: icacls "{file}" /inheritance:r /grant:r "%USERNAME%:F" "*S-1-5-18:F" "*S-1-5-32-544:F"',
  permUnknown: 'Could not read the permissions of telinha.env.',

  binOk: 'All helper programs are in place.',
  binNone: 'No helper programs needed for this configuration.',
  binLine: '{tool} {version} ({where})',
  binPath: '{tool} found on PATH ({where})',
  binMissing: '{tool} is missing.',
  binMissingFixCompiled: 'Start telinha (it downloads missing programs) or run telinha setup.',
  binMissingFixDev: 'Run: bun scripts/bins.ts',
  binStale: '{tool} {have} is installed, {want} is pinned: the next start downloads {want}.',
  binNoSidecar: '{tool} in {dir} has no version record: the next start downloads it again.',
  binCaddyNoDns: 'The caddy at {where} has no DuckDNS module: the certificate (DNS challenge) cannot be obtained.',
  binCaddyNoDnsFixCompiled: "Delete {where} and run telinha setup again: it downloads Telinha's own Caddy build.",
  binCaddyNoDnsFixPath:
    "Telinha's own Caddy is not in {bin}, so the one on PATH is used: run telinha setup again (or restart telinha) while online and it downloads Telinha's build into {bin}. The caddy at {where} is left as it is.",
  binCaddyNoDnsFixDev:
    "Fetch Telinha's Caddy build (bun scripts/bins.ts --out {bin} caddy) or build one (bun run caddy --out {bin}).",
  binCaddyNoProbe: 'Could not read {where} to look for the DuckDNS module.',

  tokenOk: 'The token works (application "{name}").',
  tokenBad: 'Discord rejected DISCORD_TOKEN.',
  tokenBadFix: 'Developer Portal → your app → Bot → Reset Token, then run telinha setup.',
  clientIdMismatch: "DISCORD_CLIENT_ID {have} is not this bot's application ({want}).",
  clientIdMismatchFix: 'Set DISCORD_CLIENT_ID={want} (or run telinha setup).',

  intentsOk: 'Presence and Server Members intents are on.',
  intentsMissing: 'Intents switched off: {list}. The bot cannot log in without them.',
  intentsFix: 'Run telinha setup (it switches them on), or toggle them on the Bot page of the Developer Portal.',
  intentPresence: 'Presence',
  intentMembers: 'Server Members',

  guildOk: 'The bot is in "{name}".',
  guildMissing: 'The bot is not in the server GUILD_ID {id}.',
  guildMissingFix: 'Invite it: {url}',

  roleOk: 'Role "{name}" exists.',
  roleMissing: 'ROLE_ID {id} is not a role in this server.',
  roleFix: "Run telinha setup again: it lists the server's roles to pick from.",

  channelsAll: 'No CHANNEL_IDS: the command works in every channel.',
  channelsOk: 'Command channels: {list}.',
  channelMissing: 'CHANNEL_IDS has {id}, which is not a channel in this server.',
  channelWrongType: 'Channel #{name} ({id}) is not a text or announcement channel.',
  channelsFix: 'Run telinha setup again: it lists the channels the bot can see to pick from.',

  redirectOk: 'Login redirect {uri} is registered.',
  redirectMissing: 'Discord does not know the login redirect {uri}: login fails with "Invalid OAuth2 redirect_uri".',
  redirectFix: 'Developer Portal → your app → OAuth2 → Redirects → add {uri}, then Save Changes',
  redirectHave: 'Registered: {list}',

  ipOk: 'The internet sees this network as {ip}.',
  ipFail: 'Could not find the public IP: is this computer offline?',

  dnsLocal: 'Skipped: PUBLIC_URL points at this computer.',
  dnsIp: 'Skipped: PUBLIC_URL uses an IP address, no DNS involved.',
  dnsFail: '{host} does not resolve: {error}',
  dnsFailFix: 'Create an A record for {host} pointing at {ip}.',
  dnsTunnelOk: '{host} resolves ({ips}); Cloudflare routes it through the tunnel.',
  dnsOk: '{host} points at {ip}.',
  dnsUnknownIp: '{host} resolves to {ips}; the public IP is unknown, so it could not be compared.',
  dnsWrong: '{host} points at {ips}, but the public IP is {ip}.',
  dnsWrongFix: 'Change the A record of {host} to {ip}.',
  dnsDuck: 'DuckDNS points {host} at {ips}, the public IP is {ip}; the running service updates it.',
  dnsDuckToken:
    'DuckDNS rejected the token for {host}: the record cannot be updated and the certificate (DNS challenge) cannot be obtained.',
  dnsDuckTokenFix:
    'Copy the token from duckdns.org (shown at the top once you sign in, with {host} among your domains) and run telinha setup again.',
  dnsDuckTokenOk: 'DuckDNS accepts the token for {host}.',
  dnsDuckTokenUnknown: 'Could not ask DuckDNS about the token: {error}',
  dnsExternal:
    '{host} points at {ips}, not at this network ({ip}): fine if another proxy in front forwards to telinha.',

  certTunnel: 'Cloudflare terminates HTTPS for {host}; nothing to obtain here.',
  certExternal: 'Your reverse proxy holds the certificate for {host}.',
  certDns:
    "Let's Encrypt through DuckDNS (DNS challenge) for {host}; HTTPS on port {port}, ports 80 and 443 are not used.",
  certHttp: "Let's Encrypt over ports 80 and 443 (HTTP challenge) for {host}.",
  certAlpn: "Let's Encrypt over port 443 (TLS-ALPN challenge) for {host}.",
  certHomeAdvanced:
    'Advanced home setup: ports 80 and 443 must reach this machine, forwarded by hand. The standard home options (a Cloudflare Tunnel, or a DuckDNS address with HTTPS on port 8443) need neither.',

  tlsHttp: 'Skipped: PUBLIC_URL is plain http.',
  tlsBad: 'The certificate of {host} is not valid: {error}',
  tlsBadFixDirect:
    'Caddy gets the certificate by itself once ports 80 and 443 reach this computer: see the DNS, listeners and port forwarding checks.',
  tlsBadFixDns:
    "Caddy asks Let's Encrypt through DuckDNS: check the DuckDNS token (dns check), that port {port} is free for Caddy (listeners) and the [caddy] lines in the log; a fresh install can take a few minutes.",
  tlsBadFix: 'Check the proxy or tunnel in front of telinha.',
  tlsExpired: 'The certificate of {host} expired.',
  tlsSoon: 'The certificate of {host} expires in {days} days.',
  tlsSoonFix: "Caddy renews it on its own when it can reach Let's Encrypt; check the logs.",
  tlsOk: 'Valid certificate by {issuer}, {days} days left; {url}/healthz answers.',
  healthFail: '{url}/healthz did not answer from the internet: {error}',
  healthFailFix: 'Check that telinha is running (listeners check) and that the ingress reaches it.',

  cloudSkipSelf: 'Skipped: MEDIA=self runs LiveKit on this machine.',
  cloudOk: 'Connected to {host}: {n} room(s) open there.',
  cloudAuth: 'LiveKit Cloud rejected the API key or secret for {host}.',
  cloudAuthFix:
    'Cloud dashboard → your project → Settings → Keys: copy the key and secret into LIVEKIT_API_KEY / LIVEKIT_API_SECRET (or run telinha setup --non-interactive --media cloud --cloud-url ... --livekit-key ... with LIVEKIT_API_SECRET set).',
  cloudUnreachable: 'Could not reach LiveKit Cloud at {host}: {error}',
  cloudUnreachableFix:
    "Check LIVEKIT_CLOUD_URL (Settings → Project → URL, wss://<project>.livekit.cloud) and this machine's internet access.",
  cloudAutoCreate:
    "In the project's settings, turn automatic room creation off: Telinha creates and deletes rooms itself, and a closed room must not come back when someone opens an old link.",
  cloudLimits:
    'Free Build plan: 5,000 WebRTC participant-minutes and 50 GB downstream a month, as a hard cap (past that, LiveKit Cloud refuses new connections until the next month), and up to 100 participants connected at once.',

  turnOff: 'Skipped: TURN=off.',
  turnNotHere: 'Skipped: TURN over TLS on 443 is for a VPS in direct mode on port 443 ({why}).',
  turnAvailable:
    'TURN over TLS is available: create the DNS record turn.{host} → {ip} (A record, same IP as {host}) and set TURN=on in telinha.env. It lets people on networks that only allow port 443 watch and stream.',
  turnDnsFail: 'turn.{host} does not resolve: {error}',
  turnDnsWrong: 'turn.{host} points at {ips}, but the public IP is {ip}.',
  turnDnsFix: 'Create an A record turn.{host} → {ip}. DuckDNS and sslip.io names need nothing.',
  turnDnsUnknownIp: 'turn.{host} resolves to {ips}; the public IP is unknown, so it could not be compared.',
  turnTlsBad: 'turn.{host}:443 has no valid certificate: {error}',
  turnTlsFix:
    'Caddy obtains it after the start (a few minutes; it needs port 80 open for the HTTP challenge, or 443 for TLS-ALPN). Look at the [caddy] lines in the log.',
  turnLocalDown: "LiveKit's TURN is not listening on 127.0.0.1:{port} (TURN_PORT).",
  turnOk:
    "turn.{host}:443 has a valid certificate and LiveKit's TURN is listening on 127.0.0.1:{port} behind Caddy. Whether a phone can relay through it is what the phone test's TURN/TLS row shows.",

  listenDown: 'telinha is not running on this computer ({url}).',
  listenDownFix: 'Start it: telinha service start (or telinha run).',
  listenOk: 'telinha answers on {url}, every child process is up.',
  listenRooms: 'Open rooms: {n}',
  listenChild: '{name}: {state}',
  childDown: 'Child processes not up: {list}.',
  livekitDown: 'LiveKit does not answer on port {port}.',
  mediaTcpDown: 'Nothing accepts connections on media TCP port {port}.',
  httpsDown: 'Nothing listens on HTTPS port {port}.',
  listenTurnUp: 'TURN (TURN_PORT): listening on 127.0.0.1:{port}',
  listenTurnDown: 'TURN (TURN_PORT): nothing listening on 127.0.0.1:{port}',
  lowPortFix:
    'Ports below 1024 need root on Linux. Allow them once (it survives every update): {cmd}. The standard home options of telinha setup need no low port.',
  fwUfw: 'If ufw is active, open the ports: {cmd}',
  fwFirewalld: 'If firewalld is running, open the ports: {cmd}',

  serviceNone: 'Skipped: not a native install (Docker, a source checkout) or no service manager here.',
  serviceNotInstalled: 'telinha is not installed as a background service: it stops when you close the terminal.',
  serviceNotInstalledFix: 'Run: telinha service install',
  serviceNotInstalledFixWin:
    'Run telinha setup again: it installs the service (and the firewall rules) with one administrator prompt.',
  serviceNotInstalledFixRoot: 'Run: sudo telinha service install',
  serviceStopped: 'The service is installed but not running.',
  serviceStoppedFix: 'Run: telinha service start',
  serviceDisabled: 'The service does not start with the computer.',
  serviceDisabledFix: 'Run: telinha service install (again)',
  serviceDisabledFixWin: 'Run telinha setup again: it re-registers the service with one administrator prompt.',
  serviceDisabledFixRoot: 'Run: sudo telinha service install (again)',
  serviceOk: 'The service is installed, enabled and running.',

  traySkip: 'The tray icon exists on native Windows installs only.',
  trayNotInstalled: 'Tray icon not installed.',
  trayNotInstalledDetail: 'Install it: telinha setup, answering yes to the tray icon',
  trayStaleRun: 'Start with Windows points at a missing telinha-tray.exe.',
  trayStaleRunFix: 'telinha tray autostart off',
  trayOk: 'Tray icon running ({version}).',
  trayMismatch: 'Tray icon {have} does not match Telinha {want}.',
  trayMismatchFix: 'telinha tray stop, then telinha tray start.',
  trayStopped: 'Tray icon installed, not running.',
  trayStoppedDetail: 'Start it: telinha tray start',
  trayAutostartYes: 'starts with Windows: yes',
  trayAutostartNo: 'starts with Windows: no',
  traySigned: 'signed by {signer}',
  trayUnsigned: 'not code-signed',

  natNone: 'Skipped: the router probe is not available here.',
  natPublicHost: 'This computer has a public address ({ip}); no router in the way.',
  gatewayOk: 'Router at {gw} speaks {kind}; it reports external IP {ip}.',
  gatewayNoIp: 'Router at {gw} speaks {kind} but did not report its external IP.',
  gatewayNone: 'No router answered UPnP, NAT-PMP or PCP.',
  gatewayNoneFix: 'Open the ports on the router by hand: {list}',

  cgnatSkip: 'Skipped: no router to ask for its external IP.',
  cgnatOk: 'The router has the public IP {ip}.',
  cgnatFail:
    'Your internet provider uses carrier NAT (router external IP {ip}): nobody on the internet can reach this network.',
  cgnatFailFix:
    'For the web side use INGRESS=tunnel or a VPS. For the video, either ask your provider for a public IPv4 (a public IP or a CGNAT opt-out) or set MEDIA=cloud: LiveKit Cloud carries the media and needs no open port (free Build plan: 5,000 participant-minutes and 50 GB a month, up to 100 participants connected at once).',
  cgnatCloud:
    'Your provider uses carrier NAT ({ip}); the video goes through LiveKit Cloud, so only the pages need a way in: INGRESS=tunnel or a VPS.',
  doubleNat:
    "Double NAT: the router's external IP {ip} is a private address, so another router (often the provider's modem) sits in front.",
  doubleNatFix: "Put the provider's modem in bridge mode, or forward the ports on both devices: {list}",
  natMismatch: 'The router reports {ext}, but the internet sees {ip}: there is probably another NAT in front.',

  mapSkipNoPorts: 'Skipped: this configuration needs no inbound ports.',
  mapSkipNoneAsked: 'Skipped: nothing here is asked of the router. Forward by hand: {list}',
  mapSkipNoGw: 'Skipped: no router supports automatic port forwarding.',
  mapSkipOff: 'Skipped: UPNP=off. Forward by hand: {list}',
  mapSkipNoStatus: 'Skipped: the running service opens the ports; start it to see them.',
  mapOk: 'Every needed port is forwarded: {list}.',
  mapPartial: 'Not forwarded: {list}.',
  mapPartialFix: 'Forward them by hand on the router to {ip}: {list}',
  mapByHand: 'Forwarded by hand, not asked of the router: {list}',

  updSkip: 'Skipped: Docker/dev, updates are not managed here.',
  updOk: 'Up to date ({version}).',
  updUnknown: 'Running {version}; the newest release is unknown.',
  updAvailable: '{latest} is available (running {version}).',
  updAvailableFix: 'It installs by itself when no room is open, or now: telinha update --now',
  updStaged: 'Update to {tag} installed, waiting for the restart to confirm it.',
  updFailed: 'Update to {tag} failed ({reason}); it is retried when a newer release appears.',
  updFailedFix: 'Retry now: telinha update --now',
  updPending: '{tag} is published but its files are not ready yet; retried automatically.',
} as const;

type Key = keyof typeof en;
type Dict = { readonly [K in Key]: string };

const ptBR: Dict = {
  'title.config': 'Configuração',
  'title.binaries': 'Programas auxiliares',
  'title.discord-token': 'Token do bot',
  'title.discord-intents': 'Intents do Discord',
  'title.discord-guild': 'Servidor do Discord',
  'title.discord-role': 'Cargo do Discord',
  'title.discord-channels': 'Canais do Discord',
  'title.discord-redirect': 'Redirect do login',
  'title.public-ip': 'IP público',
  'title.dns': 'DNS',
  'title.certificate': 'Como vem o certificado',
  'title.tls': 'Certificado HTTPS',
  'title.livekit-cloud': 'LiveKit Cloud',
  'title.turn': 'TURN sobre TLS',
  'title.listeners': 'Portas locais',
  'title.service': 'Serviço em segundo plano',
  'title.tray': 'Ícone na bandeja',
  'title.gateway': 'Roteador',
  'title.cgnat': 'NAT da operadora',
  'title.mappings': 'Redirecionamento de portas',
  'title.update': 'Atualizações',

  skipLocal: 'Pulado (--local: sem testes de internet).',
  timedOut: 'Não terminou em {s} s.',
  crashed: 'O próprio teste falhou: {error}',
  needConfig: 'Pulado: arruma a configuração primeiro.',
  devLogin: 'Pulado: o login falso DEV_USER não usa o Discord.',
  needToken: 'Pulado: o teste do token do bot não passou.',
  needGuild: 'Pulado: o bot ainda não está no servidor.',
  discordUnreachable: 'Não deu pra falar com o Discord: {error}',
  discordHttp: 'O Discord respondeu HTTP {status}.',
  rerunSetup: 'Roda o telinha setup.',

  configOk: 'O telinha.env está certo.',
  configEnvOnly: 'Sem telinha.env: a configuração vem das variáveis de ambiente.',
  configError: 'A configuração tem um erro: {error}',
  configErrorFix: 'Edita o {file} (ou roda o telinha setup de novo).',
  configWarning: '{warning}',
  configUnknown: 'Chave desconhecida {key} no telinha.env (erro de digitação?).',
  permSkipped: 'Sem telinha.env, então não há permissões de arquivo pra conferir.',
  permOpen: 'Outros usuários deste computador conseguem ler o telinha.env, e ele guarda segredos.',
  permOpenFixLinux: 'Roda: chmod 600 "{file}"',
  permOpenFixWindows:
    'Roda o telinha setup de novo (ele tranca o arquivo), ou: icacls "{file}" /inheritance:r /grant:r "%USERNAME%:F" "*S-1-5-18:F" "*S-1-5-32-544:F"',
  permUnknown: 'Não deu pra ler as permissões do telinha.env.',

  binOk: 'Todos os programas auxiliares estão no lugar.',
  binNone: 'Esta configuração não precisa de programas auxiliares.',
  binLine: '{tool} {version} ({where})',
  binPath: '{tool} achado no PATH ({where})',
  binMissing: 'Falta o {tool}.',
  binMissingFixCompiled: 'Inicia a Telinha (ela baixa o que falta) ou roda o telinha setup.',
  binMissingFixDev: 'Roda: bun scripts/bins.ts',
  binStale: '{tool} {have} está instalado, a versão fixada é {want}: a próxima inicialização baixa a {want}.',
  binNoSidecar: '{tool} em {dir} não tem registro de versão: a próxima inicialização baixa de novo.',
  binCaddyNoDns: 'O caddy em {where} não tem o módulo do DuckDNS: o certificado (desafio DNS) não tem como sair.',
  binCaddyNoDnsFixCompiled: 'Apaga {where} e roda o telinha setup de novo: ele baixa o Caddy da própria Telinha.',
  binCaddyNoDnsFixPath:
    'O Caddy da própria Telinha não está em {bin}, então o do PATH é que está sendo usado: roda o telinha setup de novo (ou reinicia a Telinha) com internet e ele baixa o build da Telinha em {bin}. O caddy em {where} fica como está.',
  binCaddyNoDnsFixDev:
    'Baixa o Caddy da Telinha (bun scripts/bins.ts --out {bin} caddy) ou compila um (bun run caddy --out {bin}).',
  binCaddyNoProbe: 'Não deu pra ler {where} pra procurar o módulo do DuckDNS.',

  tokenOk: 'O token funciona (aplicação "{name}").',
  tokenBad: 'O Discord recusou o DISCORD_TOKEN.',
  tokenBadFix: 'Developer Portal → teu app → Bot → Reset Token, depois roda o telinha setup.',
  clientIdMismatch: 'DISCORD_CLIENT_ID {have} não é a aplicação deste bot ({want}).',
  clientIdMismatchFix: 'Põe DISCORD_CLIENT_ID={want} (ou roda o telinha setup).',

  intentsOk: 'As intents Presence e Server Members estão ligadas.',
  intentsMissing: 'Intents desligadas: {list}. O bot não entra sem elas.',
  intentsFix: 'Roda o telinha setup (ele liga elas), ou liga na página Bot do Developer Portal.',
  intentPresence: 'Presence',
  intentMembers: 'Server Members',

  guildOk: 'O bot está em "{name}".',
  guildMissing: 'O bot não está no servidor GUILD_ID {id}.',
  guildMissingFix: 'Convida ele: {url}',

  roleOk: 'O cargo "{name}" existe.',
  roleMissing: 'ROLE_ID {id} não é um cargo deste servidor.',
  roleFix: 'Roda o telinha setup de novo: ele lista os cargos do servidor pra escolher.',

  channelsAll: 'Sem CHANNEL_IDS: o comando funciona em qualquer canal.',
  channelsOk: 'Canais do comando: {list}.',
  channelMissing: 'CHANNEL_IDS tem {id}, que não é um canal deste servidor.',
  channelWrongType: 'O canal #{name} ({id}) não é de texto nem de anúncios.',
  channelsFix: 'Roda o telinha setup de novo: ele lista os canais que o bot vê pra escolher.',

  redirectOk: 'O redirect do login {uri} está cadastrado.',
  redirectMissing: 'O Discord não conhece o redirect {uri}: o login falha com "Invalid OAuth2 redirect_uri".',
  redirectFix: 'Developer Portal → teu app → OAuth2 → Redirects → adiciona {uri} e clica em Save Changes',
  redirectHave: 'Cadastrados: {list}',

  ipOk: 'A internet vê esta rede como {ip}.',
  ipFail: 'Não deu pra descobrir o IP público: o computador está sem internet?',

  dnsLocal: 'Pulado: PUBLIC_URL aponta pra este computador.',
  dnsIp: 'Pulado: PUBLIC_URL usa um endereço IP, sem DNS no meio.',
  dnsFail: '{host} não resolve: {error}',
  dnsFailFix: 'Cria um registro A pra {host} apontando pra {ip}.',
  dnsTunnelOk: '{host} resolve ({ips}); a Cloudflare leva pelo túnel.',
  dnsOk: '{host} aponta pra {ip}.',
  dnsUnknownIp: '{host} resolve pra {ips}; o IP público é desconhecido, então não deu pra comparar.',
  dnsWrong: '{host} aponta pra {ips}, mas o IP público é {ip}.',
  dnsWrongFix: 'Muda o registro A de {host} pra {ip}.',
  dnsDuck: 'O DuckDNS aponta {host} pra {ips}, o IP público é {ip}; o serviço rodando atualiza isso.',
  dnsDuckToken:
    'O DuckDNS recusou o token pra {host}: o registro não atualiza e o certificado (desafio DNS) não tem como sair.',
  dnsDuckTokenFix:
    'Copia o token do duckdns.org (aparece no topo depois de entrar, com {host} entre os teus domínios) e roda o telinha setup de novo.',
  dnsDuckTokenOk: 'O DuckDNS aceita o token pra {host}.',
  dnsDuckTokenUnknown: 'Não deu pra perguntar ao DuckDNS sobre o token: {error}',
  dnsExternal:
    '{host} aponta pra {ips}, não pra esta rede ({ip}): tudo bem se outro proxy na frente repassa pra Telinha.',

  certTunnel: 'A Cloudflare cuida do HTTPS de {host}; não há nada pra obter aqui.',
  certExternal: 'Teu proxy reverso guarda o certificado de {host}.',
  certDns:
    "Let's Encrypt pelo DuckDNS (desafio DNS) pra {host}; HTTPS na porta {port}, as portas 80 e 443 não são usadas.",
  certHttp: "Let's Encrypt pelas portas 80 e 443 (desafio HTTP) pra {host}.",
  certAlpn: "Let's Encrypt pela porta 443 (desafio TLS-ALPN) pra {host}.",
  certHomeAdvanced:
    'Configuração avançada em casa: as portas 80 e 443 precisam chegar neste computador, redirecionadas na mão. As opções padrão pra casa (um Cloudflare Tunnel, ou um endereço DuckDNS com HTTPS na porta 8443) não precisam de nenhuma das duas.',

  tlsHttp: 'Pulado: PUBLIC_URL é http simples.',
  tlsBad: 'O certificado de {host} não é válido: {error}',
  tlsBadFixDirect:
    'O Caddy pega o certificado sozinho quando as portas 80 e 443 chegam neste computador: olha os testes de DNS, portas locais e redirecionamento.',
  tlsBadFixDns:
    "O Caddy pede ao Let's Encrypt pelo DuckDNS: confere o token do DuckDNS (teste de DNS), se a porta {port} está livre pro Caddy (portas locais) e as linhas [caddy] do log; numa instalação nova pode levar alguns minutos.",
  tlsBadFix: 'Confere o proxy ou o túnel na frente da Telinha.',
  tlsExpired: 'O certificado de {host} venceu.',
  tlsSoon: 'O certificado de {host} vence em {days} dias.',
  tlsSoonFix: "O Caddy renova sozinho quando alcança o Let's Encrypt; olha os logs.",
  tlsOk: 'Certificado válido de {issuer}, faltam {days} dias; {url}/healthz responde.',
  healthFail: '{url}/healthz não respondeu pela internet: {error}',
  healthFailFix: 'Confere se a Telinha está rodando (teste de portas locais) e se a entrada chega nela.',

  cloudSkipSelf: 'Pulado: com MEDIA=self o LiveKit roda neste computador.',
  cloudOk: 'Conectado a {host}: {n} sala(s) aberta(s) lá.',
  cloudAuth: 'O LiveKit Cloud recusou a chave ou o segredo da API pra {host}.',
  cloudAuthFix:
    'Painel do Cloud → teu projeto → Settings → Keys: copia a chave e o segredo pro LIVEKIT_API_KEY / LIVEKIT_API_SECRET (ou roda telinha setup --non-interactive --media cloud --cloud-url ... --livekit-key ... com o LIVEKIT_API_SECRET definido).',
  cloudUnreachable: 'Não deu pra falar com o LiveKit Cloud em {host}: {error}',
  cloudUnreachableFix:
    'Confere o LIVEKIT_CLOUD_URL (Settings → Project → URL, wss://<projeto>.livekit.cloud) e a internet deste computador.',
  cloudAutoCreate:
    'Nas configurações do projeto, desliga a criação automática de salas: a Telinha cria e apaga as salas sozinha, e uma sala fechada não pode voltar quando alguém abre um link antigo.',
  cloudLimits:
    'Plano gratuito Build: 5.000 participante-minutos de WebRTC e 50 GB de download por mês, como teto rígido (passou disso, o LiveKit Cloud recusa conexões novas até o mês seguinte), e até 100 participantes conectados ao mesmo tempo.',

  turnOff: 'Pulado: TURN=off.',
  turnNotHere: 'Pulado: TURN sobre TLS na 443 é pra uma VPS no modo direto na porta 443 ({why}).',
  turnAvailable:
    'TURN sobre TLS está disponível: cria o registro DNS turn.{host} → {ip} (registro A, mesmo IP de {host}) e põe TURN=on no telinha.env. Ele deixa quem está numa rede que só libera a porta 443 assistir e transmitir.',
  turnDnsFail: 'turn.{host} não resolve: {error}',
  turnDnsWrong: 'turn.{host} aponta pra {ips}, mas o IP público é {ip}.',
  turnDnsFix: 'Cria um registro A turn.{host} → {ip}. Nomes do DuckDNS e do sslip.io não precisam de nada.',
  turnDnsUnknownIp: 'turn.{host} resolve pra {ips}; o IP público é desconhecido, então não deu pra comparar.',
  turnTlsBad: 'turn.{host}:443 não tem certificado válido: {error}',
  turnTlsFix:
    'O Caddy pega ele depois de iniciar (alguns minutos; precisa da porta 80 aberta pro desafio HTTP, ou da 443 pro TLS-ALPN). Olha as linhas [caddy] do log.',
  turnLocalDown: 'O TURN do LiveKit não está escutando em 127.0.0.1:{port} (TURN_PORT).',
  turnOk:
    'turn.{host}:443 tem certificado válido e o TURN do LiveKit está escutando em 127.0.0.1:{port} atrás do Caddy. Se um celular consegue passar por ele é o que mostra a linha TURN/TLS do teste no celular.',

  listenDown: 'A Telinha não está rodando neste computador ({url}).',
  listenDownFix: 'Inicia: telinha service start (ou telinha run).',
  listenOk: 'A Telinha responde em {url}, todos os processos filhos estão de pé.',
  listenRooms: 'Salas abertas: {n}',
  listenChild: '{name}: {state}',
  childDown: 'Processos filhos fora do ar: {list}.',
  livekitDown: 'O LiveKit não responde na porta {port}.',
  mediaTcpDown: 'Nada aceita conexões na porta TCP de mídia {port}.',
  httpsDown: 'Nada escuta na porta HTTPS {port}.',
  listenTurnUp: 'TURN (TURN_PORT): escutando em 127.0.0.1:{port}',
  listenTurnDown: 'TURN (TURN_PORT): nada escutando em 127.0.0.1:{port}',
  lowPortFix:
    'No Linux, portas abaixo de 1024 precisam de root. Libera uma vez (vale pra todas as atualizações): {cmd}. As opções padrão pra casa do telinha setup não precisam de porta baixa.',
  fwUfw: 'Se o ufw estiver ativo, abre as portas: {cmd}',
  fwFirewalld: 'Se o firewalld estiver rodando, abre as portas: {cmd}',

  serviceNone: 'Pulado: não é uma instalação nativa (Docker, código-fonte) ou não há gerenciador de serviços aqui.',
  serviceNotInstalled: 'A Telinha não está instalada como serviço: ela para quando fecha o terminal.',
  serviceNotInstalledFix: 'Roda: telinha service install',
  serviceNotInstalledFixWin:
    'Roda o telinha setup de novo: ele instala o serviço (e as regras de firewall) com um pedido de administrador.',
  serviceNotInstalledFixRoot: 'Roda: sudo telinha service install',
  serviceStopped: 'O serviço está instalado mas parado.',
  serviceStoppedFix: 'Roda: telinha service start',
  serviceDisabled: 'O serviço não inicia junto com o computador.',
  serviceDisabledFix: 'Roda: telinha service install (de novo)',
  serviceDisabledFixWin: 'Roda o telinha setup de novo: ele registra o serviço de novo com um pedido de administrador.',
  serviceDisabledFixRoot: 'Roda: sudo telinha service install (de novo)',
  serviceOk: 'O serviço está instalado, habilitado e rodando.',

  traySkip: 'O ícone na bandeja só existe em instalações nativas no Windows.',
  trayNotInstalled: 'Ícone na bandeja não instalado.',
  trayNotInstalledDetail: 'Pra instalar: telinha setup, respondendo sim ao ícone',
  trayStaleRun: 'O início com o Windows aponta pra um telinha-tray.exe que não existe.',
  trayStaleRunFix: 'telinha tray autostart off',
  trayOk: 'Ícone na bandeja rodando ({version}).',
  trayMismatch: 'O ícone na bandeja {have} não bate com a Telinha {want}.',
  trayMismatchFix: 'telinha tray stop, depois telinha tray start.',
  trayStopped: 'Ícone na bandeja instalado, parado.',
  trayStoppedDetail: 'Pra iniciar: telinha tray start',
  trayAutostartYes: 'inicia com o Windows: sim',
  trayAutostartNo: 'inicia com o Windows: não',
  traySigned: 'assinado por {signer}',
  trayUnsigned: 'sem assinatura de código',

  natNone: 'Pulado: o teste do roteador não está disponível aqui.',
  natPublicHost: 'Este computador tem endereço público ({ip}); nenhum roteador no meio.',
  gatewayOk: 'O roteador em {gw} fala {kind}; ele informa o IP externo {ip}.',
  gatewayNoIp: 'O roteador em {gw} fala {kind} mas não informou o IP externo.',
  gatewayNone: 'Nenhum roteador respondeu UPnP, NAT-PMP ou PCP.',
  gatewayNoneFix: 'Abre as portas no roteador na mão: {list}',

  cgnatSkip: 'Pulado: nenhum roteador pra perguntar o IP externo.',
  cgnatOk: 'O roteador tem o IP público {ip}.',
  cgnatFail: 'Tua operadora usa NAT de operadora (IP externo do roteador {ip}): ninguém na internet alcança esta rede.',
  cgnatFailFix:
    'Pro lado web usa INGRESS=tunnel ou uma VPS. Pro vídeo, ou pede um IPv4 público pra operadora (IP público ou sair do CGNAT) ou põe MEDIA=cloud: o LiveKit Cloud leva a mídia e não precisa de porta aberta (plano gratuito Build: 5.000 participante-minutos e 50 GB por mês, até 100 participantes conectados ao mesmo tempo).',
  cgnatCloud:
    'Tua operadora usa NAT de operadora ({ip}); o vídeo passa pelo LiveKit Cloud, então só as páginas precisam de uma entrada: INGRESS=tunnel ou uma VPS.',
  doubleNat:
    'NAT duplo: o IP externo do roteador {ip} é privado, então tem outro roteador na frente (geralmente o modem da operadora).',
  doubleNatFix: 'Põe o modem da operadora em modo bridge, ou redireciona as portas nos dois aparelhos: {list}',
  natMismatch: 'O roteador informa {ext}, mas a internet vê {ip}: provavelmente tem outro NAT na frente.',

  mapSkipNoPorts: 'Pulado: esta configuração não precisa de portas de entrada.',
  mapSkipNoneAsked: 'Pulado: nada aqui é pedido ao roteador. Redireciona na mão: {list}',
  mapSkipNoGw: 'Pulado: nenhum roteador aceita redirecionamento automático.',
  mapSkipOff: 'Pulado: UPNP=off. Redireciona na mão: {list}',
  mapSkipNoStatus: 'Pulado: o serviço rodando abre as portas; inicia ele pra ver.',
  mapOk: 'Todas as portas necessárias estão redirecionadas: {list}.',
  mapPartial: 'Sem redirecionamento: {list}.',
  mapPartialFix: 'Redireciona na mão no roteador pra {ip}: {list}',
  mapByHand: 'Redirecionadas na mão, sem pedir ao roteador: {list}',

  updSkip: 'Pulado: Docker/dev, as atualizações não são gerenciadas aqui.',
  updOk: 'Atualizada ({version}).',
  updUnknown: 'Rodando {version}; a versão mais nova é desconhecida.',
  updAvailable: '{latest} está disponível (rodando {version}).',
  updAvailableFix: 'Instala sozinha quando nenhuma sala estiver aberta, ou agora: telinha update --now',
  updStaged: 'Atualização pra {tag} instalada, esperando a reinicialização confirmar.',
  updFailed: 'A atualização pra {tag} falhou ({reason}); tenta de novo quando sair uma versão mais nova.',
  updFailedFix: 'Tenta agora: telinha update --now',
  updPending: '{tag} foi publicada mas os arquivos ainda não estão prontos; tenta de novo sozinha.',
};

const dicts: Record<Locale, Dict> = { en, 'pt-BR': ptBR };

function tr(locale: Locale, key: Key, params: Record<string, string | number> = {}): string {
  const s = dicts[locale][key] ?? en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(params, k) ? String(params[k]) : m));
}

/** Localized title of a check id; the id itself for an unknown one. */
export function checkTitle(id: string, locale: Locale): string {
  const key = `title.${id}`;
  return Object.hasOwn(en, key) ? tr(locale, key as Key) : id;
}

// ---------- helpers ----------

interface Finding {
  status: Exclude<CheckStatus, 'skip'>;
  summary: string;
  fix?: string;
}

const RANK: Record<CheckStatus, number> = { skip: 0, ok: 1, warn: 2, fail: 3 };

function make(
  ctx: CheckContext,
  id: string,
  status: CheckStatus,
  summary: string,
  extra: { detail?: string[]; fix?: string } = {},
): CheckResult {
  const r: CheckResult = { id, title: checkTitle(id, ctx.locale), status, summary };
  if (extra.detail?.length) r.detail = extra.detail;
  if (extra.fix && (status === 'warn' || status === 'fail')) r.fix = extra.fix;
  return r;
}

/** Worst finding leads (summary + fix); the others become detail lines. */
function combine(
  ctx: CheckContext,
  id: string,
  findings: Finding[],
  okSummary: string,
  detail: string[] = [],
): CheckResult {
  const bad = findings.filter((f) => f.status !== 'ok');
  if (!bad.length) return make(ctx, id, 'ok', okSummary, { detail });
  const worst = bad.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  const rest = bad.filter((f) => f !== worst).map((f) => f.summary);
  return make(ctx, id, worst.status, worst.summary, { detail: [...rest, ...detail], fix: worst.fix });
}

const memo = new WeakMap<CheckContext, Map<string, Promise<unknown>>>();
/** One lookup per doctor run, shared by the checks that need it. */
function once<T>(ctx: CheckContext, key: string, fn: () => Promise<T>): Promise<T> {
  let m = memo.get(ctx);
  if (!m) {
    m = new Map();
    memo.set(ctx, m);
  }
  if (!m.has(key)) m.set(key, fn());
  return m.get(key) as Promise<T>;
}

const realSys: SysLike = {
  platform: process.platform,
  isRoot: process.getuid?.() === 0,
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
  fileMode(path) {
    try {
      return statSync(path).mode;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
  fileUid(path) {
    try {
      return statSync(path).uid;
    } catch {
      return null;
    }
  },
  async icacls(path) {
    try {
      const p = Bun.spawn(['icacls', path], { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(p.stdout).text();
      return (await p.exited) === 0 ? out : null;
    } catch {
      return null;
    }
  },
  async readBytes(path, maxBytes) {
    try {
      const f = Bun.file(path);
      if (f.size > maxBytes) return null;
      return await f.bytes();
    } catch {
      return null;
    }
  },
  which: (name) => Bun.which(name),
  exists: (path) => existsSync(path),
  processInfo: defaultProcessInfo('win32'),
  async registryValue(key, name) {
    try {
      const p = Bun.spawn(['reg', 'query', `HKCU\\${key}`, '/v', name], { stdout: 'pipe', stderr: 'ignore' });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) return null;
      // "    Telinha    REG_SZ    "C:\...\telinha-tray.exe""
      const m = new RegExp('^\\s*' + name + '\\s+REG_SZ\\s+(.*?)\\s*$', 'im').exec(out);
      return m?.[1] || null;
    } catch {
      return null;
    }
  },
  async signature(path) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The path travels in the environment, never spliced into the script.
      const script =
        '$s = Get-AuthenticodeSignature -LiteralPath $env:TELINHA_SIG_PATH; ' +
        '$n = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo("SimpleName", $false) } else { $null }; ' +
        '@{ status = [string]$s.Status; signer = $n } | ConvertTo-Json -Compress';
      const p = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], {
        stdout: 'pipe',
        stderr: 'ignore',
        env: { ...process.env, TELINHA_SIG_PATH: path },
      });
      timer = setTimeout(() => p.kill(), SIGNATURE_TIMEOUT_MS);
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) return null;
      const j = JSON.parse(out) as { status?: unknown; signer?: unknown };
      return typeof j.status === 'string'
        ? { status: j.status, signer: typeof j.signer === 'string' && j.signer ? j.signer : null }
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
};

const sys = (ctx: CheckContext): SysLike => ({ ...realSys, ...ctx.sys });
const net = (ctx: CheckContext): NetLike => ctx.net ?? netinfo;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function publicIp(ctx: CheckContext): Promise<string | null> {
  return once(ctx, 'publicIp', () =>
    net(ctx)
      .lookupPublicIp(ctx.fetch)
      .catch(() => null),
  );
}

async function sdkListRooms(apiUrl: string, key: string, secret: string): Promise<{ rooms: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${CLOUD_TIMEOUT_MS / 1000} s`)), CLOUD_TIMEOUT_MS);
  });
  try {
    const rooms = await Promise.race([new RoomServiceClient(apiUrl, key, secret).listRooms(), timeout]);
    return { rooms: rooms.length };
  } finally {
    clearTimeout(timer);
  }
}

/** A rejected key or secret, as LiveKit's Twirp errors carry it (status or text). */
function authError(e: unknown): boolean {
  const status = e && typeof e === 'object' && 'status' in e ? e.status : undefined;
  return status === 401 || status === 403 || /\b(401|403)\b|unauthori[sz]ed|invalid/i.test(errMsg(e));
}

function natProbe(ctx: CheckContext): Promise<NatProbeLike | null> {
  return once(ctx, 'nat', async () => (ctx.nat ? ctx.nat.probe() : null));
}

function controlStatus(ctx: CheckContext) {
  return once(ctx, 'control', async () => {
    if (!ctx.control) return null;
    try {
      return (await ctx.control.available()) ? await ctx.control.status() : null;
    } catch {
      return null;
    }
  });
}

interface DiscordReply<T> {
  status: number;
  body: T | null;
}

function discordGet<T>(ctx: CheckContext, config: Config, path: string): Promise<DiscordReply<T>> {
  return once(ctx, `discord:${path}`, async () => {
    const res = await ctx.fetch(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bot ${config.discordToken}` },
      signal: AbortSignal.timeout(8000),
    });
    return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
  });
}

interface DiscordApp {
  id: string;
  name: string;
  flags?: number;
  redirect_uris?: string[];
}
interface DiscordGuild {
  id: string;
  name: string;
}
interface DiscordRole {
  id: string;
  name: string;
}
interface DiscordChannel {
  id: string;
  name: string;
  type: number;
}

/** Common gate for the Discord checks: a usable config with a real bot. */
function discordConfig(ctx: CheckContext, id: string): Config | CheckResult {
  if (!ctx.config) return make(ctx, id, 'skip', tr(ctx.locale, 'needConfig'));
  if (ctx.config.dev) return make(ctx, id, 'skip', tr(ctx.locale, 'devLogin'));
  return ctx.config;
}

/** The application, or the skip/fail result to return instead. */
async function discordApp(ctx: CheckContext, id: string): Promise<DiscordApp | CheckResult> {
  const c = discordConfig(ctx, id);
  if (!('discordToken' in c)) return c;
  let r: DiscordReply<DiscordApp>;
  try {
    r = await discordGet<DiscordApp>(ctx, c, '/applications/@me');
  } catch (e) {
    return make(
      ctx,
      id,
      id === 'discord-token' ? 'warn' : 'skip',
      tr(ctx.locale, 'discordUnreachable', { error: errMsg(e) }),
    );
  }
  if (r.status === 200 && r.body) return r.body;
  if (id !== 'discord-token') return make(ctx, id, 'skip', tr(ctx.locale, 'needToken'));
  if (r.status === 401)
    return make(ctx, id, 'fail', tr(ctx.locale, 'tokenBad'), { fix: tr(ctx.locale, 'tokenBadFix') });
  return make(ctx, id, 'warn', tr(ctx.locale, 'discordHttp', { status: r.status }));
}

const isResult = (x: object): x is CheckResult => 'status' in x && 'summary' in x;

export function inviteUrl(clientId: string, guildId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${BOT_PERMISSIONS}&guild_id=${guildId}&disable_guild_select=true`;
}

interface NeededPort {
  protocol: 'tcp' | 'udp';
  external: number;
  internal: number;
}

/** Inbound ports the router must forward for this config: the footprint's exposures, web ports first. */
export function neededPorts(c: Config): NeededPort[] {
  const { exposures } = footprintOf(c);
  return [...exposures.filter((e) => e.helper === 'caddy'), ...exposures.filter((e) => e.helper !== 'caddy')].map(
    (e) => ({ protocol: e.protocol, external: e.externalPort ?? e.port, internal: e.port }),
  );
}

const portLabel = (p: NeededPort) =>
  `${p.protocol.toUpperCase()} ${p.external}${p.internal !== p.external ? ` → ${p.internal}` : ''}`;
const portList = (ps: NeededPort[]) => ps.map(portLabel).join(', ');

/** The commands that open `ports` ("443/tcp") in ufw and firewalld, for the ones installed here. */
export function firewallCommands(
  ports: string[],
  which: (cmd: string) => string | null,
): { ufw?: string; firewalld?: string } {
  if (!ports.length) return {};
  const out: { ufw?: string; firewalld?: string } = {};
  if (which('ufw')) out.ufw = ports.map((p) => `sudo ufw allow ${p}`).join(' && ');
  if (which('firewall-cmd'))
    out.firewalld = `sudo firewall-cmd --permanent ${ports.map((p) => `--add-port=${p}`).join(' ')} && sudo firewall-cmd --reload`;
  return out;
}

/** Linux hosts with ufw or firewalld: the commands that open what this host listens on. */
function firewallHints(ctx: CheckContext, c: Config): string[] {
  const s = sys(ctx);
  if (s.platform !== 'linux') return [];
  const cmds = firewallCommands([...new Set(neededPorts(c).map((p) => `${p.internal}/${p.protocol}`))], (cmd) =>
    s.which(cmd),
  );
  const out: string[] = [];
  if (cmds.ufw) out.push(tr(ctx.locale, 'fwUfw', { cmd: cmds.ufw }));
  if (cmds.firewalld) out.push(tr(ctx.locale, 'fwFirewalld', { cmd: cmds.firewalld }));
  return out;
}

/** -1, 0, 1; null when either side is not a vX.Y.Z version. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]! ? 1 : -1;
  return 0;
}

/** Lines of `icacls` output that grant access to a broad group (English or Portuguese Windows). */
export function broadAclEntries(icaclsOutput: string): string[] {
  // Names are localized and the console code page may mangle accents, hence `Usu.{1,2}rios`.
  const BROAD = /(^|[\\\s])(Everyone|Todos|Users|Usu.{1,2}rios|Authenticated Users|Usu.{1,2}rios autenticados):\(/i;
  return icaclsOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => BROAD.test(l));
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function listenBase(c: Config): string {
  const h = c.host === '0.0.0.0' ? '127.0.0.1' : c.host === '::' ? '::1' : c.host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${c.port}`;
}

// ---------- checks ----------

const config: Check = {
  id: 'config',
  async run(ctx) {
    const L = ctx.locale;
    const s = sys(ctx);
    const findings: Finding[] = [];
    const detail: string[] = [];
    const text = s.readText(ctx.envFile);
    const parsed = text === null ? null : parseEnvFile(text);
    if (ctx.configError) {
      findings.push({
        status: 'fail',
        summary: tr(L, 'configError', { error: ctx.configError }),
        fix: tr(L, 'configErrorFix', { file: ctx.envFile }),
      });
    }
    for (const w of parsed?.warnings ?? []) findings.push({ status: 'warn', summary: w });
    for (const k of Object.keys(parsed?.vars ?? {})) {
      if (!KNOWN_KEYS.has(k)) findings.push({ status: 'warn', summary: tr(L, 'configUnknown', { key: k }) });
    }
    for (const w of ctx.config?.warnings ?? []) findings.push({ status: 'warn', summary: w });

    if (text === null) {
      detail.push(tr(L, 'permSkipped'));
    } else if (s.platform === 'win32') {
      const out = await s.icacls(ctx.envFile);
      if (out === null) detail.push(tr(L, 'permUnknown'));
      else {
        const broad = broadAclEntries(out);
        if (broad.length) {
          findings.push({
            status: 'fail',
            summary: tr(L, 'permOpen'),
            fix: tr(L, 'permOpenFixWindows', { file: ctx.envFile }),
          });
          detail.push(...broad);
        }
      }
    } else {
      const mode = s.fileMode(ctx.envFile);
      // The root install's file is root:telinha 0640: the service reads it through its group.
      const groupRead = mode !== null && s.fileUid?.(ctx.envFile) === 0 ? 0o040 : 0;
      if (mode === null) detail.push(tr(L, 'permUnknown'));
      else if (mode & 0o077 & ~groupRead) {
        findings.push({
          status: 'fail',
          summary: tr(L, 'permOpen'),
          fix: tr(L, 'permOpenFixLinux', { file: ctx.envFile }),
        });
        detail.push(`mode ${(mode & 0o777).toString(8).padStart(3, '0')}`);
      }
    }
    return combine(ctx, 'config', findings, tr(L, text === null ? 'configEnvOnly' : 'configOk'), detail);
  },
};

const PINNED: Record<string, { version: string }> = {
  livekit: versionsJson.livekit,
  caddy: versionsJson.caddy,
  cloudflared: versionsJson.cloudflared,
};

/** Far above any Caddy build (~50 MB); a bigger file is not read whole. */
const CADDY_MAX_BYTES = 256 * 1024 * 1024;
// A Go binary carries its module IDs and its build info as plain strings.
const DUCKDNS_MARKERS = ['dns.providers.duckdns', 'github.com/caddy-dns/duckdns'];

/**
 * Whether the caddy at `path` has the DuckDNS module, or null when it cannot
 * be read. Read, never run: doctor runs as root at the end of a system
 * setup, and bin/ belongs to the service user, so whoever controls that user
 * could otherwise put a program there for root to execute.
 */
async function hasDuckDnsModule(s: SysLike, path: string): Promise<boolean | null> {
  const bytes = s.readBytes ? await s.readBytes(path, CADDY_MAX_BYTES) : null;
  if (!bytes) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return DUCKDNS_MARKERS.some((m) => buf.includes(m));
}

const binaries: Check = {
  id: 'binaries',
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'binaries', 'skip', tr(L, 'needConfig'));
    const s = sys(ctx);
    const versions = ctx.versions ?? PINNED;
    const { helpers } = footprintOf(c);
    if (!helpers.length) return make(ctx, 'binaries', 'ok', tr(L, 'binNone'));
    const exe = s.platform === 'win32' ? '.exe' : '';
    const findings: Finding[] = [];
    const detail: string[] = [];
    for (const { name: tool, binary: member } of helpers) {
      // Our caddy ships with each Telinha release, so its sidecar holds that release's tag; from
      // source any release's caddy does.
      const want = tool === 'caddy' ? (ctx.compiled ? `v${ctx.version}` : null) : (versions[tool]?.version ?? '?');
      const local = join(ctx.paths.bin, member + exe);
      let found: string | null = null;
      if (s.exists(local)) {
        found = local;
        const have = s.readText(join(ctx.paths.bin, `${tool}.version`))?.trim();
        if (!have) findings.push({ status: 'warn', summary: tr(L, 'binNoSidecar', { tool, dir: ctx.paths.bin }) });
        else if (want !== null && have !== want)
          findings.push({ status: 'warn', summary: tr(L, 'binStale', { tool, have, want }) });
        else detail.push(tr(L, 'binLine', { tool, version: have, where: local }));
      } else {
        found = s.which(member);
        if (found) detail.push(tr(L, 'binPath', { tool, where: found }));
      }
      if (!found) {
        findings.push({
          status: 'fail',
          summary: tr(L, 'binMissing', { tool }),
          fix: tr(L, ctx.compiled ? 'binMissingFixCompiled' : 'binMissingFixDev'),
        });
        continue;
      }
      // An upstream caddy (a distro package, an old download) cannot do the DuckDNS challenge.
      if (tool === 'caddy' && c.acmeDns) {
        const has = await hasDuckDnsModule(s, found);
        if (has === null) detail.push(tr(L, 'binCaddyNoProbe', { where: found }));
        else if (!has) {
          // Ours in bin/ can go (the next setup or start downloads it again); a caddy on PATH
          // is only in use because Telinha's own download failed, and may belong to a package.
          const fix = !ctx.compiled
            ? 'binCaddyNoDnsFixDev'
            : found === local
              ? 'binCaddyNoDnsFixCompiled'
              : 'binCaddyNoDnsFixPath';
          findings.push({
            status: 'fail',
            summary: tr(L, 'binCaddyNoDns', { where: found }),
            fix: tr(L, fix, { where: found, bin: ctx.paths.bin }),
          });
        }
      }
    }
    return combine(ctx, 'binaries', findings, tr(L, 'binOk'), detail);
  },
};

const discordToken: Check = {
  id: 'discord-token',
  internet: true,
  async run(ctx) {
    const app = await discordApp(ctx, 'discord-token');
    if (isResult(app)) return app;
    const c = ctx.config!;
    if (c.clientId && app.id && c.clientId !== app.id) {
      return make(
        ctx,
        'discord-token',
        'fail',
        tr(ctx.locale, 'clientIdMismatch', { have: c.clientId, want: app.id }),
        {
          fix: tr(ctx.locale, 'clientIdMismatchFix', { want: app.id }),
        },
      );
    }
    return make(ctx, 'discord-token', 'ok', tr(ctx.locale, 'tokenOk', { name: app.name }));
  },
};

const discordIntents: Check = {
  id: 'discord-intents',
  internet: true,
  async run(ctx) {
    const app = await discordApp(ctx, 'discord-intents');
    if (isResult(app)) return app;
    const L = ctx.locale;
    const flags = app.flags ?? 0;
    const missing: string[] = [];
    if (!(flags & PRESENCE_BITS)) missing.push(tr(L, 'intentPresence'));
    if (!(flags & MEMBERS_BITS)) missing.push(tr(L, 'intentMembers'));
    if (!missing.length) return make(ctx, 'discord-intents', 'ok', tr(L, 'intentsOk'));
    return make(ctx, 'discord-intents', 'fail', tr(L, 'intentsMissing', { list: missing.join(', ') }), {
      fix: tr(L, 'intentsFix'),
    });
  },
};

/** The bot's guild entry, or the result to return instead. */
async function botGuild(ctx: CheckContext, id: string): Promise<DiscordGuild | CheckResult> {
  const c = discordConfig(ctx, id);
  if (!('discordToken' in c)) return c;
  const L = ctx.locale;
  let r: DiscordReply<DiscordGuild[]>;
  try {
    r = await discordGet<DiscordGuild[]>(ctx, c, '/users/@me/guilds');
  } catch (e) {
    return make(ctx, id, id === 'discord-guild' ? 'warn' : 'skip', tr(L, 'discordUnreachable', { error: errMsg(e) }));
  }
  if (r.status === 401) return make(ctx, id, 'skip', tr(L, 'needToken'));
  if (!r.body)
    return make(ctx, id, id === 'discord-guild' ? 'warn' : 'skip', tr(L, 'discordHttp', { status: r.status }));
  const g = r.body.find((x) => x.id === c.guildId);
  if (g) return g;
  if (id !== 'discord-guild') return make(ctx, id, 'skip', tr(L, 'needGuild'));
  const app = await discordApp(ctx, 'discord-guild');
  const clientId = isResult(app) ? c.clientId : app.id;
  return make(ctx, id, 'fail', tr(L, 'guildMissing', { id: c.guildId }), {
    fix: tr(L, 'guildMissingFix', { url: inviteUrl(clientId, c.guildId) }),
  });
}

const discordGuild: Check = {
  id: 'discord-guild',
  internet: true,
  async run(ctx) {
    const g = await botGuild(ctx, 'discord-guild');
    if (isResult(g)) return g;
    return make(ctx, 'discord-guild', 'ok', tr(ctx.locale, 'guildOk', { name: g.name }));
  },
};

const discordRole: Check = {
  id: 'discord-role',
  internet: true,
  async run(ctx) {
    const g = await botGuild(ctx, 'discord-role');
    if (isResult(g)) return g;
    const L = ctx.locale;
    const c = ctx.config!;
    const r = await discordGet<DiscordRole[]>(ctx, c, `/guilds/${c.guildId}/roles`);
    if (!r.body) return make(ctx, 'discord-role', 'warn', tr(L, 'discordHttp', { status: r.status }));
    const role = r.body.find((x) => x.id === c.roleId);
    if (role) return make(ctx, 'discord-role', 'ok', tr(L, 'roleOk', { name: role.name }));
    return make(ctx, 'discord-role', 'fail', tr(L, 'roleMissing', { id: c.roleId }), { fix: tr(L, 'roleFix') });
  },
};

const discordChannels: Check = {
  id: 'discord-channels',
  internet: true,
  async run(ctx) {
    const g = await botGuild(ctx, 'discord-channels');
    if (isResult(g)) return g;
    const L = ctx.locale;
    const c = ctx.config!;
    if (!c.channelIds.length) return make(ctx, 'discord-channels', 'ok', tr(L, 'channelsAll'));
    const r = await discordGet<DiscordChannel[]>(ctx, c, `/guilds/${c.guildId}/channels`);
    if (!r.body) return make(ctx, 'discord-channels', 'warn', tr(L, 'discordHttp', { status: r.status }));
    const findings: Finding[] = [];
    const names: string[] = [];
    for (const id of c.channelIds) {
      const ch = r.body.find((x) => x.id === id);
      // 0 = text, 5 = announcement: the only kinds a slash command is used in here.
      if (!ch) findings.push({ status: 'fail', summary: tr(L, 'channelMissing', { id }), fix: tr(L, 'channelsFix') });
      else if (ch.type !== 0 && ch.type !== 5)
        findings.push({
          status: 'fail',
          summary: tr(L, 'channelWrongType', { id, name: ch.name }),
          fix: tr(L, 'channelsFix'),
        });
      else names.push(`#${ch.name}`);
    }
    return combine(ctx, 'discord-channels', findings, tr(L, 'channelsOk', { list: names.join(', ') }));
  },
};

const discordRedirect: Check = {
  id: 'discord-redirect',
  internet: true,
  async run(ctx) {
    const app = await discordApp(ctx, 'discord-redirect');
    if (isResult(app)) return app;
    const L = ctx.locale;
    const uri = `${ctx.config!.publicUrl}/auth/callback`;
    const have = app.redirect_uris ?? [];
    if (have.includes(uri)) return make(ctx, 'discord-redirect', 'ok', tr(L, 'redirectOk', { uri }));
    return make(ctx, 'discord-redirect', 'fail', tr(L, 'redirectMissing', { uri }), {
      fix: tr(L, 'redirectFix', { uri }),
      detail: have.length ? [tr(L, 'redirectHave', { list: have.join(', ') })] : [],
    });
  },
};

const publicIpCheck: Check = {
  id: 'public-ip',
  internet: true,
  async run(ctx) {
    const ip = await publicIp(ctx);
    if (ip) return make(ctx, 'public-ip', 'ok', tr(ctx.locale, 'ipOk', { ip }));
    return make(ctx, 'public-ip', 'fail', tr(ctx.locale, 'ipFail'));
  },
};

/**
 * Whether DuckDNS takes the token for a DuckDNS name: rejected, a detail
 * line, or null when there is no DuckDNS token to ask about. A wrong or
 * revoked token is how a DuckDNS name breaks: DuckDNS answers KO to the
 * updater and to Caddy's DNS challenge alike, and the only other trace is the
 * redacted [caddy] lines in the log. The update carries the IP the record
 * already holds, so asking changes nothing.
 */
async function duckDnsToken(
  ctx: CheckContext,
  c: Config,
  host: string,
  current: string,
): Promise<{ rejected: true } | { line: string } | null> {
  const token = c.acmeDns?.token ?? (c.ddns?.provider === 'duckdns' ? c.ddns.token : undefined);
  if (!token || !host.endsWith('.duckdns.org')) return null;
  const domain = c.ddns?.domain ?? host.slice(0, -'.duckdns.org'.length);
  const ddns = createDuckDns({ domain, token, fetch: ctx.fetch, log: () => {} });
  await ddns.update(current);
  const last = ddns.last();
  if (last?.ok) return { line: tr(ctx.locale, 'dnsDuckTokenOk', { host }) };
  // The error never holds the token (ddns.ts scrubs it).
  if (last?.error === DUCKDNS_REJECTED) return { rejected: true };
  return { line: tr(ctx.locale, 'dnsDuckTokenUnknown', { error: last?.error ?? '?' }) };
}

const dnsCheck: Check = {
  id: 'dns',
  internet: true,
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'dns', 'skip', tr(L, 'needConfig'));
    const host = c.publicHost;
    if (LOCAL_HOSTS.has(host)) return make(ctx, 'dns', 'skip', tr(L, 'dnsLocal'));
    if (/^[\d.]+$/.test(host) || host.startsWith('[')) return make(ctx, 'dns', 'skip', tr(L, 'dnsIp'));
    const expected = c.livekitNodeIp ?? (await publicIp(ctx));
    let ips: string[];
    try {
      ips = await net(ctx).resolveA(host);
      if (!ips.length) throw new Error('no A record');
    } catch (e) {
      return make(ctx, 'dns', 'fail', tr(L, 'dnsFail', { host, error: errMsg(e) }), {
        fix: c.ingress === 'tunnel' ? tr(L, 'rerunSetup') : tr(L, 'dnsFailFix', { host, ip: expected ?? '?' }),
      });
    }
    const list = ips.join(', ');
    // Cloudflare answers with its own anycast addresses for a tunnel.
    if (c.ingress === 'tunnel') return make(ctx, 'dns', 'ok', tr(L, 'dnsTunnelOk', { host, ips: list }));
    const duck = await duckDnsToken(ctx, c, host, ips[0]!);
    if (duck && 'rejected' in duck)
      return make(ctx, 'dns', 'fail', tr(L, 'dnsDuckToken', { host }), { fix: tr(L, 'dnsDuckTokenFix', { host }) });
    const detail = duck ? [duck.line] : [];
    if (!expected) return make(ctx, 'dns', 'warn', tr(L, 'dnsUnknownIp', { host, ips: list }), { detail });
    if (ips.includes(expected)) return make(ctx, 'dns', 'ok', tr(L, 'dnsOk', { host, ip: expected }), { detail });
    if (c.ddns?.provider === 'duckdns' && host.endsWith('.duckdns.org')) {
      return make(ctx, 'dns', 'warn', tr(L, 'dnsDuck', { host, ips: list, ip: expected }), { detail });
    }
    if (c.ingress === 'external')
      return make(ctx, 'dns', 'warn', tr(L, 'dnsExternal', { host, ips: list, ip: expected }), { detail });
    return make(ctx, 'dns', 'fail', tr(L, 'dnsWrong', { host, ips: list, ip: expected }), {
      fix: tr(L, 'dnsWrongFix', { host, ip: expected }),
      detail,
    });
  },
};

/** How the certificate is obtained; informational, the tls check says whether it worked. */
const certificate: Check = {
  id: 'certificate',
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'certificate', 'skip', tr(L, 'needConfig'));
    const url = new URL(c.publicUrl);
    if (url.protocol !== 'https:') return make(ctx, 'certificate', 'skip', tr(L, 'tlsHttp'));
    const host = c.publicHost;
    if (c.ingress === 'tunnel') return make(ctx, 'certificate', 'ok', tr(L, 'certTunnel', { host }));
    if (c.ingress === 'external') return make(ctx, 'certificate', 'ok', tr(L, 'certExternal', { host }));
    if (c.acmeDns) return make(ctx, 'certificate', 'ok', tr(L, 'certDns', { host, port: Number(url.port || 443) }));
    const summary = tr(L, c.httpPort ? 'certHttp' : 'certAlpn', { host });
    // Chosen on purpose in setup's advanced path: a note, not a finding, so every doctor run stays clean.
    const detail = c.hosting === 'home' ? [tr(L, 'certHomeAdvanced')] : [];
    return make(ctx, 'certificate', 'ok', summary, { detail });
  },
};

const tlsCheck: Check = {
  id: 'tls',
  internet: true,
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'tls', 'skip', tr(L, 'needConfig'));
    const url = new URL(c.publicUrl);
    if (url.protocol !== 'https:') return make(ctx, 'tls', 'skip', tr(L, 'tlsHttp'));
    const host = url.hostname;
    const info = await net(ctx).tlsInfo(host, Number(url.port || 443));
    if (!info.authorized) {
      return make(ctx, 'tls', 'fail', tr(L, 'tlsBad', { host, error: info.error ?? '?' }), {
        fix:
          c.ingress !== 'direct'
            ? tr(L, 'tlsBadFix')
            : c.acmeDns
              ? tr(L, 'tlsBadFixDns', { port: c.httpsPort })
              : tr(L, 'tlsBadFixDirect'),
      });
    }
    const days = Math.floor((info.validTo - Date.now()) / DAY_MS);
    if (days < 0) return make(ctx, 'tls', 'fail', tr(L, 'tlsExpired', { host }), { fix: tr(L, 'tlsSoonFix') });
    let health: string | null = null;
    try {
      const res = await ctx.fetch(`${c.publicUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      if (!res.ok || body?.ok !== true) health = `HTTP ${res.status}`;
    } catch (e) {
      health = errMsg(e);
    }
    const detail = [info.subjectAltNames.join(', ')].filter(Boolean);
    if (health) {
      return make(ctx, 'tls', 'fail', tr(L, 'healthFail', { url: c.publicUrl, error: health }), {
        fix: tr(L, 'healthFailFix'),
        detail,
      });
    }
    if (days < 14)
      return make(ctx, 'tls', 'warn', tr(L, 'tlsSoon', { host, days }), { fix: tr(L, 'tlsSoonFix'), detail });
    return make(ctx, 'tls', 'ok', tr(L, 'tlsOk', { issuer: info.issuer || '?', days, url: c.publicUrl }), { detail });
  },
};

const livekitCloud: Check = {
  id: 'livekit-cloud',
  internet: true,
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'livekit-cloud', 'skip', tr(L, 'needConfig'));
    if (c.media !== 'cloud') return make(ctx, 'livekit-cloud', 'skip', tr(L, 'cloudSkipSelf'));
    const host = c.livekitCloudHost ?? c.livekitApiUrl;
    // Cloud's own settings Telinha cannot read: said on every run, ok or not.
    const detail = [tr(L, 'cloudAutoCreate'), tr(L, 'cloudLimits')];
    const list = net(ctx).livekitListRooms ?? sdkListRooms;
    try {
      const { rooms } = await list(c.livekitApiUrl, c.livekitKey, c.livekitSecret);
      return make(ctx, 'livekit-cloud', 'ok', tr(L, 'cloudOk', { host, n: rooms }), { detail });
    } catch (e) {
      if (authError(e))
        return make(ctx, 'livekit-cloud', 'fail', tr(L, 'cloudAuth', { host }), { fix: tr(L, 'cloudAuthFix'), detail });
      // The SDK's messages carry the URL at most; the credentials are scrubbed anyway.
      let error = errMsg(e);
      for (const v of [c.livekitSecret, c.livekitKey]) if (v) error = error.replaceAll(v, '***');
      return make(ctx, 'livekit-cloud', 'fail', tr(L, 'cloudUnreachable', { host, error }), {
        fix: tr(L, 'cloudUnreachableFix'),
        detail,
      });
    }
  },
};

const turnCheck: Check = {
  id: 'turn',
  internet: true,
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'turn', 'skip', tr(L, 'needConfig'));
    if (c.turnSetting === 'off') return make(ctx, 'turn', 'skip', tr(L, 'turnOff'));
    const why = turnIneligibility(c);
    if (why) return make(ctx, 'turn', 'skip', tr(L, 'turnNotHere', { why }));
    const host = c.publicHost;
    const expected = c.livekitNodeIp ?? (await publicIp(ctx));
    // Eligible but left off by auto (own domain, or HOSTING unset): a pointer, not a warning,
    // so such a VPS stays clean without TURN.
    if (!c.turn) return make(ctx, 'turn', 'skip', tr(L, 'turnAvailable', { host, ip: expected ?? '?' }));

    let ips: string[];
    try {
      ips = await net(ctx).resolveA(c.turn.host);
      if (!ips.length) throw new Error('no A record');
    } catch (e) {
      return make(ctx, 'turn', 'fail', tr(L, 'turnDnsFail', { host, error: errMsg(e) }), {
        fix: tr(L, 'turnDnsFix', { host, ip: expected ?? '?' }),
      });
    }
    const list = ips.join(', ');
    const findings: Finding[] = [];
    if (!expected) findings.push({ status: 'warn', summary: tr(L, 'turnDnsUnknownIp', { host, ips: list }) });
    else if (!ips.includes(expected)) {
      return make(ctx, 'turn', 'fail', tr(L, 'turnDnsWrong', { host, ips: list, ip: expected }), {
        fix: tr(L, 'turnDnsFix', { host, ip: expected }),
      });
    }

    const info = await net(ctx).tlsInfo(c.turn.host, 443);
    const detail = [info.subjectAltNames.join(', ')].filter(Boolean);
    if (!info.authorized) {
      findings.push({
        status: 'fail',
        summary: tr(L, 'turnTlsBad', { host, error: info.error ?? '?' }),
        fix: tr(L, 'turnTlsFix'),
      });
    }
    // Connect-and-close reachability only: LiveKit wants a PROXY header first, so it accepts and drops this.
    if (!(await net(ctx).tcpOpen('127.0.0.1', c.turn.port, 2000))) {
      findings.push({
        status: 'warn',
        summary: tr(L, 'turnLocalDown', { port: c.turn.port }),
        fix: tr(L, 'listenDownFix'),
      });
    }
    return combine(ctx, 'turn', findings, tr(L, 'turnOk', { host, port: c.turn.port }), detail);
  },
};

const listeners: Check = {
  id: 'listeners',
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'listeners', 'skip', tr(L, 'needConfig'));
    const s = sys(ctx);
    const base = listenBase(c);
    type Health = { rooms?: number; children?: Record<string, string> };
    let health: Health | null = null;
    try {
      const res = await ctx.fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) health = (await res.json()) as Health;
    } catch {
      // reported below
    }
    const fw = firewallHints(ctx, c);
    if (!health)
      return make(ctx, 'listeners', 'warn', tr(L, 'listenDown', { url: base }), {
        fix: tr(L, 'listenDownFix'),
        detail: fw,
      });

    const findings: Finding[] = [];
    const children = Object.entries(health.children ?? {});
    const detail = [
      tr(L, 'listenRooms', { n: health.rooms ?? 0 }),
      ...children.map(([name, state]) => tr(L, 'listenChild', { name, state })),
    ];
    const down = children.filter(([, state]) => state !== 'up').map(([name]) => name);
    if (down.length)
      findings.push({
        status: 'warn',
        summary: tr(L, 'childDown', { list: down.join(', ') }),
        fix: tr(L, 'listenDownFix'),
      });
    // The ports run binds, helper by helper; UDP and the HTTP redirect go unprobed.
    for (const { key, port } of footprintOf(c).helpers.flatMap((h) => h.ports)) {
      if (key === 'LIVEKIT_PORT') {
        let lk = false;
        try {
          lk = (await ctx.fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })).status === 200;
        } catch {
          // stays false
        }
        if (!lk) findings.push({ status: 'warn', summary: tr(L, 'livekitDown', { port }) });
      } else if (key === 'MEDIA_TCP_PORT') {
        if (!(await net(ctx).tcpOpen('127.0.0.1', port, 2000)))
          findings.push({ status: 'warn', summary: tr(L, 'mediaTcpDown', { port }) });
      } else if (key === 'TURN_PORT') {
        // Reachability only (no PROXY header, so LiveKit drops it): shown here so --local sees it too.
        const up = await net(ctx).tcpOpen('127.0.0.1', port, 2000);
        detail.push(tr(L, up ? 'listenTurnUp' : 'listenTurnDown', { port }));
        if (!up)
          findings.push({ status: 'warn', summary: tr(L, 'turnLocalDown', { port }), fix: tr(L, 'listenDownFix') });
      } else if (key === 'HTTPS_PORT' && !(await net(ctx).tcpOpen('127.0.0.1', port, 2000))) {
        const lowPorts = c.httpsPort < 1024 || (c.httpPort > 0 && c.httpPort < 1024);
        const hint = s.platform === 'linux' && !s.isRoot && lowPorts;
        findings.push({
          status: 'warn',
          summary: tr(L, 'httpsDown', { port }),
          fix: hint ? tr(L, 'lowPortFix', { cmd: `sudo sh -c '${SYSCTL_SCRIPT}'` }) : undefined,
        });
      }
    }
    return combine(ctx, 'listeners', findings, tr(L, 'listenOk', { url: base }), [...detail, ...fw]);
  },
};

const service: Check = {
  id: 'service',
  async run(ctx) {
    const L = ctx.locale;
    if (!ctx.service) return make(ctx, 'service', 'skip', tr(L, 'serviceNone'));
    const st = await ctx.service();
    const detail = st.detail ? [st.detail] : [];
    // Windows: an unelevated `service install` is refused, and an elevated one by
    // hand misses --firewall and the account (--user/--sid); setup does it right.
    const s = sys(ctx);
    const flavour = s.platform === 'win32' ? 'Win' : s.platform === 'linux' && s.isRoot ? 'Root' : '';
    if (!st.installed)
      return make(ctx, 'service', 'warn', tr(L, 'serviceNotInstalled'), {
        fix: tr(L, `serviceNotInstalledFix${flavour}`),
        detail,
      });
    if (!st.running)
      return make(ctx, 'service', 'warn', tr(L, 'serviceStopped'), { fix: tr(L, 'serviceStoppedFix'), detail });
    if (!st.enabled)
      return make(ctx, 'service', 'warn', tr(L, 'serviceDisabled'), {
        fix: tr(L, `serviceDisabledFix${flavour}`),
        detail,
      });
    return make(ctx, 'service', 'ok', tr(L, 'serviceOk'), { detail });
  },
};

const tray: Check = {
  id: 'tray',
  async run(ctx) {
    const L = ctx.locale;
    const s = sys(ctx);
    if (s.platform !== 'win32' || !ctx.compiled) return make(ctx, 'tray', 'skip', tr(L, 'traySkip'));
    const exe = win32.join(ctx.paths.bin, TRAY_EXE);
    const runValue = await once(ctx, 'trayRun', async () => (await s.registryValue?.(RUN_KEY, 'Telinha')) ?? null);
    if (!s.exists(exe)) {
      // A Run entry left behind starts nothing and shows an error at every login.
      if (runValue) return make(ctx, 'tray', 'warn', tr(L, 'trayStaleRun'), { fix: tr(L, 'trayStaleRunFix') });
      return make(ctx, 'tray', 'ok', tr(L, 'trayNotInstalled'), { detail: [tr(L, 'trayNotInstalledDetail')] });
    }
    const autostart = runValue?.trim().toLowerCase() === `"${exe}"`.toLowerCase();
    const detail = [tr(L, autostart ? 'trayAutostartYes' : 'trayAutostartNo')];
    // Never a warning: unsigned builds are legitimate.
    const sig = await once(ctx, 'traySignature', async () => (await s.signature?.(exe)) ?? null);
    if (sig)
      detail.push(
        sig.status === 'Valid' && sig.signer ? tr(L, 'traySigned', { signer: sig.signer }) : tr(L, 'trayUnsigned'),
      );
    const st = ctx.trayState;
    const info = st ? s.processInfo?.(st.pid) : undefined;
    if (!st || !info?.alive || !sameExe(TRAY_EXE, info.exe, 'win32')) {
      return make(ctx, 'tray', 'ok', tr(L, 'trayStopped'), { detail: [...detail, tr(L, 'trayStoppedDetail')] });
    }
    if (compareSemver(st.version, ctx.version) !== 0) {
      return make(ctx, 'tray', 'warn', tr(L, 'trayMismatch', { have: st.version, want: ctx.version }), {
        detail,
        fix: tr(L, 'trayMismatchFix'),
      });
    }
    return make(ctx, 'tray', 'ok', tr(L, 'trayOk', { version: st.version }), { detail });
  },
};

const KIND: Record<string, string> = { igd: 'UPnP', pcp: 'PCP', natpmp: 'NAT-PMP' };

/** A host whose own address is public (a VPS) has no router to ask. */
const publicHost = (p: NatProbeLike) =>
  !p.gateway &&
  p.localIp &&
  !netinfo.isPrivateIpv4(p.localIp) &&
  !netinfo.isCgnatIpv4(p.localIp) &&
  !p.localIp.startsWith('127.') &&
  !p.localIp.startsWith('169.254.');

const gateway: Check = {
  id: 'gateway',
  async run(ctx) {
    const L = ctx.locale;
    const p = await natProbe(ctx);
    if (!p) return make(ctx, 'gateway', 'skip', tr(L, 'natNone'));
    if (publicHost(p)) return make(ctx, 'gateway', 'ok', tr(L, 'natPublicHost', { ip: p.localIp! }));
    const g = p.gateway;
    if (!g) {
      const list = ctx.config ? portList(neededPorts(ctx.config)) : '';
      return make(ctx, 'gateway', 'warn', tr(L, 'gatewayNone'), {
        fix: list ? tr(L, 'gatewayNoneFix', { list }) : undefined,
        detail: p.errors,
      });
    }
    const kind = KIND[g.kind] ?? g.kind;
    if (!p.externalIp) return make(ctx, 'gateway', 'ok', tr(L, 'gatewayNoIp', { gw: g.gatewayIp, kind }));
    return make(ctx, 'gateway', 'ok', tr(L, 'gatewayOk', { gw: g.gatewayIp, kind, ip: p.externalIp }));
  },
};

const cgnat: Check = {
  id: 'cgnat',
  async run(ctx) {
    const L = ctx.locale;
    const p = await natProbe(ctx);
    if (!p) return make(ctx, 'cgnat', 'skip', tr(L, 'natNone'));
    if (publicHost(p)) return make(ctx, 'cgnat', 'ok', tr(L, 'natPublicHost', { ip: p.localIp! }));
    const ext = p.externalIp;
    if (!p.gateway || !ext) return make(ctx, 'cgnat', 'skip', tr(L, 'cgnatSkip'));
    const list = ctx.config ? portList(neededPorts(ctx.config)) : '';
    if (netinfo.isCgnatIpv4(ext)) {
      // With Cloud carrying the media, only the pages still need a way in.
      if (ctx.config?.media === 'cloud') return make(ctx, 'cgnat', 'warn', tr(L, 'cgnatCloud', { ip: ext }));
      return make(ctx, 'cgnat', 'fail', tr(L, 'cgnatFail', { ip: ext }), { fix: tr(L, 'cgnatFailFix') });
    }
    if (netinfo.isPrivateIpv4(ext))
      return make(ctx, 'cgnat', 'warn', tr(L, 'doubleNat', { ip: ext }), { fix: tr(L, 'doubleNatFix', { list }) });
    const ip = ctx.local ? null : await publicIp(ctx);
    if (ip && ip !== ext)
      return make(ctx, 'cgnat', 'warn', tr(L, 'natMismatch', { ext, ip }), { fix: tr(L, 'doubleNatFix', { list }) });
    return make(ctx, 'cgnat', 'ok', tr(L, 'cgnatOk', { ip: ext }));
  },
};

/** upnp.json as the port mapper leaves it; read loosely, the doctor only needs the mappings. */
function readMapperFile(ctx: CheckContext): MapperStatusLike | null {
  try {
    const text = sys(ctx).readText(join(ctx.paths.run, 'upnp.json'));
    if (!text) return null;
    const raw = JSON.parse(text) as { mappings?: Partial<MappingLike>[] };
    if (!Array.isArray(raw.mappings)) return null;
    return {
      enabled: true,
      mappings: raw.mappings.map((m) => ({
        protocol: String(m.protocol),
        externalPort: Number(m.externalPort),
        internalPort: Number(m.internalPort ?? m.externalPort),
        // The file lists active mappings; one without a state is mapped.
        state: m.state ?? 'mapped',
      })),
    };
  } catch {
    return null;
  }
}

const mappings: Check = {
  id: 'mappings',
  async run(ctx) {
    const L = ctx.locale;
    const c = ctx.config;
    if (!c) return make(ctx, 'mappings', 'skip', tr(L, 'needConfig'));
    const needed = neededPorts(c);
    // The mapper never asks for 80/443: judge it on what it owns, and name the rest as by hand.
    const owned: NeededPort[] = upnpMappings(c).map((m) => ({
      protocol: m.protocol,
      external: m.externalPort,
      internal: m.internalPort,
    }));
    if (!owned.length) {
      return make(
        ctx,
        'mappings',
        'skip',
        needed.length ? tr(L, 'mapSkipNoneAsked', { list: portList(needed) }) : tr(L, 'mapSkipNoPorts'),
      );
    }
    const byHand = needed.filter((n) => !owned.some((o) => o.protocol === n.protocol && o.external === n.external));
    const byHandLine = byHand.length ? [tr(L, 'mapByHand', { list: portList(byHand) })] : [];
    const p = await natProbe(ctx);
    if (!p || publicHost(p) || !p.gateway) return make(ctx, 'mappings', 'skip', tr(L, 'mapSkipNoGw'));
    if (!c.upnp) return make(ctx, 'mappings', 'skip', tr(L, 'mapSkipOff', { list: portList(needed) }));
    const st = (await controlStatus(ctx))?.upnp ?? readMapperFile(ctx);
    if (!st) return make(ctx, 'mappings', 'skip', tr(L, 'mapSkipNoStatus'));
    const missing = owned.filter(
      (n) =>
        !st.mappings.some(
          (m) => m.protocol.toLowerCase() === n.protocol && m.externalPort === n.external && m.state === 'mapped',
        ),
    );
    if (!missing.length)
      return make(ctx, 'mappings', 'ok', tr(L, 'mapOk', { list: portList(owned) }), { detail: byHandLine });
    const errors = st.mappings
      .filter((m) => m.error)
      .map((m) => `${m.protocol.toUpperCase()} ${m.externalPort}: ${m.error}`);
    return make(ctx, 'mappings', 'warn', tr(L, 'mapPartial', { list: portList(missing) }), {
      fix: tr(L, 'mapPartialFix', { ip: p.localIp ?? '?', list: portList(missing) }),
      detail: [...errors, ...byHandLine],
    });
  },
};

const update: Check = {
  id: 'update',
  async run(ctx) {
    const L = ctx.locale;
    if (!ctx.compiled) return make(ctx, 'update', 'skip', tr(L, 'updSkip'));
    // The running service knows best; without it, update.json and a release lookup.
    const live: UpdateStatusLike | null = (await controlStatus(ctx))?.update ?? null;
    const st = live ?? ctx.updateState ?? {};
    let latest = live?.latest ?? null;
    if (!latest && !ctx.local && ctx.latestTag) latest = await ctx.latestTag().catch(() => null);
    const v = ctx.version;
    const findings: Finding[] = [];
    if (st.failed)
      findings.push({
        status: 'warn',
        summary: tr(L, 'updFailed', { tag: st.failed.tag, reason: st.failed.reason ?? '?' }),
        fix: tr(L, 'updFailedFix'),
      });
    if (st.staged) findings.push({ status: 'warn', summary: tr(L, 'updStaged', { tag: st.staged.tag }) });
    if (st.pending) findings.push({ status: 'warn', summary: tr(L, 'updPending', { tag: st.pending.tag }) });
    const newer = latest ? compareVersions(latest, v) === 1 : false;
    // A failed, staged or pending tag already says what the newest one is.
    const known = [st.failed?.tag, st.staged?.tag, st.pending?.tag];
    if (latest && newer && !known.includes(latest)) {
      findings.push({
        status: 'warn',
        summary: tr(L, 'updAvailable', { latest, version: v }),
        fix: tr(L, 'updAvailableFix'),
      });
    }
    return combine(ctx, 'update', findings, tr(L, latest ? 'updOk' : 'updUnknown', { version: v }));
  },
};

/** Every check, in the order they are shown. */
export const CHECKS: readonly Check[] = [
  config,
  binaries,
  discordToken,
  discordIntents,
  discordGuild,
  discordRole,
  discordChannels,
  discordRedirect,
  publicIpCheck,
  dnsCheck,
  certificate,
  tlsCheck,
  livekitCloud,
  turnCheck,
  listeners,
  service,
  tray,
  gateway,
  cgnat,
  mappings,
  update,
];

/**
 * Runs checks one after another, each capped at timeoutMs so a hung network
 * call cannot hang the doctor. A check that throws becomes a 'fail'.
 */
export async function runChecks(
  checks: readonly Check[],
  ctx: CheckContext,
  onResult?: (r: CheckResult) => void,
  o: { timeoutMs?: number } = {},
): Promise<CheckResult[]> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const out: CheckResult[] = [];
  for (const check of checks) {
    let r: CheckResult;
    if (ctx.local && check.internet) {
      r = make(ctx, check.id, 'skip', tr(ctx.locale, 'skipLocal'));
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<CheckResult>((resolve) => {
        timer = setTimeout(
          () => resolve(make(ctx, check.id, 'fail', tr(ctx.locale, 'timedOut', { s: Math.round(timeoutMs / 1000) }))),
          timeoutMs,
        );
      });
      try {
        r = await Promise.race([check.run(ctx), timeout]);
      } catch (e) {
        r = make(ctx, check.id, 'fail', tr(ctx.locale, 'crashed', { error: errMsg(e) }));
      } finally {
        clearTimeout(timer);
      }
    }
    onResult?.(r);
    out.push(r);
  }
  return out;
}
