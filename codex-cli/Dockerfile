ARG BUILD_FROM=ghcr.io/home-assistant/base:3.23
FROM ${BUILD_FROM} AS builder

SHELL ["/bin/ash", "-o", "pipefail", "-c"]

ARG CODEX_CLI_VERSION=0.128.0
ARG FONTAWESOME_VERSION=6.7.2
ARG XTERM_FIT_VERSION=0.11.0
ARG XTERM_VERSION=6.0.0

RUN apk add --no-cache nodejs npm

RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
    && codex --version \
    && npm install --omit=dev --prefix /tmp/codex-cli-ha-web "@xterm/xterm@${XTERM_VERSION}" "@xterm/addon-fit@${XTERM_FIT_VERSION}" "@fortawesome/fontawesome-free@${FONTAWESOME_VERSION}" \
    && mkdir -p /opt/codex-cli-ha/vendor \
    && cp /tmp/codex-cli-ha-web/node_modules/@xterm/xterm/css/xterm.css /opt/codex-cli-ha/vendor/xterm.css \
    && cp /tmp/codex-cli-ha-web/node_modules/@xterm/xterm/lib/xterm.js /opt/codex-cli-ha/vendor/xterm.js \
    && cp /tmp/codex-cli-ha-web/node_modules/@xterm/addon-fit/lib/addon-fit.js /opt/codex-cli-ha/vendor/xterm-addon-fit.js \
    && mkdir -p /opt/codex-cli-ha/vendor/fontawesome \
    && cp -r /tmp/codex-cli-ha-web/node_modules/@fortawesome/fontawesome-free/css /opt/codex-cli-ha/vendor/fontawesome/css \
    && cp -r /tmp/codex-cli-ha-web/node_modules/@fortawesome/fontawesome-free/webfonts /opt/codex-cli-ha/vendor/fontawesome/webfonts \
    && rm -rf /tmp/codex-cli-ha-web /root/.npm

FROM ${BUILD_FROM}

SHELL ["/bin/ash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
    bash \
    bubblewrap \
    ca-certificates \
    nano \
    nodejs \
    python3 \
    tmux \
    && for package in curl jq bind-tools xz; do \
        if apk info -e "$package" >/dev/null 2>&1; then \
            apk del --purge "$package"; \
        fi; \
    done

WORKDIR /config

COPY --from=builder /usr/local/lib/node_modules/@openai/codex/ /usr/local/lib/node_modules/@openai/codex/
COPY --from=builder /opt/codex-cli-ha/vendor/ /opt/codex-cli-ha/vendor/

COPY run.sh /run.sh
COPY scripts/ /opt/codex-cli-ha/scripts/
COPY web/ /opt/codex-cli-ha/web/

RUN chmod +x /run.sh \
    && chmod +x /opt/codex-cli-ha/scripts/*.sh \
    && chmod +x /opt/codex-cli-ha/scripts/*.py \
    && ln -sf /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
    && if [ -x /usr/bin/bwrap ]; then ln -sf /usr/bin/bwrap /usr/local/bin/bubblewrap; fi \
    && ln -sf /opt/codex-cli-ha/scripts/codex-image.sh /usr/local/bin/codex-image

CMD ["/run.sh"]
