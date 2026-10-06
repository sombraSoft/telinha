#!/bin/sh
# Install Telinha on Linux:
#   curl -fsSL https://github.com/sombraSoft/telinha/releases/latest/download/install.sh | sh
#   ... | sh -s -- [--native|--docker] [--no-setup]
# Env: TELINHA_INSTALL=native|docker, TELINHA_VERSION=<tag> (default: latest),
#   TELINHA_HOME=<dir>. Dev override: TELINHA_BASE_URL=<dir url holding the assets>
#   replaces the GitHub release URL (file:// works with curl).
# As root the service runs as a `telinha` user that can replace its own binary
# (it updates itself); root therefore runs a root-owned copy of the program
# (/usr/local/lib/telinha/telinha, on PATH as /usr/local/bin/telinha), never
# the service's.
set -eu

repo=https://github.com/sombraSoft/telinha/releases
mode=${TELINHA_INSTALL:-}
setup=1

for arg in "$@"; do
	case "$arg" in
	--native) mode=native ;;
	--docker) mode=docker ;;
	--no-setup) setup= ;;
	*)
		echo "usage: sh install.sh [--native|--docker] [--no-setup]" >&2
		exit 2
		;;
	esac
done
case "$mode" in
"" | native | docker) ;;
*)
	echo "install.sh: TELINHA_INSTALL must be native or docker" >&2
	exit 2
	;;
esac

die() {
	echo "install.sh: $*" >&2
	exit 1
}

# stdin is the script when piped, so a person is reachable only through /dev/tty.
has_tty() {
	(: </dev/tty) 2>/dev/null
}

# ldd knows which libc this userland runs; a stray /lib/ld-musl-* (Debian's
# musl package) next to glibc must not count. The loader files decide only
# when there is no ldd.
is_musl() {
	if command -v ldd >/dev/null 2>&1; then
		v=$(ldd --version 2>&1 || true)
		case "$v" in
		*musl*) return 0 ;;
		*GLIBC* | *"GNU libc"* | *"GNU C Library"*) return 1 ;;
		esac
	fi
	for f in /lib/ld-linux-*.so* /lib64/ld-linux-*.so*; do
		[ -e "$f" ] && return 1
	done
	for f in /lib/ld-musl-*.so*; do
		[ -e "$f" ] && return 0
	done
	return 1
}

[ "$(uname -s)" = Linux ] || die "only Linux is supported by this installer (macOS: not supported yet)"

if is_musl; then
	[ "$mode" != native ] || die "Alpine/musl detected: the native binary is glibc-only; use the Docker install"
	[ "$mode" = docker ] || echo "Alpine/musl detected: use the Docker install"
	mode=docker
fi

if [ -z "$mode" ]; then
	mode=native
	if has_tty; then
		echo "How do you want to run Telinha?"
		echo "  1) native binary (default)"
		echo "  2) Docker"
		printf "choice [1]: "
		read -r choice </dev/tty || choice=
		case "$choice" in
		2 | docker) mode=docker ;;
		esac
	fi
fi

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -qO "$2" "$1"; }
else
	die "curl or wget is required"
fi
command -v tar >/dev/null 2>&1 || die "tar is required"

if [ -n "${TELINHA_BASE_URL:-}" ]; then
	base=${TELINHA_BASE_URL%/}
elif [ -n "${TELINHA_VERSION:-}" ]; then
	base=$repo/download/$TELINHA_VERSION
else
	base=$repo/latest/download
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# Downloads release asset $1 into $tmp and checks it against SHA256SUMS.
fetch_verified() {
	fetch "$base/$1" "$tmp/$1" || die "download of $1 failed"
	[ -f "$tmp/SHA256SUMS" ] || fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download of SHA256SUMS failed"
	if command -v sha256sum >/dev/null 2>&1; then
		actual=$(sha256sum "$tmp/$1" | cut -d ' ' -f 1)
	elif command -v shasum >/dev/null 2>&1; then
		actual=$(shasum -a 256 "$tmp/$1" | cut -d ' ' -f 1)
	else
		die "sha256sum or shasum is required to verify the download"
	fi
	# sha256sum format: "<hex>  <name>".
	expected=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS")
	[ -n "$expected" ] || die "$1 is not listed in SHA256SUMS"
	[ "$actual" = "$expected" ] || die "checksum mismatch for $1"
	echo "sha256 ok: $1"
}

