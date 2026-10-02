// Telinha room page: Discord-style screen sharing on LiveKit.
// Login is already done (Caddy only lets Medonhes reach /sala/); /auth/token
// hands out a LiveKit token that may only publish screen share + its audio.
import { Room, RoomEvent, Track, VideoPreset, VideoQuality, AudioPresets } from './livekit-client.esm.mjs';

const $ = (id) => document.getElementById(id);

// Top-layer bitrate (kbps) per resolution x fps. The SFU sends viewers lower
// simulcast layers when their tile is small or their connection is weak.
const KBPS = {
  720: { 15: 2500, 30: 4000, 60: 6000 },
  1080: { 15: 4000, 30: 7000, 60: 12000 },
  1440: { 15: 6000, 30: 10000, 60: 16000 },
};
const QUALITY = { auto: VideoQuality.HIGH, alta: VideoQuality.HIGH, media: VideoQuality.MEDIUM, baixa: VideoQuality.LOW };

const store = {
  get(k, d) { try { const v = localStorage.getItem(`telinha.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`telinha.${k}`, JSON.stringify(v)); } catch {} },
};

let room;
let focusId = null;
let statsOn = store.get('stats', false);
let share = null; // { video, audio, stream }
const tiles = new Map(); // identity -> { el, video, audioEl, stats }
const prevBytes = new Map();

// ---------- helpers ----------
function avatarUrl(p) {
  let meta = {};
  try { meta = JSON.parse(p.metadata || '{}') || {}; } catch {}
  const id = meta.id || p.identity.split(':')[0]; // identity is "<discord id>:<tab>"
  if (meta.avatar) return `https://cdn.discordapp.com/avatars/${id}/${meta.avatar}.png?size=64`;
  let n = 0;
  try { n = Number((BigInt(id) >> 22n) % 6n); } catch {}
  return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}
function avatar(p, cls = 'avatar') {
  const img = document.createElement('img');
  img.className = cls;
  img.alt = '';
  img.src = avatarUrl(p);
  img.title = p.name || p.identity;
  return img;
}
const nameOf = (p) => p.name || p.identity;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
let toastTimer;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function fatal(msg, reload = false) {
  const f = $('fatal');
  f.replaceChildren(el('div', '', msg));
  if (reload) {
    const b = el('button', 'primary', 'Recarregar');
    b.style.marginTop = '12px';
    b.onclick = () => location.reload();
    f.firstChild.append(el('br'), b);
  }
  f.classList.remove('hidden');
}
const allParticipants = () => (room ? [room.localParticipant, ...room.remoteParticipants.values()] : []);
const watchingOf = (p) => (p.attributes?.watching || '').split(',').filter(Boolean);

// What a participant is streaming: video track (+ audio publication) if any.
function streamOf(p) {
  const vpub = p.getTrackPublication(Track.Source.ScreenShare);
  if (!vpub?.track) return null;
  return { vpub, apub: p.getTrackPublication(Track.Source.ScreenShareAudio) };
}

// ---------- room ----------
async function main() {
  const params = new URLSearchParams(location.search);
  let roomName = params.get('room');
  if (!roomName || !/^[A-Za-z0-9_-]{4,40}$/.test(roomName)) {
    roomName = crypto.getRandomValues(new Uint8Array(9)).reduce((s, b) => s + 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32], '');
    history.replaceState(null, '', `?room=${roomName}`);
  }
  $('roomName').textContent = `· sala ${roomName}`;

  const r = await fetch(`/auth/token?room=${encodeURIComponent(roomName)}`);
  if (r.status === 401) { location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
  if (r.status === 403) return fatal('A Telinha é só pra Medonhes.');
  if (!r.ok) return fatal('Não deu pra entrar na sala.', true);
  const { url, token } = await r.json();

  room = new Room({ adaptiveStream: true, dynacast: true });
  const rerender = () => schedule();
  for (const ev of [
    RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackPublished, RoomEvent.TrackUnpublished, RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
    RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
    RoomEvent.ParticipantAttributesChanged, RoomEvent.ParticipantMetadataChanged, RoomEvent.ParticipantNameChanged,
  ]) room.on(ev, rerender);
  room.on(RoomEvent.AudioPlaybackStatusChanged, () => $('audioUnlock').classList.toggle('hidden', room.canPlaybackAudio));
  room.on(RoomEvent.Reconnecting, () => toast('Reconectando…', 10000));
  room.on(RoomEvent.Reconnected, () => toast('Reconectado.'));
  room.on(RoomEvent.Disconnected, () => fatal('Saiu da sala (conexão caiu).', true));

  await room.connect(url, token);
  const me = room.localParticipant;
  $('me').replaceChildren(avatar(me), el('span', '', nameOf(me)));
  $('audioUnlock').classList.toggle('hidden', room.canPlaybackAudio);
  schedule();
  setInterval(updateStats, 1000);
}

// ---------- render ----------
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

function render() {
  const streamers = allParticipants().filter((p) => streamOf(p));
  const ids = new Set(streamers.map((p) => p.identity));
  for (const [id, t] of tiles) if (!ids.has(id)) { t.el.remove(); tiles.delete(id); }
  if (focusId && !ids.has(focusId)) focusId = null;

  for (const p of streamers) {
    const t = tiles.get(p.identity) || makeTile(p);
    updateTile(t, p);
  }

  // layout: focused tile big, the rest as a strip (or everything in the grid)
  const focus = $('focus'), grid = $('grid');
  focus.classList.toggle('hidden', !focusId);
  for (const p of streamers) {
    const t = tiles.get(p.identity);
    const parent = p.identity === focusId ? focus : grid;
    if (t.el.parentElement !== parent) {
      parent.append(t.el);
      t.video.play().catch(() => {}); // moving a <video> pauses it
    }
  }
  $('empty').classList.toggle('hidden', streamers.length > 0);

  renderPeople();
  renderShareButton();
  publishWatching(streamers);
}

function makeTile(p) {
  const local = p === room.localParticipant;
  const t = { el: el('div', `tile${local ? ' local' : ''}`), video: el('video'), audioEl: null, stats: el('pre', 'stats hidden') };
  t.el.dataset.id = p.identity;
  t.video.autoplay = true;
  t.video.playsInline = true;
  t.video.muted = true; // audio plays through its own element
  t.label = el('div', 'label');
  t.q = el('span', 'q');
  t.viewers = el('div', 'viewers hidden');
  t.controls = el('div', 'controls');
  t.el.append(t.video, el('span', 'live-dot', 'AO VIVO'), t.viewers, t.label, t.controls, t.stats);

  if (local) {
    t.controls.append(Object.assign(el('button', '', '⏹ Parar'), { onclick: (e) => { e.stopPropagation(); stopShare(); } }));
  } else {
    const vol = Object.assign(el('input'), { type: 'range', min: 0, max: 100, title: 'Volume' });
    vol.value = store.get(`vol.${p.identity}`, 100);
    const mute = el('button', '', '🔊');
    const setVol = () => {
      const muted = store.get(`mute.${p.identity}`, false);
      mute.textContent = muted ? '🔇' : '🔊';
      const a = streamOf(p)?.apub?.track;
      a?.setVolume(muted ? 0 : vol.value / 100);
    };
    t.setVol = setVol;
    vol.oninput = () => { store.set(`vol.${p.identity}`, Number(vol.value)); setVol(); };
    mute.onclick = (e) => { e.stopPropagation(); store.set(`mute.${p.identity}`, !store.get(`mute.${p.identity}`, false)); setVol(); };
    const q = el('select');
    q.title = 'Qualidade';
    for (const [v, label] of [['auto', 'Auto'], ['alta', 'Alta'], ['media', 'Média'], ['baixa', 'Baixa']]) q.append(Object.assign(el('option', '', label), { value: v }));
    q.value = store.get('quality', 'auto');
    q.onchange = () => { store.set('quality', q.value); streamOf(p)?.vpub.setVideoQuality(QUALITY[q.value]); };
    t.quality = q;
    t.volWrap = el('span');
    t.volWrap.append(vol, mute);
    for (const c of [vol, q]) c.onclick = (e) => e.stopPropagation();
    t.controls.append(t.volWrap, q);
  }
  const fs = Object.assign(el('button', '', '⛶'), { title: 'Tela cheia' });
  fs.onclick = (e) => { e.stopPropagation(); fullscreen(t.el); };
  t.controls.append(fs);

  t.el.onclick = () => { focusId = focusId === p.identity ? null : p.identity; schedule(); };
  t.el.ondblclick = () => fullscreen(t.el);
  tiles.set(p.identity, t);
  return t;
}

function fullscreen(node) {
  if (document.fullscreenElement) document.exitFullscreen();
  else node.requestFullscreen?.().catch(() => {});
}

function updateTile(t, p) {
  const { vpub, apub } = streamOf(p);
  if (t.videoTrack !== vpub.track) {
    t.videoTrack?.detach(t.video);
    vpub.track.attach(t.video);
    t.videoTrack = vpub.track;
    if (t.quality) vpub.setVideoQuality(QUALITY[t.quality.value]);
  }
  // remote game audio
  const at = p === room.localParticipant ? null : apub?.track;
  if (t.audioTrack !== at) {
    if (t.audioEl) { t.audioTrack?.detach(t.audioEl); t.audioEl.remove(); t.audioEl = null; }
    if (at) { t.audioEl = at.attach(); t.audioEl.classList.add('hidden'); t.el.append(t.audioEl); }
    t.audioTrack = at;
    t.setVol?.();
  }
  if (t.volWrap) t.volWrap.classList.toggle('hidden', !at);

  const local = p === room.localParticipant;
  t.label.replaceChildren(avatar(p), el('span', '', local ? `${nameOf(p)} (você)` : nameOf(p)), t.q);

  const viewers = allParticipants().filter((v) => v !== p && watchingOf(v).includes(p.identity));
  t.viewers.classList.toggle('hidden', viewers.length === 0);
  t.viewers.replaceChildren(...viewers.slice(0, 5).map((v) => avatar(v)), el('span', '', ` 👁 ${viewers.length}`));
  t.viewers.title = `Assistindo: ${viewers.map(nameOf).join(', ')}`;
  t.stats.classList.toggle('hidden', !statsOn);
}

function renderPeople() {
  const list = $('people');
  const ps = allParticipants();
  $('count').textContent = `— ${ps.length}`;
  list.replaceChildren(...ps.map((p) => {
    const li = el('li');
    const who = el('div', 'who');
    who.append(el('div', 'name', p === room.localParticipant ? `${nameOf(p)} (você)` : nameOf(p)));
    const s = streamOf(p);
    if (s) {
      who.append(el('div', 'sub live', `🔴 transmitindo${tiles.get(p.identity)?.q.textContent ? ` · ${tiles.get(p.identity).q.textContent}` : ''}`));
    } else {
      const w = watchingOf(p).map((id) => (id === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(id))).filter(Boolean);
      who.append(el('div', 'sub', w.length ? `assistindo ${w.map(nameOf).join(', ')}` : 'na sala'));
    }
    li.append(avatar(p, 'avatar lg'), who);
    return li;
  }));
}

// Tell the room which streams this viewer has on screen (for the 👁 lists).
let lastWatching = null;
function publishWatching(streamers) {
  const me = room.localParticipant.identity;
  const visible = focusId ? [focusId] : streamers.map((p) => p.identity);
  const value = visible.filter((id) => id !== me).sort().join(',');
  if (value === lastWatching) return;
  lastWatching = value;
  room.localParticipant.setAttributes({ watching: value }).catch(() => { lastWatching = null; });
}

// ---------- sharing ----------
function renderShareButton() {
  const b = $('share');
  b.textContent = share ? '⏹ Parar transmissão' : '🖥️ Transmitir';
  b.classList.toggle('live', !!share);
}

async function pickCodec() {
  // AV1 only with a hardware encoder; H.265 is only offered with one in Chrome.
  try {
    const r = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc', video: { contentType: 'video/AV1', width: 1920, height: 1080, bitrate: 12e6, framerate: 60 },
    });
    if (r.supported && r.powerEfficient) return 'av1';
  } catch {}
  const send = RTCRtpSender.getCapabilities?.('video')?.codecs.map((c) => c.mimeType) || [];
  return send.includes('video/H265') ? 'h265' : 'h264';
}

function captureConstraints(res, fps) {
  return { height: { max: res }, frameRate: { ideal: fps, max: fps }, resizeMode: 'crop-and-scale' };
}

function simulcastLayers(h, fps) {
  const low = new VideoPreset(640, 360, 700_000, Math.min(fps, 15));
  if (h > 1080) return [new VideoPreset(1280, 720, 3_500_000, Math.min(fps, 30)), low];
  if (h > 720) return [new VideoPreset(1280, 720, 3_000_000, Math.min(fps, 30)), low];
  return [low];
}

async function startShare() {
  const res = Number($('res').value), fps = Number($('fps').value);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(res, fps),
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
      systemAudio: 'include',
      windowAudio: 'window', // Chrome: offer the game window's own audio (no Discord voices)
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast(`Não deu pra capturar a tela: ${e.message}`, 6000);
    return;
  }
  const v = stream.getVideoTracks()[0];
  const a = stream.getAudioTracks()[0];
  v.contentHint = 'motion';
  const codec = await pickCodec();
  const h = v.getSettings().height || res;
  try {
    const video = await room.localParticipant.publishTrack(v, {
      source: Track.Source.ScreenShare,
      name: 'tela',
      videoCodec: codec,
      backupCodec: codec === 'h264' ? false : { codec: 'h264' },
      screenShareEncoding: { maxBitrate: KBPS[res][fps] * 1000, maxFramerate: fps },
      screenShareSimulcastLayers: simulcastLayers(h, fps),
      simulcast: true,
      degradationPreference: 'balanced',
    });
    const audio = a ? await room.localParticipant.publishTrack(a, {
      source: Track.Source.ScreenShareAudio,
      name: 'tela-audio',
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: false,
      forceStereo: true,
    }) : null;
    share = { video, audio, stream, codec };
    v.addEventListener('ended', stopShare);
    $('codecInfo').textContent = `${codec.toUpperCase()}${a ? ' · com som' : ' · sem som'}`;
    if (!a) toast('Transmitindo sem som. Pra ter o som do jogo: Chrome → aba Janela → marque o áudio do app.', 7000);
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    toast(`Erro ao transmitir: ${e.message}`, 6000);
  }
  schedule();
}

