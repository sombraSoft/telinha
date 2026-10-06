#!/bin/sh
# Install Telinha on a Linux Docker host. Run as root from a clone's deploy/ or the
# extracted release tarball (telinha-deploy.tar.gz):
#   sh install-docker.sh [--auto-update]
# Idempotent: the compose files, telinha-update and its units are ours and always
# replaced; config/telinha.env is created from the example once and then left alone.
set -eu
cd "$(dirname "$0")"

auto=
case "${1:-}" in
"") ;;
--auto-update) auto=1 ;;
*)
	echo "usage: sh install-docker.sh [--auto-update]" >&2
	exit 2
	;;
esac
if [ "$(id -u)" -ne 0 ]; then
	echo "install-docker.sh: run as root" >&2
	exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
	echo "warning: docker not found; install Docker Engine with the compose plugin" >&2
fi

# Same layout as a native root install (/opt/telinha/config/telinha.env).
dir=/opt/telinha
env=$dir/config/telinha.env
install -d -m 700 "$dir" "$dir/config"
install -m 644 compose.yml compose.journald.yml "$dir/"
if [ ! -e "$env" ]; then
	install -m 600 telinha.env.example "$env"
	echo "created $env from telinha.env.example" >&2
fi

install -m 755 telinha-update /usr/local/sbin/telinha-update
install -m 644 telinha-update.service telinha-update.timer /etc/systemd/system/
systemctl daemon-reload

ready=1
if grep -Eq "^[A-Z_]+=(<.*>|'<.*>'|\"<.*>\"|''|\"\")?[[:space:]]*\$" "$env"; then
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
