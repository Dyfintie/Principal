FROM node:24-bookworm-slim
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && node -e 'require("fs").writeFileSync("/tmp/bootstrap-ca.crt",require("tls").rootCertificates.join("\n"))' && apt-get -o Acquire::https::CaInfo=/tmp/bootstrap-ca.crt update && apt-get -o Acquire::https::CaInfo=/tmp/bootstrap-ca.crt install -y --no-install-recommends dbus gnome-keyring libsecret-tools openssh-server git ca-certificates python3 ripgrep procps bubblewrap && rm -rf /var/lib/apt/lists/* /tmp/bootstrap-ca.crt && groupmod --new-name principal node && usermod --login principal --home /home/principal --shell /bin/sh node && mkdir -p /home/principal && chown 1000:1000 /home/principal && passwd -d principal
COPY provider-bin/ /usr/local/bin/
COPY runtime/ /opt/principal/
RUN /usr/local/bin/codex --version && /usr/local/bin/agy --version && chmod 755 /opt/principal/*.sh /usr/local/bin/* && test -x /usr/local/bin/codex-code-mode-host && mkdir -p /workspace /run/principal && chown -R principal:principal /workspace /run/principal
ARG PRINCIPAL_UID=1000
ARG PRINCIPAL_GID=1000
RUN groupmod --non-unique --gid "$PRINCIPAL_GID" principal && usermod --non-unique --uid "$PRINCIPAL_UID" principal && chown -R "$PRINCIPAL_UID:$PRINCIPAL_GID" /home/principal /workspace /run/principal
ENV HOME=/home/principal XDG_RUNTIME_DIR=/run/principal
USER ${PRINCIPAL_UID}:${PRINCIPAL_GID}
WORKDIR /workspace
ENTRYPOINT ["/opt/principal/entry.sh"]