async function stopShare() {
  if (!share) return;
  const s = share;
  share = null;
  for (const pub of [s.video, s.audio]) {
    if (pub?.track) await room.localParticipant.unpublishTrack(pub.track, true).catch(() => {});
  }
  s.stream.getTracks().forEach((t) => t.stop());
  $('codecInfo').textContent = '';
  schedule();
}

// Change resolution/fps while live, without picking the screen again.
async function applyLive() {
  const res = Number($('res').value), fps = Number($('fps').value);
  store.set('share', { res, fps });
  if (!share) return;
  const track = share.video.track;
  try {
    await track.mediaStreamTrack.applyConstraints(captureConstraints(res, fps));
    const sender = track.sender;
    if (!sender) return;
    const p = sender.getParameters();
    const top = p.encodings.reduce((a, b) => ((b.scaleResolutionDownBy || 1) < (a.scaleResolutionDownBy || 1) ? b : a), p.encodings[0]);
    for (const e of p.encodings) e.maxFramerate = e === top ? fps : Math.min(fps, e.maxFramerate || fps);
    top.maxBitrate = KBPS[res][fps] * 1000;
    await sender.setParameters(p);
    toast(`Agora: ${res === 1440 ? 'Fonte' : `${res}p`} ${fps} fps`);
  } catch (e) {
    toast(`Não deu pra mudar a qualidade: ${e.message}`, 5000);
  }
}

