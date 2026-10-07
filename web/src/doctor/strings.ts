// The phone test page's own small dictionary (the room page's is far bigger and
// Svelte-bound). Picked from the browser language: pt* -> pt-BR, else en.
export type Locale = 'en' | 'pt-BR';
type Params = Record<string, string | number>;

const en = {
  title: 'Telinha connection test',
  intro: 'This checks whether people outside your network can reach Telinha. Keep this page open until it finishes.',
  mobileTip: 'Use mobile data (Wi-Fi off) so the test comes from outside your network.',
  stepHttps: 'HTTPS',
  stepSignaling: 'LiveKit connection',
  stepPublish: 'Sending video',
  stepInitial: 'First path',
  stepUdp: 'UDP {port}',
  stepTcp: 'TCP {port}',
  // LiveKit Cloud: the ports are Cloud's, not something to forward.
  stepUdpCloud: 'UDP',
  stepTcpCloud: 'TCP',
  stepTurn: 'TURN over TLS on 443',
  stepReport: 'Sending the result',
  waiting: 'waiting',
  running: 'testing...',
  ok: 'works',
  okMs: 'works, {ms} ms',
  failed: 'failed',
  notHttps: 'the page was not opened over HTTPS',
  path: '{protocol} to {ip}, {ms} ms',
  relayed: 'through a relay',
  skipped: 'skipped',
  done: 'Done, you can close this page. The result is also in the terminal.',
  doneNoReport: 'Done, but the result could not be sent to the terminal ({error}).',
  used: 'This test already ran. Run telinha doctor again for a new link.',
  hintHttp: 'Telinha did not answer over HTTPS.',
  hintSignaling: 'Telinha is not reachable at its public address for video: check PUBLIC_URL, the DNS and the router.',
  hintBoth:
    'The HTTP side works, but the media ports are closed: forward TCP {tcp} and UDP {udp} to the Telinha machine.',
  hintUdp:
    'UDP {udp} is not reachable from the internet: forward it to the Telinha machine. Video still works over TCP, with more delay.',
  hintTcp:
    'TCP {tcp} is not reachable from the internet: forward it to the Telinha machine (needed where UDP is blocked).',
  hintAllGood: 'Everything works: people outside your network can watch and stream.',
  hintCloudSignaling:
    'The phone loaded Telinha but could not connect to LiveKit Cloud: see the livekit-cloud check in telinha doctor (LIVEKIT_CLOUD_URL, API key and secret) or try another network.',
  hintCloudBoth:
    'The phone reached Telinha but not LiveKit Cloud over WebRTC (UDP and TCP): that network blocks WebRTC. Nothing to open on your side; try another network.',
  hintCloudUdp:
    'UDP to LiveKit Cloud did not work from the phone; video falls back to TCP with more delay. Nothing to open on your side.',
  hintCloudTcp:
    'TCP to LiveKit Cloud did not work from the phone; video still works over UDP. Nothing to open on your side.',
  hintTurn:
    'TURN over TLS on port 443 did not work from the phone: see the turn check in telinha doctor (DNS record and certificate for {turnHost}).',
} as const;

export type Key = keyof typeof en;

const ptBR: Record<Key, string> = {
  title: 'Teste de conexão da Telinha',
  intro:
    'Isto verifica se quem está fora da sua rede consegue chegar na Telinha. Deixe esta página aberta até terminar.',
  mobileTip: 'Use os dados móveis (Wi-Fi desligado) pra que o teste venha de fora da sua rede.',
  stepHttps: 'HTTPS',
  stepSignaling: 'Conexão com o LiveKit',
  stepPublish: 'Envio de vídeo',
  stepInitial: 'Primeiro caminho',
  stepUdp: 'UDP {port}',
  stepTcp: 'TCP {port}',
  stepUdpCloud: 'UDP',
  stepTcpCloud: 'TCP',
  stepTurn: 'TURN sobre TLS na 443',
  stepReport: 'Enviando o resultado',
  waiting: 'esperando',
  running: 'testando...',
  ok: 'funciona',
  okMs: 'funciona, {ms} ms',
  failed: 'falhou',
  notHttps: 'a página não foi aberta por HTTPS',
  path: '{protocol} até {ip}, {ms} ms',
  relayed: 'por um relay',
  skipped: 'pulado',
  done: 'Pronto, pode fechar esta página. O resultado também aparece no terminal.',
  doneNoReport: 'Pronto, mas o resultado não chegou ao terminal ({error}).',
  used: 'Este teste já rodou. Rode telinha doctor de novo pra ter um link novo.',
  hintHttp: 'A Telinha não respondeu por HTTPS.',
  hintSignaling: 'A Telinha não é acessível pelo endereço público pro vídeo: confira o PUBLIC_URL, o DNS e o roteador.',
  hintBoth:
    'O lado HTTP funciona, mas as portas de mídia estão fechadas: encaminhe TCP {tcp} e UDP {udp} pra máquina da Telinha.',
  hintUdp:
    'A porta UDP {udp} não é acessível pela internet: encaminhe pra máquina da Telinha. O vídeo ainda funciona por TCP, com mais atraso.',
  hintTcp:
    'A porta TCP {tcp} não é acessível pela internet: encaminhe pra máquina da Telinha (necessária onde o UDP é bloqueado).',
  hintAllGood: 'Tudo funciona: quem está fora da sua rede consegue assistir e transmitir.',
  hintCloudSignaling:
    'O celular abriu a Telinha mas não conseguiu conectar no LiveKit Cloud: veja a verificação livekit-cloud no telinha doctor (LIVEKIT_CLOUD_URL, chave e segredo da API) ou tente outra rede.',
  hintCloudBoth:
    'O celular chegou na Telinha mas não no LiveKit Cloud por WebRTC (UDP e TCP): essa rede bloqueia WebRTC. Não há nada pra abrir do seu lado; tente outra rede.',
  hintCloudUdp:
    'O UDP até o LiveKit Cloud não funcionou no celular; o vídeo cai pro TCP, com mais atraso. Não há nada pra abrir do seu lado.',
  hintCloudTcp:
    'O TCP até o LiveKit Cloud não funcionou no celular; o vídeo ainda funciona por UDP. Não há nada pra abrir do seu lado.',
  hintTurn:
    'O TURN sobre TLS na porta 443 não funcionou no celular: veja a verificação turn no telinha doctor (registro DNS e certificado de {turnHost}).',
};

const dicts: Record<Locale, Record<Key, string>> = { en, 'pt-BR': ptBR };

export const pickLocale = (tag: string | null | undefined): Locale =>
  tag && tag.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';

export function tr(locale: Locale, key: Key, params: Params = {}): string {
  return (dicts[locale][key] ?? en[key]).replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
