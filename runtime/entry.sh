#!/bin/sh
set -eu
umask 077
while [ ! -f /run/principal/ready ]; do sleep 0.1; done
mkdir -p "$HOME/.local/share/keyrings" "$HOME/.codex" "$HOME/.gemini" "$HOME/.config"
mkdir -p "$HOME/.config/principal"
if [ ! -f "$HOME/.config/principal/keyring-password" ]; then
  head -c 32 /dev/urandom | base64 > "$HOME/.config/principal/keyring-password"
fi
exec dbus-run-session -- sh -c '
  eval "$(gnome-keyring-daemon --login --components=secrets < "$HOME/.config/principal/keyring-password")"
  eval "$(gnome-keyring-daemon --start --components=secrets)"
  printf "%s" "$DBUS_SESSION_BUS_ADDRESS" > /run/principal/dbus-address
  exec node /opt/principal/worker.mjs
'
