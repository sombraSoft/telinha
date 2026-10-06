#!/bin/sh
# Image smoke test, run inside the image from /app (scripts/image.ts and the CI
# image job): unit tests, the terminal UI, page assets, the bundled binaries, then the real entry
# point in DEV_USER mode supervising livekit-server. busybox wget plus bun.
set -eu

base=http://127.0.0.1:18081
data=/tmp/smoke

fail() {
	echo "smoke: FAIL: $*" >&2
	exit 1
}
step() {
	echo "==> $*"
}

step 'unit tests'
bun test server/test

step 'terminal UI from source'
# Outside bun test there is no bunfig preload: this proves prepareTui() registers the
# Solid transform at runtime and the musl native library loads (a key press must re-render).
TELINHA_SMOKE_TUI=1 bun server/src/index.ts --version || fail 'the terminal UI smoke failed'

step 'page assets'
test -f web/dist/index.html || fail 'web/dist/index.html missing'
ls web/dist/assets/*.js >/dev/null || fail 'no web/dist/assets/*.js'

step 'bundled binaries'
livekit-server --version
caddy version
cloudflared --version

step 'caddy version matches versions.json'
# Go's version selection may raise Caddy when a module needs a newer one; the pin must be the truth.
want="v$(bun -e 'console.log((await Bun.file("versions.json").json()).caddy.version)')"
[ "$(caddy version | cut -d' ' -f1)" = "$want" ] || fail "caddy is $(caddy version), versions.json says $want"

step 'caddy modules'
caddy list-modules | grep -q '^dns\.providers\.duckdns$' || fail 'caddy lacks dns.providers.duckdns'
caddy list-modules | grep -q '^layer4$' || fail 'caddy lacks layer4'

step 'caddy validates the DNS-01 Caddyfile'
# Renders the home configuration through the real code and lets Caddy parse it: the
# provider syntax and the module must both be right for the file to be accepted.
# validate provisions the modules but never contacts the CA. Not a real token.
duck_token=smoke-duckdns-token # gitleaks:allow
caddy_dir=/tmp/smoke-caddy
mkdir -p "$caddy_dir"
OUT="$caddy_dir/Caddyfile" DUCKDNS_TOKEN=$duck_token bun -e '
	const { loadConfig } = await import("./server/src/config.ts");
	const { renderCaddyfile } = await import("./server/src/render.ts");
	const c = loadConfig({
		DISCORD_TOKEN: "smoke", DISCORD_CLIENT_ID: "1", DISCORD_CLIENT_SECRET: "smoke", GUILD_ID: "2", ROLE_ID: "3", CHANNEL_IDS: "4",
		COOKIE_SECRET: "smoke", LIVEKIT_API_KEY: "smoke", LIVEKIT_API_SECRET: "smoke", DATA_DIR: "/tmp/smoke-caddy/data",
		HOSTING: "home", INGRESS: "direct", PUBLIC_URL: "https://smoke.duckdns.org:8443", HTTPS_PORT: "8443", HTTP_PORT: "0",
		ACME_DNS: "duckdns", DDNS_PROVIDER: "duckdns", DUCKDNS_DOMAIN: "smoke", DUCKDNS_TOKEN: process.env.DUCKDNS_TOKEN,
	});
	if (!c.acmeDns) throw new Error("the fixture did not select DNS-01");
	await Bun.write(process.env.OUT, renderCaddyfile(c));
' || fail 'could not render the DNS-01 Caddyfile'
cat "$caddy_dir/Caddyfile"
grep -q "$duck_token" "$caddy_dir/Caddyfile" && fail 'the rendered Caddyfile holds the DuckDNS token'
# XDG_*: whatever Caddy sets up while provisioning stays out of the bun user's home.
DUCKDNS_TOKEN=$duck_token XDG_DATA_HOME="$caddy_dir" XDG_CONFIG_HOME="$caddy_dir" \
	caddy validate --adapter caddyfile --config "$caddy_dir/Caddyfile" || fail 'caddy rejected the DNS-01 Caddyfile'

step 'server (INGRESS=external, MEDIA=self)'
# LIVEKIT_NODE_IP skips STUN (the container may have no internet); LiveKit
# logs an error for an API secret under 32 characters. Not a real secret.
# No router and no self-update in a test; exec makes $! (and the kill) bun itself.
lk_secret=smoke-secret-of-at-least-32-chars # gitleaks:allow
serve() {
	exec env INGRESS=external MEDIA=self DEV_USER=1:smoke PUBLIC_URL=http://localhost:18081 LISTEN=127.0.0.1:18081 \
		LIVEKIT_PORT=17880 MEDIA_TCP_PORT=17881 MEDIA_UDP_PORT=17882 LIVEKIT_NODE_IP=127.0.0.1 \
		DATA_DIR="$data" COOKIE_SECRET=smoke LIVEKIT_API_KEY=smoke LIVEKIT_API_SECRET="$lk_secret" \
		UPNP=off AUTO_UPDATE=off bun server/src/index.ts run
}
serve &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT

# Up means HTTP answers and the supervisor reports livekit-server running.
health=''
i=0
while [ "$i" -lt 30 ]; do
	kill -0 "$pid" 2>/dev/null || fail 'server exited'
	health=$(wget -qO- "$base/healthz" 2>/dev/null || true)
	case $health in *'"livekit":"up"'*) break ;; esac
	i=$((i + 1))
	sleep 1
done
echo "healthz: $health"
case $health in *'"livekit":"up"'*) ;; *) fail 'livekit not up within 30 s' ;; esac

step '/healthz through a proxy hides the detail'
proxied=$(wget -qO- --header 'X-Forwarded-For: 1.2.3.4' "$base/healthz")
echo "healthz (forwarded): $proxied"
case $proxied in *'"children"'*) fail 'forwarded /healthz exposes children' ;; esac
case $proxied in *'"ok":true'*) ;; *) fail 'forwarded /healthz is not ok' ;; esac

# One request with redirects not followed (busybox wget always follows them and
# has no cookie jar). Sets $out to "<status> <location> <first Set-Cookie
# name=value>" ("-" for a missing header) and splits it into $status,
# $location and $setcookie. A third argument is sent as a bearer token.
probe() {
	out=$(URL=$1 COOKIE=${2-} TOKEN=${3-} bun -e '
		const headers = {};
		if (process.env.COOKIE) headers.cookie = process.env.COOKIE;
		if (process.env.TOKEN) headers.authorization = "Bearer " + process.env.TOKEN;
		const r = await fetch(process.env.URL, { redirect: "manual", headers });
		const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
		console.log(r.status, r.headers.get("location") || "-", cookie || "-");
	') || fail "request to $1 failed"
	read -r status location setcookie <<-EOF
		$out
	EOF
}

step 'gate: /r/ without a cookie -> login'
probe "$base/r/"
[ "$status" = 302 ] || fail "/r/ is not a 302: $out"
case $location in */auth/login*) ;; *) fail "/r/ does not redirect to /auth/login: $out" ;; esac

