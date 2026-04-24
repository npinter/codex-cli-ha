#!/usr/bin/env bash

set -euo pipefail

usage() {
    cat <<'EOF'
Usage:
  codex-image <image-file> <prompt>
  codex-image --new <image-file> <prompt>

Default mode resumes the latest Codex session with the image attached.
If resume fails, it starts a new Codex session with the image.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

mode="resume"
if [ "${1:-}" = "--new" ]; then
    mode="new"
    shift
fi

image="${1:-}"
if [ -z "$image" ]; then
    usage >&2
    exit 2
fi
shift

if [ ! -f "$image" ]; then
    echo "Image does not exist: $image" >&2
    exit 1
fi

prompt="$*"
if [ -z "$prompt" ]; then
    read -r -p "Prompt: " prompt
fi

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

if [ "$mode" = "new" ]; then
    exec codex "${args[@]}" --image "$image" "$prompt"
fi

codex resume --last "${args[@]}" --image "$image" "$prompt" || exec codex "${args[@]}" --image "$image" "$prompt"
