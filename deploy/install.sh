#!/bin/sh
# Run as root on the host from the clone: sh /opt/bots/tela/deploy/install.sh
# Idempotent: re-run after an update changes any host script or unit.
set -eu
cd "$(dirname "$0")"

install -m 755 ipwatch/tela-ipwatch /usr/local/sbin/tela-ipwatch
install -m 755 updater/tela-update /usr/local/sbin/tela-update
install -m 755 pin.sh /usr/local/sbin/tela-pin
install -m 644 ipwatch/tela-ipwatch.service ipwatch/tela-ipwatch.timer \
	updater/tela-update.service updater/tela-update.timer /etc/systemd/system/

# Secrets stay outside the clone; see env/*.env.example.
install -d -m 700 /etc/telinha
ready=1
for name in app livekit tunnel; do
	f=/etc/telinha/$name.env
	if [ ! -f "$f" ]; then
		echo "warning: $f missing (copy env/$name.env.example, chmod 600)" >&2
		ready=
	elif grep -Eq '^[A-Z_]+=(<.*>)?$' "$f"; then
		echo "warning: $f still has empty or <placeholder> values" >&2
		ready=
	fi
done

systemctl daemon-reload
# On a running host the timers fire right away (OnBootSec already passed).
systemctl enable --now tela-ipwatch.timer
# Deploying with placeholder secrets only crash-loops; wait for real ones.
if [ -n "$ready" ]; then
	systemctl enable --now tela-update.timer
else
	echo "tela-update.timer not enabled: fill in /etc/telinha/*.env, then re-run install.sh" >&2
fi
