#!/bin/sh
# Image smoke test, run inside the image from /app (scripts/image.ts and the CI
# image job): unit tests, page assets, the bundled binaries, then the real entry
# point in DEV_USER mode supervising livekit-server. busybox wget plus bun.
set -eu

base=http://127.0.0.1:18081

fail() {
	echo "smoke: FAIL: $*" >&2
	exit 1
}
step() {
	echo "==> $*"
}

step 'unit tests'
bun test server/test

step 'page assets'
test -f web/dist/index.html || fail 'web/dist/index.html missing'
ls web/dist/assets/*.js >/dev/null || fail 'no web/dist/assets/*.js'

step 'bundled binaries'
livekit-server --version
caddy version
cloudflared --version

step 'server (INGRESS=external, MEDIA=self)'
# LIVEKIT_NODE_IP skips STUN (the container may have no internet); LiveKit
# logs an error for an API secret under 32 characters. Not a real secret.
lk_secret=smoke-secret-of-at-least-32-chars # gitleaks:allow
INGRESS=external MEDIA=self DEV_USER=1:smoke PUBLIC_URL=http://localhost:18081 LISTEN=127.0.0.1:18081 \
	LIVEKIT_PORT=17880 MEDIA_TCP_PORT=17881 MEDIA_UDP_PORT=17882 LIVEKIT_NODE_IP=127.0.0.1 \
	DATA_DIR=/tmp/smoke COOKIE_SECRET=smoke LIVEKIT_API_KEY=smoke LIVEKIT_API_SECRET="$lk_secret" \
	bun server/src/index.ts &
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
# $location and $setcookie.
probe() {
	out=$(URL=$1 COOKIE=${2-} bun -e '
		const r = await fetch(process.env.URL, { redirect: "manual", headers: process.env.COOKIE ? { cookie: process.env.COOKIE } : {} });
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

step 'ok'
