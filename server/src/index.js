// Telinha: Discord login gate in front of the LiveKit room page (Caddy forward_auth calls
// /auth/check on every request) plus the /tela slash command that posts a
// fresh room link. Only members holding ROLE_ID (Medonhes) get in; the role is
// re-checked through the bot every ROLE_CACHE_SECONDS, so removing the role
// locks someone out without waiting for the cookie to expire. Also serves the
// room page (/sala/, files from web/dist) and /healthz for the container
// healthcheck (Caddy only lets /auth/* past forward_auth, so it stays internal).
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, InteractionContextType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} from 'discord.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { randomBytes } from 'node:crypto';
import { sign, verify, parseCookies, safeNext, cookie } from './auth.js';

const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === '') throw new Error(`missing env ${k}`);
  return v;
};

const TOKEN = env('DISCORD_TOKEN');
const CLIENT_ID = env('DISCORD_CLIENT_ID');
const CLIENT_SECRET = env('DISCORD_CLIENT_SECRET');
const GUILD_ID = env('GUILD_ID');
const ROLE_ID = env('ROLE_ID');
// /tela only works in these channels (comma separated), e.g. #chat, which visitors can't see
const CHANNEL_IDS = env('CHANNEL_IDS').split(',').map((c) => c.trim()).filter(Boolean);
const PUBLIC_URL = env('PUBLIC_URL').replace(/\/$/, '');
const COOKIE_SECRET = env('COOKIE_SECRET');
const [HOST, PORT] = env('LISTEN', '127.0.0.1:8081').split(':');
const SESSION_S = Number(env('SESSION_DAYS', '7')) * 86400;
const ROLE_TTL_MS = Number(env('ROLE_CACHE_SECONDS', '300')) * 1000;
const LK_KEY = env('LIVEKIT_API_KEY');
const LK_SECRET = env('LIVEKIT_API_SECRET');
const LK_URL = `${PUBLIC_URL.replace(/^http/, 'ws')}/livekit`;
const ROOM_RE = /^[A-Za-z0-9_-]{4,40}$/;
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;
// The room page's static files (built into web/dist by `bun run build`), loaded
// once at start (small). WEB_DIR overrides the location.
const WEB_DIR = process.env.WEB_DIR || fileURLToPath(new URL('../../web/dist/', import.meta.url));
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
const WEB = Object.fromEntries(['index.html', 'app.js', 'app.css', 'livekit-client.esm.mjs'].map((n) => [
  n, { type: TYPES[n.split('.').pop()], body: readFileSync(join(WEB_DIR, n)) },
]));
const SESSION = 'telinha';
const STATE = 'telinha_state';

const rest = new REST().setToken(TOKEN);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// --- role check -------------------------------------------------------------
const roleCache = new Map(); // user id -> { ok, at }
async function isMedonhe(userId) {
  const hit = roleCache.get(userId);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const m = await rest.get(Routes.guildMember(GUILD_ID, userId));
    ok = m.roles.includes(ROLE_ID);
  } catch (e) {
    // 404 = not in the guild. Anything else (Discord hiccup): keep the last answer.
    if (e.status !== 404) {
      if (hit) return hit.ok;
      throw e;
    }
  }
  roleCache.set(userId, { ok, at: Date.now() });
  return ok;
}

// --- pages ------------------------------------------------------------------
const js = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px system-ui,sans-serif;background:#1e1f22;color:#dbdee1;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:420px;text-align:center}a{color:#00a8fc}</style><main>${body}</main></html>`;

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(html);
}

const denied = (name) => page('Telinha', `<h1>📺 Telinha</h1><p>${esc(name)}, a Telinha é só pra Medonhes.</p>
<p><a href="/auth/logout">Entrar com outra conta</a></p>`);

const welcome = (next) => page('Telinha', `<p>Entrando…</p><script>location.replace(${js(next)});</script>`);

