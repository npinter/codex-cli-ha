#!/usr/bin/env bash

set -uo pipefail

cd "${CODEX_WORKSPACE:-/config}" 2>/dev/null || cd /config || cd /

echo "Codex CLI (v${CODEX_ADDON_VERSION:-unknown}) for Home Assistant"
echo
echo "Image paste: Alt+V -> Ctrl+V -> Insert Path"
echo "If browser clipboard access is allowed, Alt+V inserts the image path directly."
echo

if [ "${CODEX_AUTO_LAUNCH:-true}" = "true" ]; then
    if command -v codex >/dev/null 2>&1; then
        # The Home Assistant add-on container cannot reliably provide the
        # process metadata Codex uses to manage its shared app-server daemon.
        # Keep the app server attached to the CLI process instead.
        args=("--no-daemon" "-C" "${CODEX_WORKSPACE:-/config}")
        if [ -n "${CODEX_APPROVAL_POLICY:-}" ]; then
            args+=("-a" "${CODEX_APPROVAL_POLICY}")
        fi
        if [ -n "${CODEX_SANDBOX:-}" ]; then
            args+=("-s" "${CODEX_SANDBOX}")
        fi
        if [ -n "${CODEX_MODEL:-}" ]; then
            args+=("-m" "${CODEX_MODEL}")
        fi
        codex "${args[@]}"
        echo
        echo "Codex exited. Starting a shell."
    else
        echo "codex command was not found. Starting a shell."
    fi
fi

# The login shell launched below is also used for manual Codex commands after
# the TUI exits. Export the function so plain `codex`, resume, and fork use the
# same mode there without changing the installed CLI binary.
if command -v codex >/dev/null 2>&1; then
    codex() {
        command codex --no-daemon "$@"
    }
    export -f codex
fi

exec bash -l