if [ "$mode" = docker ]; then
	if [ "$(id -u)" -ne 0 ]; then
		echo "install.sh: the Docker install needs root. Run it like this:" >&2
		echo "  curl -fsSL $repo/latest/download/install.sh | sudo sh -s -- --docker" >&2
		exit 1
	fi
	fetch_verified telinha-deploy.tar.gz
	tar -xzf "$tmp/telinha-deploy.tar.gz" -C "$tmp"
	[ -f "$tmp/install-docker.sh" ] || die "install-docker.sh not found in telinha-deploy.tar.gz"
	cd "$tmp"
	# install-docker.sh pins TELINHA_VERSION in /opt/telinha/.env when it is set.
	export TELINHA_VERSION="${TELINHA_VERSION:-}"
	# install-docker.sh offers the wizard only when its stdin is a terminal, and
	# ours is this script: hand it the person's terminal instead.
	if [ -z "$setup" ]; then
		sh install-docker.sh --no-setup
	elif has_tty; then
		sh install-docker.sh </dev/tty
	else
		sh install-docker.sh
	fi
	exit 0
fi

case "$(uname -m)" in
x86_64 | amd64) arch=x64 ;;
aarch64 | arm64)
	# Raspberry Pi OS 32-bit runs a 64-bit kernel: uname says aarch64, the
	# userland (and its loader) is armhf, and an arm64 binary cannot start.
	if [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" != 64 ]; then
		die "32-bit userland on a 64-bit kernel: use the Docker install or a 64-bit OS"
	fi
	arch=arm64
	;;
*) die "no native build for $(uname -m); use the Docker install" ;;
esac

root=
[ "$(id -u)" -eq 0 ] && root=1
if [ -n "${TELINHA_HOME:-}" ]; then
	home=$TELINHA_HOME
elif [ -n "$root" ]; then
	home=/opt/telinha
else
	home=${XDG_DATA_HOME:-$HOME/.local/share}/telinha
fi

asset=telinha-linux-$arch.tar.gz
echo "downloading $asset"
fetch_verified "$asset"
mkdir "$tmp/x"
tar -xzf "$tmp/$asset" -C "$tmp/x" telinha

if [ -n "$root" ]; then
	# Root's own copy, in a directory only root can write. setup copies it into
	# $home/bin for the service; from then on the service updates that one.
	lib=/usr/local/lib/telinha
	install -d -o root -g root -m 755 "$lib"
	install -o root -g root -m 755 "$tmp/x/telinha" "$lib/telinha.new"
	mv -f "$lib/telinha.new" "$lib/telinha"
	bin=$lib/telinha
	install -d -o root -g root -m 755 "$home"
	# The home is baked in, so `sudo telinha ...` always finds this install.
	install -d -m 755 /usr/local/bin
	rm -f /usr/local/bin/telinha
	# shellcheck disable=SC2016 # the launcher's own ${TELINHA_HOME} and "$@"
	printf '#!/bin/sh\n# Telinha: root-owned launcher written by install.sh.\nexport TELINHA_HOME="${TELINHA_HOME:-%s}"\nexec %s "$@"\n' "$home" "$bin" >/usr/local/bin/telinha.new
	chmod 755 /usr/local/bin/telinha.new
	mv -f /usr/local/bin/telinha.new /usr/local/bin/telinha
else
	bin=$home/bin/telinha
	mkdir -p "$home/bin"
	# Same directory + mv keeps the swap atomic even while the old binary runs.
	cp "$tmp/x/telinha" "$bin.new"
	chmod 755 "$bin.new"
	mv -f "$bin.new" "$bin"
fi

"$bin" --version

if [ -z "$root" ]; then
	case ":$PATH:" in
	*":$home/bin:"*) ;;
	*)
		echo "add to PATH (e.g. in ~/.profile):  export PATH=\"$home/bin:\$PATH\""
		[ -n "${TELINHA_HOME:-}" ] && echo "and keep the home:                 export TELINHA_HOME=\"$home\""
		;;
	esac
fi

if [ -n "$setup" ] && has_tty; then
	rm -rf "$tmp" # exec skips the EXIT trap
	export TELINHA_HOME="$home"
	exec "$bin" setup </dev/tty
fi
echo "next: run $bin setup"