step 'gate: dev login sets a session cookie'
probe "$base/auth/login?next=/r/"
[ "$status" = 302 ] || fail "/auth/login is not a 302: $out"
[ "$setcookie" != - ] || fail "no Set-Cookie from /auth/login: $out"
cookie=$setcookie

step 'gate: /r/ with the cookie serves the page'
page=$(wget -qO- --header "Cookie: $cookie" "$base/r/")
case $page in *'<div id="app"'*) ;; *) fail '/r/ lacks <div id="app"' ;; esac
case $page in *'telinha-command'*) ;; *) fail '/r/ lacks the telinha-command meta' ;; esac

step 'proxy: /livekit/ outside the /rtc allowlist -> 404'
probe "$base/livekit/twirp/x" "$cookie"
[ "$status" = 404 ] || fail "/livekit/twirp/x is not a 404: $out"

step 'page assets need no login'
for f in web/dist/assets/*.js; do
	asset=${f##*/}
	break
done
probe "$base/r/assets/$asset"
[ "$status" = 200 ] || fail "/r/assets/$asset without a cookie is not a 200: $out"

step 'doctor: nothing without a one-time link'
probe "$base/doctor"
[ "$status" = 404 ] || fail "/doctor without a token is not a 404: $out"

step 'control endpoint: 404 without the token or through a proxy, status with it'
probe "$base/internal/status"
[ "$status" = 404 ] || fail "/internal/status without a token is not a 404: $out"
token=$(cat "$data/run/control.token") || fail 'no control token'
probe "$base/internal/status" '' "$token"
[ "$status" = 200 ] || fail "/internal/status with the token is not a 200: $out"
body=$(wget -qO- --header "Authorization: Bearer $token" "$base/internal/status")
echo "status: $body"
case $body in *'"version"'*) ;; *) fail '/internal/status has no version' ;; esac
forwarded=$(wget -qO- --header "Authorization: Bearer $token" --header 'X-Forwarded-For: 1.2.3.4' "$base/internal/status" 2>/dev/null || true)
[ -z "$forwarded" ] || fail '/internal/status answers a forwarded request'

step 'a second run on the same data refuses to start and leaves the first alone'
second=0
(serve) >/tmp/smoke-second.log 2>&1 || second=$?
cat /tmp/smoke-second.log
[ "$second" = 1 ] || fail "second run exited $second, want 1"
grep -q 'already running' /tmp/smoke-second.log || fail 'second run did not say it is already running'
[ "$(cat "$data/run/control.token")" = "$token" ] || fail 'second run replaced the control token'
kill -0 "$pid" 2>/dev/null || fail 'the first server died'
case $(wget -qO- "$base/healthz") in *'"livekit":"up"'*) ;; *) fail 'livekit not up after the second run' ;; esac

step 'control endpoint: graceful stop'
URL="$base/internal/shutdown" TOKEN=$token bun -e '
	const r = await fetch(process.env.URL, {
		method: "POST",
		headers: { authorization: "Bearer " + process.env.TOKEN, "content-type": "application/json" },
		body: JSON.stringify({ reason: "stop" }),
	});
	if (r.status !== 202) throw new Error("shutdown answered " + r.status);
' || fail '/internal/shutdown was not accepted'
code=0
wait "$pid" || code=$?
trap - EXIT
[ "$code" = 0 ] || fail "exit $code after /internal/shutdown"
[ ! -e "$data/run/control.token" ] || fail 'control token left behind'
[ ! -e "$data/run/telinha.pid" ] || fail 'pidfile left behind'

step 'ok'
