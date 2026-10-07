// /livekit/*: the signaling proxy to the local LiveKit, behind the login gate
// in http.ts. Only signaling passes here (small protobuf messages); media goes
// peer <-> LiveKit.
// Bun 1.4.2 (verified): server.upgrade(req, { data }) works after an await in fetch and returning undefined after it is fine; the client WebSocket takes binaryType 'arraybuffer' and close(code, reason).
import type { ServerWebSocket, WebSocketHandler } from 'bun';

export interface ProxyData {
  /** ws(s) URL of the LiveKit endpoint for this connection (query included). */
  upstream: string;
}

export interface LivekitProxy {
  /** Only LiveKit's signaling (/rtc, /rtc/validate, /rtc/v1, ...) is proxied. */
  allows(rest: string): boolean;
  /** HTTP (non-upgrade) request for /livekit/<rest>: forwarded to <apiUrl>/<rest><search>. */
  fetch(req: Request, rest: string, search: string): Promise<Response>;
  /** Target URL for an upgrade of /livekit/<rest>; the caller does server.upgrade(req, { data }). */
  upgradeData(rest: string, search: string): ProxyData;
  websocket: WebSocketHandler<ProxyData>;
}

// Hop-by-hop headers (plus any the Connection header names) are for one leg only.
const HOP = [
  'connection',
  'upgrade',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
];
// Client messages held while LiveKit has not answered yet; more than this is a flood.
const MAX_QUEUED = 1 << 20;

function strip(from: Headers, extra: string[] = []): Headers {
  const h = new Headers(from);
  for (const name of (from.get('connection') ?? '').split(',')) if (name.trim()) h.delete(name.trim());
  for (const name of [...HOP, ...extra]) h.delete(name);
  return h;
}

/**
 * A close frame may carry 1000-1003, 1007-1014 or 3000-4999; the rest are reserved
 * (1006 = connection dropped) and Bun throws on them. 1005 = closed without a code.
 */
export function closeCode(code: number): number {
  if (code === 1005) return 1000;
  const ok = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return ok ? code : 1011;
}

// Close reasons are capped at 123 bytes of UTF-8.
function clip(reason: string): string {
  let r = reason;
  while (Buffer.byteLength(r) > 123) r = r.slice(0, -1);
  return r;
}

interface Conn {
  up: WebSocket;
  queue: (string | Uint8Array)[];
  queued: number;
  opened: boolean;
  done: boolean;
}

export function createLivekitProxy(o: { apiUrl: string; log: (...a: unknown[]) => void }): LivekitProxy {
  const base = o.apiUrl.replace(/\/$/, '');
  const wsBase = base.replace(/^http/, 'ws');
  const conns = new WeakMap<ServerWebSocket<ProxyData>, Conn>();

  // Twirp (the LiveKit room API) needs the API secret anyway; this is defense in depth.
  // No percent escapes: an encoded slash could be decoded upstream into another route.
  const allows = (rest: string) => (rest === '/rtc' || rest.startsWith('/rtc/')) && !rest.includes('%');
  const notFound = () =>
    Response.json({ error: 'not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });

  async function forward(req: Request, rest: string, search: string): Promise<Response> {
    if (!allows(rest)) return notFound();
    let res: Response;
    try {
      res = await fetch(`${base}${rest}${search}`, {
        method: req.method,
        // The session cookie must never reach LiveKit; Host is LiveKit's own.
        headers: strip(req.headers, ['cookie', 'host']),
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        redirect: 'manual',
        // Pass the body through as sent: a decompressed body under the upstream Content-Encoding is garbage.
        decompress: false,
      });
    } catch (e) {
      // rest only: the query carries the access token.
      o.log('[proxy] http', rest, 'failed:', (e as Error).message);
      return Response.json({ error: 'livekit' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: strip(res.headers) });
  }

  // Ends both legs once, with the one log line of the connection (never the URL: it has the token).
  function end(
    ws: ServerWebSocket<ProxyData>,
    st: Conn,
    code: number,
    reason: string,
    by: 'client' | 'livekit' | 'proxy',
  ) {
    if (st.done) return;
    st.done = true;
    st.queue = [];
    const c = closeCode(code);
    const r = clip(reason);
    o.log('[proxy] ws close', `code=${code}`, `by=${by}`);
    if (by !== 'client') ws.close(c, r);
    if (by !== 'livekit' && (st.up.readyState === WebSocket.CONNECTING || st.up.readyState === WebSocket.OPEN))
      st.up.close(c, r);
  }

  const websocket: WebSocketHandler<ProxyData> = {
    open(ws) {
      let up: WebSocket;
      try {
        up = new WebSocket(ws.data.upstream);
      } catch (e) {
        // A bad LIVEKIT_API_URL (config.ts validates it, so this is a backstop). Never
        // the error message: Bun puts the whole URL, access token included, in it.
        o.log(
          '[proxy] ws close',
          'code=1011',
          'by=proxy',
          `upstream WebSocket refused the URL (${(e as Error).name}), check LIVEKIT_API_URL`,
        );
        return ws.close(1011, 'livekit unreachable');
      }
      up.binaryType = 'arraybuffer';
      const st: Conn = { up, queue: [], queued: 0, opened: false, done: false };
      conns.set(ws, st);
      up.onopen = () => {
        st.opened = true;
        for (const m of st.queue) up.send(m);
        st.queue = [];
        st.queued = 0;
      };
      up.onmessage = (e) => {
        if (!st.done) ws.send(e.data as string | ArrayBuffer);
      };
      // A refused connection fires error then close; a dropped one only close.
      up.onerror = () => {
        if (!st.opened) end(ws, st, 1011, 'livekit unreachable', 'livekit');
      };
      up.onclose = (e) => {
        if (st.opened) end(ws, st, e.code, e.reason, 'livekit');
        else end(ws, st, 1011, 'livekit unreachable', 'livekit');
      };
    },
    message(ws, msg) {
      const st = conns.get(ws);
      if (!st || st.done) return;
      if (st.up.readyState === WebSocket.OPEN) return st.up.send(msg);
      if (st.up.readyState !== WebSocket.CONNECTING) return;
      // In order, once LiveKit answers.
      st.queued += typeof msg === 'string' ? Buffer.byteLength(msg) : msg.byteLength;
      if (st.queued > MAX_QUEUED) return end(ws, st, 1009, 'too much before livekit answered', 'proxy');
      st.queue.push(msg);
    },
    close(ws, code, reason) {
      const st = conns.get(ws);
      if (st) end(ws, st, code, reason, 'client');
    },
  };

  return {
    allows,
    fetch: forward,
    upgradeData: (rest, search) => ({ upstream: `${wsBase}${rest}${search}` }),
    websocket,
  };
}
