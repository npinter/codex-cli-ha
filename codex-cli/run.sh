#!/usr/bin/with-contenv bashio

set -e
set -o pipefail

config_value() {
    local key="$1"
    local default="$2"
    local value
    value="$(bashio::config "$key" "$default")"
    if [ -z "$value" ] || [ "$value" = "null" ]; then
        value="$default"
    fi
    printf '%s' "$value"
}

init_environment() {
    export HOME="/data/home"
    export CODEX_HOME="${HOME}/.codex"
    export XDG_CONFIG_HOME="/data/.config"
    export XDG_CACHE_HOME="/data/.cache"
    export XDG_STATE_HOME="/data/.local/state"
    export XDG_DATA_HOME="/data/.local/share"

    mkdir -p \
        "$HOME" \
        "$CODEX_HOME" \
        "$XDG_CONFIG_HOME" \
        "$XDG_CACHE_HOME" \
        "$XDG_STATE_HOME" \
        "$XDG_DATA_HOME" \
        "$CODEX_IMAGE_DIR"

    chmod 755 "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME"
    chmod 700 "$CODEX_HOME" 2>/dev/null || true
    chmod 700 "$CODEX_IMAGE_DIR" 2>/dev/null || true
}

load_openai_settings() {
    local api_key
    api_key="$(config_value openai_api_key '')"
    if [ -n "$api_key" ]; then
        export OPENAI_API_KEY="$api_key"
    fi

    local base_url
    base_url="$(config_value openai_base_url '')"
    if [ -n "$base_url" ]; then
        export OPENAI_BASE_URL="$base_url"
    fi

    local org
    org="$(config_value openai_organization '')"
    if [ -n "$org" ]; then
        export OPENAI_ORG_ID="$org"
    fi
}

start_clipboard_display() {
    export DISPLAY="${CODEX_CLIPBOARD_DISPLAY:-:99}"
    export CODEX_CLIPBOARD_DISPLAY="$DISPLAY"

    if command -v Xvfb >/dev/null 2>&1; then
        local display_number
        display_number="${DISPLAY#:}"
        display_number="${display_number%%.*}"
        rm -f "/tmp/.X${display_number}-lock"
        mkdir -p /tmp/.X11-unix
        chmod 1777 /tmp/.X11-unix 2>/dev/null || true

        Xvfb "$DISPLAY" -screen 0 1024x768x24 -nolisten tcp -ac >/tmp/codex-xvfb.log 2>&1 &
        for _ in $(seq 1 25); do
            if [ -S "/tmp/.X11-unix/X${display_number}" ]; then
                bashio::log.info "Started X11 clipboard display on ${DISPLAY}"
                return
            fi
            sleep 0.2
        done
        bashio::log.warning "Xvfb did not become ready on ${DISPLAY}; native image paste bridge may fail"
    else
        bashio::log.warning "Xvfb is not installed; native Codex image paste bridge is disabled"
    fi
}

bootstrap_config_git() {
    if [ "$(config_value config_git_tracking true)" != "true" ]; then
        bashio::log.info "Home Assistant config Git tracking is disabled"
        return
    fi

    if /opt/codex-cli-ha/scripts/ha-config.sh bootstrap >/tmp/ha-config-bootstrap.log 2>&1; then
        bashio::log.info "Home Assistant config Git tracking is ready"
    else
        bashio::log.warning "Home Assistant config Git tracking failed: $(cat /tmp/ha-config-bootstrap.log)"
    fi
}

main() {
    local image_dir
    image_dir="$(config_value codex_image_dir /tmp/codex-images-tmp)"
    if [ "$image_dir" = "/data/codex-images" ]; then
        image_dir="/tmp/codex-images-tmp"
    fi

    export CODEX_AUTO_LAUNCH="$(config_value auto_launch_codex true)"
    export CODEX_WORKSPACE="$(config_value codex_workspace /config)"
    export CODEX_SESSION_NAME="$(config_value codex_session_name codex-cli)"
    export CODEX_APPROVAL_POLICY="$(config_value codex_approval_policy on-request)"
    export CODEX_SANDBOX="$(config_value codex_sandbox workspace-write)"
    export CODEX_MODEL="$(config_value codex_model '')"
    export CODEX_IMAGE_DIR="$image_dir"
    export CODEX_MAX_UPLOAD_MB="$(config_value codex_max_upload_mb 25)"
    export CODEX_IMAGE_CLEANUP_SECONDS="$(config_value codex_image_cleanup_seconds 60)"
    export CODEX_TERMINAL_FONT_SIZE="$(config_value terminal_font_size 14)"
    export CODEX_WEB_DIR="/opt/codex-cli-ha/web"
    export CODEX_VENDOR_DIR="/opt/codex-cli-ha/vendor"
    export CODEX_SERVER_HOST="0.0.0.0"
    export CODEX_SERVER_PORT="7681"
    if [ -r /opt/codex-cli-ha/build-version ]; then
        export CODEX_ADDON_VERSION="$(cat /opt/codex-cli-ha/build-version)"
    else
        export CODEX_ADDON_VERSION="0.1.26"
    fi

    init_environment
    bootstrap_config_git
    load_openai_settings
    start_clipboard_display

    bashio::log.info "Starting Codex CLI web terminal on ${CODEX_SERVER_HOST}:${CODEX_SERVER_PORT}"

    exec python3 /opt/codex-cli-ha/scripts/server.py
}

main "$@"