// --- http -------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  const cookies = parseCookies(req.headers.cookie);

  // Container healthcheck: up as long as HTTP answers; reports the gateway state.
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, discord: client.isReady() }));
  }

  if (url.pathname === '/auth/check') {
    const s = verify(COOKIE_SECRET, cookies[SESSION]);
    if (s && (await isMedonhe(s.id))) {
      res.writeHead(204);
      return res.end();
    }
    if (s) return send(res, 403, denied(s.name));
    if (req.headers.upgrade) {
      res.writeHead(401);
      return res.end();
    }
    const next = safeNext(req.headers['x-forwarded-uri']);
    res.writeHead(302, { Location: `/auth/login?next=${encodeURIComponent(next)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url.pathname === '/auth/login') {
    const state = randomBytes(16).toString('base64url');
    const next = safeNext(url.searchParams.get('next'));
    const v = sign(COOKIE_SECRET, { s: state, next, exp: Date.now() + 10 * 60_000 });
    const q = new URLSearchParams({
      client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT_URI, scope: 'identify', state, prompt: 'none',
    });
    res.writeHead(302, {
      Location: `https://discord.com/oauth2/authorize?${q}`,
      'Set-Cookie': cookie(STATE, v, { maxAge: 600, path: '/auth' }),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }

  if (url.pathname === '/auth/callback') {
    const st = verify(COOKIE_SECRET, cookies[STATE]);
    const code = url.searchParams.get('code');
    if (!st || !code || url.searchParams.get('state') !== st.s) {
      return send(res, 400, page('Telinha', '<p>Login expirou. <a href="/">Tentar de novo</a></p>'));
    }
    const tok = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      }),
    });
    if (!tok.ok) throw new Error(`token exchange ${tok.status}`);
    const { access_token } = await tok.json();
    const me = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!me.ok) throw new Error(`users/@me ${me.status}`);
    const user = await me.json();
    const name = user.global_name || user.username;
    const session = sign(COOKIE_SECRET, { id: user.id, name, avatar: user.avatar, exp: Date.now() + SESSION_S * 1000 });
    const clearState = cookie(STATE, '', { maxAge: 0, path: '/auth' });
    const ok = await isMedonhe(user.id);
    log('login', user.id, name, ok ? 'ok' : 'denied');
    if (!ok) return send(res, 403, denied(name), { 'Set-Cookie': clearState });
    return send(res, 200, welcome(st.next), {
      'Set-Cookie': [cookie(SESSION, session, { maxAge: SESSION_S }), clearState],
    });
  }

  // LiveKit token for the new page (/sala/). Only Medonhes; may only publish screen share.
  if (url.pathname === '/auth/token') {
    const s = verify(COOKIE_SECRET, cookies[SESSION]);
    const room = url.searchParams.get('room') || '';
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!s) return json(401, { error: 'login' });
    if (!(await isMedonhe(s.id))) return json(403, { error: 'medonhes' });
    if (!ROOM_RE.test(room)) return json(400, { error: 'room' });
    // One identity per tab: LiveKit kicks the older connection on a duplicate
    // identity, and people do open the room twice (stream in one, watch in another).
    const identity = `${s.id}:${randomBytes(3).toString('hex')}`;
    const at = new AccessToken(LK_KEY, LK_SECRET, {
      identity, name: s.name, ttl: '6h', metadata: JSON.stringify({ id: s.id, avatar: s.avatar || null }),
    });
    at.addGrant({
      room, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: true, canUpdateOwnMetadata: true,
      canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    });
    return json(200, { url: LK_URL, token: await at.toJwt(), identity });
  }

  if (url.pathname === '/sala') {
    res.writeHead(301, { Location: `/sala/${url.search}` });
    return res.end();
  }
  if (url.pathname.startsWith('/sala/')) {
    const name = url.pathname.slice('/sala/'.length) || 'index.html';
    const f = Object.hasOwn(WEB, name) ? WEB[name] : null;
    if (!f) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-cache' });
    return res.end(f.body);
  }

  if (url.pathname === '/auth/logout') {
    return send(res, 200, page('Telinha', '<p>Saiu da Telinha. <a href="/">Entrar de novo</a></p>'), {
      'Set-Cookie': cookie(SESSION, '', { maxAge: 0 }),
    });
  }

  res.writeHead(404);
  res.end();
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('http error', req.url?.split('?')[0], e.message);
    if (!res.headersSent) send(res, 502, page('Telinha', '<p>Deu ruim no login. <a href="/">Tentar de novo</a></p>'));
    else res.end();
  });
}).listen(Number(PORT), HOST, () => log(`gate on ${HOST}:${PORT}`));

// --- /tela ------------------------------------------------------------------
const command = new SlashCommandBuilder()
  .setName('tela')
  .setDescription('Abre uma telinha pra compartilhar a tela (só Medonhes)')
  .setContexts(InteractionContextType.Guild)
  .addStringOption((o) => o.setName('o_que').setDescription('O que vai passar? ex: Elden Ring').setMaxLength(80));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommand() {
  try {
    await rest.put(Routes.applicationGuildCommands(client.application.id, GUILD_ID), { body: [command.toJSON()] });
    log('/tela registered');
  } catch (e) {
    log('/tela not registered yet (bot not in guild?)', e.message);
  }
}

client.once('clientReady', () => {
  log(`logged in as ${client.user.tag}`);
  registerCommand();
});
client.on('guildCreate', (g) => g.id === GUILD_ID && registerCommand());

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'tela') return;
  try {
    const roles = i.member?.roles;
    const ok = roles?.cache ? roles.cache.has(ROLE_ID) : roles?.includes?.(ROLE_ID);
    if (i.guildId !== GUILD_ID || !ok) {
      return await i.reply({ content: 'A Telinha é só pra Medonhes.', flags: MessageFlags.Ephemeral });
    }
    if (!CHANNEL_IDS.includes(i.channelId)) {
      const where = CHANNEL_IDS.map((c) => `<#${c}>`).join(' ou ');
      return await i.reply({ content: `Usa o /tela no ${where}.`, flags: MessageFlags.Ephemeral });
    }
    const room = randomBytes(9).toString('base64url');
    const link = `${PUBLIC_URL}/sala/?room=${room}`;
    const who = i.member.displayName ?? i.user.globalName ?? i.user.username;
    const what = i.options.getString('o_que');
    await i.reply({
      content: `📺 **${who}** abriu uma telinha${what ? `: ${what}` : ''}\n`
        + '-# Só Medonhes entram (login com Discord). Pra transmitir com som do jogo: Google Chrome → aba **Janela** → escolhe o jogo e marca o áudio do app (só o jogo, sem o Discord).',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Abrir telinha').setEmoji('📺').setURL(link),
      )],
      allowedMentions: { parse: [] },
    });
    log('tela', i.user.id, room);
  } catch (e) {
    log('tela error', e.message);
  }
});

client.login(TOKEN);
