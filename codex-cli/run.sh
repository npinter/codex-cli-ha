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
    export XDG_CONFIG_HOME="/data/.config"
    export XDG_CACHE_HOME="/data/.cache"
    export XDG_STATE_HOME="/data/.local/state"
    export XDG_DATA_HOME="/data/.local/share"

    mkdir -p \
        "$HOME" \
        "$XDG_CONFIG_HOME" \
        "$XDG_CACHE_HOME" \
        "$XDG_STATE_HOME" \
        "$XDG_DATA_HOME" \
        "$CODEX_IMAGE_DIR"

    chmod 755 "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME"
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

main() {
    export CODEX_AUTO_LAUNCH="$(config_value auto_launch_codex true)"
    export CODEX_WORKSPACE="$(config_value codex_workspace /config)"
    export CODEX_SESSION_NAME="$(config_value codex_session_name codex-cli)"
    export CODEX_APPROVAL_POLICY="$(config_value codex_approval_policy on-request)"
    export CODEX_SANDBOX="$(config_value codex_sandbox workspace-write)"
    export CODEX_MODEL="$(config_value codex_model '')"
    export CODEX_IMAGE_DIR="$(config_value codex_image_dir /data/codex-images)"
    export CODEX_MAX_UPLOAD_MB="$(config_value codex_max_upload_mb 25)"
    export CODEX_TERMINAL_FONT_SIZE="$(config_value terminal_font_size 14)"
    export CODEX_WEB_DIR="/opt/codex-cli-ha/web"
    export CODEX_VENDOR_DIR="/opt/codex-cli-ha/vendor"
    export CODEX_SERVER_HOST="0.0.0.0"
    export CODEX_SERVER_PORT="7681"

    init_environment
    load_openai_settings

    bashio::log.info "Starting Codex CLI web terminal on ${CODEX_SERVER_HOST}:${CODEX_SERVER_PORT}"
    bashio::log.info "Workspace: ${CODEX_WORKSPACE}"
    bashio::log.info "Image directory: ${CODEX_IMAGE_DIR}"

    exec python3 /opt/codex-cli-ha/scripts/server.py
}

main "$@"
