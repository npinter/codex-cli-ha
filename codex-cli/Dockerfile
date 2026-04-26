ARG BUILD_FROM
FROM ${BUILD_FROM}

SHELL ["/bin/ash", "-o", "pipefail", "-c"]
ARG CODEX_CLI_VERSION=0.125.0

RUN apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    nano \
    nodejs \
    npm \
    python3 \
    tmux \
    vim

RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
    && codex --version \
    && npm install --omit=dev --prefix /tmp/codex-cli-ha-web @xterm/xterm @xterm/addon-fit @fortawesome/fontawesome-free@6.7.2 \
    && mkdir -p /opt/codex-cli-ha/vendor \
    && cp /tmp/codex-cli-ha-web/node_modules/@xterm/xterm/css/xterm.css /opt/codex-cli-ha/vendor/xterm.css \
    && cp /tmp/codex-cli-ha-web/node_modules/@xterm/xterm/lib/xterm.js /opt/codex-cli-ha/vendor/xterm.js \
    && cp /tmp/codex-cli-ha-web/node_modules/@xterm/addon-fit/lib/addon-fit.js /opt/codex-cli-ha/vendor/xterm-addon-fit.js \
    && mkdir -p /opt/codex-cli-ha/vendor/fontawesome \
    && cp -r /tmp/codex-cli-ha-web/node_modules/@fortawesome/fontawesome-free/css /opt/codex-cli-ha/vendor/fontawesome/css \
    && cp -r /tmp/codex-cli-ha-web/node_modules/@fortawesome/fontawesome-free/webfonts /opt/codex-cli-ha/vendor/fontawesome/webfonts \
    && rm -rf /tmp/codex-cli-ha-web /root/.npm

WORKDIR /config

COPY run.sh /run.sh
COPY scripts/ /opt/codex-cli-ha/scripts/
COPY web/ /opt/codex-cli-ha/web/

RUN chmod +x /run.sh \
    && chmod +x /opt/codex-cli-ha/scripts/*.sh \
    && chmod +x /opt/codex-cli-ha/scripts/*.py \
    && ln -sf /opt/codex-cli-ha/scripts/codex-image.sh /usr/local/bin/codex-image

CMD ["/run.sh"]
