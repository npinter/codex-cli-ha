#!/usr/bin/env bash

set -uo pipefail

cd "${CODEX_WORKSPACE:-/config}" 2>/dev/null || cd /config || cd /

echo "Codex CLI for Home Assistant"
echo "Workspace: ${CODEX_WORKSPACE:-/config}"
echo "Images: ${CODEX_IMAGE_DIR:-/tmp/codex-images-tmp}"
echo
echo "Paste or drop images into the browser panel to save them."
echo "Use codex-image <image> \"prompt\" to start/resume Codex with an image."
echo

if [ "${CODEX_AUTO_LAUNCH:-true}" = "true" ]; then
    if command -v codex >/dev/null 2>&1; then
        args=("-C" "${CODEX_WORKSPACE:-/config}")
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

exec bash -l
