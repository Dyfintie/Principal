#!/bin/sh
set -eu
mkdir -p /run/sshd
rm -f /etc/ssh/ssh_host_*_key*
ssh-keygen -A
node /opt/principal/login-environment.mjs
chown principal:principal /run/principal/login-environment.json
runuser -u principal -- /opt/principal/entry.sh &
cat > /run/principal/sshd_config <<'CONFIG'
Port 2222
ListenAddress 0.0.0.0
HostKey /etc/ssh/ssh_host_ed25519_key
PidFile /run/principal/sshd.pid
AuthorizedKeysFile /run/principal/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
UsePAM no
AllowUsers principal
StrictModes no
PrintMotd no
Subsystem sftp internal-sftp
CONFIG
exec /usr/sbin/sshd -D -e -f /run/principal/sshd_config