// ---------- stats ----------
async function updateStats() {
  for (const [id, t] of tiles) {
    const track = t.videoTrack;
    if (!track) continue;
    const report = await track.getRTCStatsReport?.().catch(() => null);
    if (!report) continue;
    const m = new Map();
    report.forEach((s) => m.set(s.id, s));
    let best = null;
    report.forEach((s) => {
      if ((s.type === 'inbound-rtp' || s.type === 'outbound-rtp') && s.kind === 'video') {
        if (!best || (s.frameHeight || 0) > (best.frameHeight || 0)) best = s;
      }
    });
    if (!best) continue;
    const out = best.type === 'outbound-rtp';
    let bytes = 0;
    report.forEach((s) => { if (s.type === best.type && s.kind === 'video') bytes += out ? s.bytesSent : s.bytesReceived; });
    const prev = prevBytes.get(id);
    const mbps = prev ? ((bytes - prev.b) * 8) / ((best.timestamp - prev.t) * 1000) : 0;
    prevBytes.set(id, { b: bytes, t: best.timestamp });
    const fps = Math.round(best.framesPerSecond || 0);
    t.q.textContent = best.frameHeight ? `${best.frameHeight}p${fps}` : '';
    if (!statsOn) continue;
    let path = '?';
    report.forEach((s) => {
      const pair = s.type === 'transport' && m.get(s.selectedCandidatePairId);
      if (pair) {
        const relay = [m.get(pair.localCandidateId), m.get(pair.remoteCandidateId)].some((c) => c?.candidateType === 'relay');
        path = `${relay ? 'TURN' : 'direto'} ${Math.round((pair.currentRoundTripTime || 0) * 1000)}ms`;
      }
    });
    const codec = (m.get(best.codecId)?.mimeType || '').replace('video/', '');
    const impl = out ? best.encoderImplementation : best.decoderImplementation;
    t.stats.textContent = [
      `${out ? '⬆ enviando' : '⬇ recebendo'} ${best.frameWidth}×${best.frameHeight} @ ${fps} fps`,
      `${mbps.toFixed(1)} Mbps · ${codec}${impl ? ` · ${impl}` : ''}`,
      out ? `limite: ${best.qualityLimitationReason || '-'}` : `perdidos: ${best.packetsLost ?? 0}`,
      `servidor: ${path}`,
    ].join('\n');
  }
  if (tiles.size) renderPeople();
}

