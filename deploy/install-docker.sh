#!/bin/sh
# Install Telinha on a Linux Docker host. Run as root from a clone's deploy/ or the
# extracted release tarball (telinha-deploy.tar.gz):
#   sh install-docker.sh [--auto-update] [--setup | --no-setup]
# Idempotent: the compose files, telinha-update and its units are ours and always
# replaced; config/telinha.env is created from the example once and then left alone.
# On a terminal, an unfilled telinha.env starts the setup wizard (in the image);
# --setup runs it anyway, --no-setup never. The wizard runs the image of the
# bundle's telinha-image.digest (the release's own, by digest); TELINHA_VERSION=<tag>
# also pins compose to that release through /opt/telinha/.env, as telinha-update does.
set -eu
cd "$(dirname "$0")"

usage="usage: sh install-docker.sh [--auto-update] [--setup | --no-setup]"
auto=
setup=
for arg in "$@"; do
	case "$arg" in
	--auto-update) auto=1 ;;
	--setup) setup=yes ;;
	--no-setup) setup=no ;;
	*)
		echo "$usage" >&2
		exit 2
		;;
	esac
done
if [ "$(id -u)" -ne 0 ]; then
	echo "install-docker.sh: run as root" >&2
	exit 1
fi
have_docker=1
if ! command -v docker >/dev/null 2>&1; then
	echo "warning: docker not found; install Docker Engine with the compose plugin" >&2
	have_docker=
fi

# Same layout as a native root install (/opt/telinha/config/telinha.env).
dir=/opt/telinha
env=$dir/config/telinha.env
repo=ghcr.io/sombrasoft/telinha
version=${TELINHA_VERSION:-}
version=${version#v}
digest=
if [ -f telinha-image.digest ]; then
	digest=$(tr -d '[:space:]' <telinha-image.digest)
	if ! printf '%s\n' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
		echo "install-docker.sh: malformed telinha-image.digest: '$digest'" >&2
		exit 1
	fi
fi
if [ -n "$digest" ]; then
	image=$repo@$digest
elif [ -n "$version" ]; then
	image=$repo:$version
else
	image=$repo:latest
fi
install -d -m 700 "$dir" "$dir/config"
install -m 644 compose.yml compose.journald.yml "$dir/"
if [ -n "$version" ]; then
	# compose.yml reads TELINHA_VERSION from here; telinha-update keeps it from now on.
	printf 'TELINHA_VERSION=%s\nTELINHA_DIGEST=%s\n' "$version" "$digest" >"$dir/.env.tmp"
	mv "$dir/.env.tmp" "$dir/.env"
	echo "pinned compose to $version ($dir/.env)" >&2
fi
if [ ! -e "$env" ]; then
	install -m 600 telinha.env.example "$env"
	echo "created $env from telinha.env.example" >&2
fi

install -m 755 telinha-update /usr/local/sbin/telinha-update
install -m 644 telinha-update.service telinha-update.timer /etc/systemd/system/
systemctl daemon-reload

unfilled() {
	grep -Eq "^[A-Z_]+=(<.*>|'<.*>'|\"<.*>\"|''|\"\")?[[:space:]]*\$" "$env"
}

# The wizard runs in the image and writes $env through the mount; --user 0
# because the config dir is root's (0700), the wizard makes the file 0600.
if [ "$setup" != no ] && [ -n "$have_docker" ] && { [ "$setup" = yes ] || { [ -t 0 ] && unfilled; }; }; then
	tty=-i
	[ -t 0 ] && [ -t 1 ] && tty=-it
	echo "starting setup (docker run $image setup --docker)" >&2
	if ! docker run --rm "$tty" --user 0 -e TELINHA_HOME=/telinha -e TELINHA_HOST_ENV="$env" \
		-v "$dir/config:/telinha/config" "$image" setup --docker; then
		echo "warning: setup did not finish; edit $env by hand or re-run with --setup" >&2
	fi
fi

ready=1
if unfilled; then
	echo "warning: $env still has empty or <placeholder> values" >&2
	ready=
fi

# Deploying with placeholder secrets only crash-loops; wait for real ones.
if [ -n "$auto" ] && [ -n "$ready" ]; then
	# On a running host the timer fires right away (OnBootSec already passed).
	systemctl enable --now telinha-update.timer
	echo "telinha-update.timer enabled: follows the pin or the newest stable release (journalctl -t telinha-update)"
elif [ -n "$auto" ]; then
	echo "telinha-update.timer not enabled: fill in $env, then re-run install-docker.sh --auto-update" >&2
elif ! systemctl is-enabled --quiet telinha-update.timer 2>/dev/null; then
	echo "start once by hand:  cd $dir && docker compose up -d"
	echo "or keep it updated:  systemctl enable --now telinha-update.timer (or re-run with --auto-update)"
fi
