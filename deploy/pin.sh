#!/bin/sh
# Installed as /usr/local/sbin/tela-pin by deploy/install.sh.
#   tela-pin vX.Y.Z   hold the deploy at that tag (any tag, incl. vX.Y.Z-rc.N), deploy now
#   tela-pin --unpin  follow the newest stable tag again, deploy now
#   tela-pin          show pin, deployed version and newest stable tag
set -eu

repo=/opt/bots/tela
pinfile=/etc/telinha/pin

usage() {
	echo "usage: tela-pin [vX.Y.Z[-pre] | --unpin]" >&2
	exit 2
}

case "${1:-}" in
"")
	git -C "$repo" fetch --tags --force --prune --quiet origin 2>/dev/null || echo "(fetch failed, local tags only)"
	pin=$(tr -d '[:space:]' < "$pinfile" 2>/dev/null || true)
	deployed=$(sed -n 's/^TELINHA_VERSION=//p' "$repo/deploy/.env" 2>/dev/null || true)
	newest=$(git -C "$repo" tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)
	checkout=$(git -C "$repo" describe --tags --exact-match HEAD 2>/dev/null || git -C "$repo" rev-parse --short HEAD)
	echo "pin:       ${pin:-none (following newest stable)}"
	echo "deployed:  ${deployed:+v}${deployed:-none}"
	echo "checkout:  $checkout"
	echo "newest:    ${newest:-none}"
	;;
--unpin)
	[ $# -eq 1 ] || usage
	rm -f "$pinfile"
	echo "unpinned, deploying newest stable tag"
	exec /usr/local/sbin/tela-update
	;;
v[0-9]*)
	[ $# -eq 1 ] || usage
	git -C "$repo" fetch --tags --force --prune --quiet origin || echo "fetch failed, checking local tags" >&2
	# Same pattern tela-update accepts, so a bad pin is never stored (it would
	# block every later deploy until --unpin).
	if ! printf '%s\n' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
		echo "tela-pin: not a release tag: $1" >&2
		exit 1
	fi
	if ! git -C "$repo" rev-parse -q --verify "refs/tags/$1^{commit}" >/dev/null; then
		echo "tela-pin: no such tag: $1" >&2
		exit 1
	fi
	printf '%s\n' "$1" > "$pinfile"
	echo "pinned to $1, deploying"
	exec /usr/local/sbin/tela-update
	;;
*)
	usage
	;;
esac