// ---------- wiring ----------
const saved = store.get('share', null);
if (saved) { $('res').value = String(saved.res); $('fps').value = String(saved.fps); }
$('res').onchange = applyLive;
$('fps').onchange = applyLive;
$('share').onclick = () => (share ? stopShare() : startShare());
$('copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Link copiado.'); } catch { toast(location.href, 6000); }
};
// 📊 also shows what this browser can send/receive (why a stream fell back to H.264).
function showCaps() {
  const has = (list, mime) => !!list?.('video')?.codecs.some((c) => c.mimeType === mime);
  const line = ['H265', 'AV1'].map((c) => {
    const m = `video/${c}`;
    const send = has(RTCRtpSender.getCapabilities?.bind(RTCRtpSender), m) ? '✓' : '✗';
    const recv = has(RTCRtpReceiver.getCapabilities?.bind(RTCRtpReceiver), m) ? '✓' : '✗';
    return `${c}: envia ${send} recebe ${recv}`;
  }).join(' · ');
  $('caps').textContent = statsOn ? line : '';
}
$('statsToggle').classList.toggle('on', statsOn);
$('statsToggle').onclick = () => {
  statsOn = !statsOn;
  store.set('stats', statsOn);
  $('statsToggle').classList.toggle('on', statsOn);
  showCaps();
  schedule();
};
showCaps();
$('audioUnlock').onclick = () => room?.startAudio();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && focusId && !document.fullscreenElement) { focusId = null; schedule(); } });

main().catch((e) => { console.error(e); fatal(`Erro: ${e.message}`, true); });
