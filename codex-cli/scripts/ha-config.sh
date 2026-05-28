#!/usr/bin/env bash

set -euo pipefail

CONFIG_REPO="${HA_CONFIG_REPO:-/config}"
GIT_USER_NAME="${HA_CONFIG_GIT_USER_NAME:-Codex CLI HA}"
GIT_USER_EMAIL="${HA_CONFIG_GIT_USER_EMAIL:-codex-cli-ha@local}"
EXCLUDE_BEGIN="# BEGIN codex-cli-ha managed Home Assistant config tracking"
EXCLUDE_END="# END codex-cli-ha managed Home Assistant config tracking"
REPO_CREATED=0

die() {
    printf 'ha-config: %s\n' "$*" >&2
    exit 1
}

git_config() {
    git -C "$CONFIG_REPO" "$@"
}

ensure_config_dir() {
    [ -d "$CONFIG_REPO" ] || die "config directory does not exist: $CONFIG_REPO"
}

ensure_safe_directory() {
    if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fx -- "$CONFIG_REPO" >/dev/null; then
        git config --global --add safe.directory "$CONFIG_REPO" >/dev/null 2>&1 || true
    fi
}

is_git_repo() {
    git_config rev-parse --git-dir >/dev/null 2>&1
}

has_head() {
    git_config rev-parse --verify HEAD >/dev/null 2>&1
}

configure_repo() {
    if ! git_config config user.name >/dev/null 2>&1; then
        git_config config user.name "$GIT_USER_NAME"
    fi
    if ! git_config config user.email >/dev/null 2>&1; then
        git_config config user.email "$GIT_USER_EMAIL"
    fi
    git_config config commit.gpgsign false
}

has_managed_exclude() {
    local exclude_file="$CONFIG_REPO/.git/info/exclude"
    [ -f "$exclude_file" ] && grep -Fq "$EXCLUDE_BEGIN" "$exclude_file"
}

apply_managed_exclude() {
    local exclude_file="$CONFIG_REPO/.git/info/exclude"
    mkdir -p "$(dirname "$exclude_file")"
    if has_managed_exclude; then
        return
    fi
    {
        printf '\n%s\n' "$EXCLUDE_BEGIN"
        printf '# Track Home Assistant YAML and Codex instructions by default.\n'
        printf '*\n'
        printf '!*/\n'
        printf '!*.yaml\n'
        printf '!*.yml\n'
        printf '!AGENTS.md\n'
        printf 'secrets.yaml\n'
        printf '**/secrets.yaml\n'
        printf '%s\n' "$EXCLUDE_END"
    } >>"$exclude_file"
}

ensure_repo() {
    ensure_config_dir
    ensure_safe_directory
    if ! is_git_repo; then
        git -C "$CONFIG_REPO" init --initial-branch=main
        REPO_CREATED=1
    fi
    configure_repo
    if [ "$REPO_CREATED" -eq 1 ] || has_managed_exclude; then
        apply_managed_exclude
    fi
}

write_agents_file() {
    local agents_file="$CONFIG_REPO/AGENTS.md"
    if [ -e "$agents_file" ]; then
        return 1
    fi
    cat >"$agents_file" <<'EOF'
# Home Assistant Config Editing

- Before editing any `*.yaml` or `*.yml` file, run `ha-config-status`.
- After editing any `*.yaml` or `*.yml` file, run `ha-config-checkpoint "short description of the change"`.
- Before reloading Home Assistant YAML, run `ha-config-diff`.
- Do not create raw Git commits yourself unless the user explicitly asks for that.
- Do not edit or commit `secrets.yaml` unless the user explicitly asks for that.
- To roll back a YAML file, use `ha-config-restore <path>`.
EOF
    return 0
}

stage_yaml_changes() {
    while IFS= read -r -d '' path; do
        local rel="${path#"$CONFIG_REPO"/}"
        case "$rel" in
            secrets.yaml|*/secrets.yaml) continue ;;
        esac
        git_config add -f -- "$rel"
    done < <(find "$CONFIG_REPO" -path "$CONFIG_REPO/.git" -prune -o -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)

    while IFS= read -r -d '' rel; do
        case "$rel" in
            *.yaml|*.yml) ;;
            *) continue ;;
        esac
        case "$rel" in
            secrets.yaml|*/secrets.yaml) continue ;;
        esac
        if [ ! -e "$CONFIG_REPO/$rel" ]; then
            git_config rm --quiet --ignore-unmatch -- "$rel"
        fi
    done < <(git_config ls-files -z)
}

collect_staged_yaml_files() {
    STAGED_YAML_FILES=()
    while IFS= read -r -d '' rel; do
        case "$rel" in
            *.yaml|*.yml) ;;
            *) continue ;;
        esac
        case "$rel" in
            secrets.yaml|*/secrets.yaml) continue ;;
        esac
        STAGED_YAML_FILES+=("$rel")
    done < <(git_config diff --cached --name-only -z --diff-filter=ACMRD)
}

commit_staged_yaml() {
    local message="$1"
    collect_staged_yaml_files
    if [ "${#STAGED_YAML_FILES[@]}" -eq 0 ]; then
        printf 'No YAML changes to checkpoint.\n'
        return 0
    fi
    git_config commit -m "$message" -- "${STAGED_YAML_FILES[@]}"
}

cmd_bootstrap() {
    ensure_repo
    local agents_created=0
    if write_agents_file; then
        agents_created=1
    fi

    if ! has_head; then
        stage_yaml_changes
        if [ -f "$CONFIG_REPO/AGENTS.md" ]; then
            git_config add -f -- AGENTS.md
        fi
        if git_config diff --cached --quiet --exit-code; then
            printf 'Home Assistant config Git tracking is ready in %s; no files were committed.\n' "$CONFIG_REPO"
        else
            git_config commit -m "Initial Home Assistant config baseline"
        fi
        return
    fi

    if [ "$agents_created" -eq 1 ]; then
        git_config add -f -- AGENTS.md
        git_config commit -m "Add Codex Home Assistant instructions" -- AGENTS.md
    fi

    printf 'Home Assistant config Git tracking is ready in %s.\n' "$CONFIG_REPO"
}

cmd_status() {
    ensure_repo
    git_config status --short
}

cmd_diff() {
    ensure_repo
    git_config diff -- '*.yaml' '*.yml' ':(exclude)secrets.yaml' ':(exclude)**/secrets.yaml'
}

cmd_checkpoint() {
    ensure_repo
    if ! has_head; then
        cmd_bootstrap
    fi
    local message="Codex YAML checkpoint"
    if [ "$#" -gt 0 ]; then
        message="$*"
    fi
    stage_yaml_changes
    commit_staged_yaml "$message"
}

validate_yaml_path() {
    local target="$1"
    [ -n "$target" ] || die "missing YAML path"
    target="${target#./}"
    case "$target" in
        /*|../*|*/../*|.|"") die "path must stay inside $CONFIG_REPO: $1" ;;
    esac
    case "$target" in
        *.yaml|*.yml) ;;
        *) die "only *.yaml and *.yml files can be restored with this helper: $target" ;;
    esac
    case "$target" in
        secrets.yaml|*/secrets.yaml) die "secrets.yaml is excluded by default" ;;
    esac
    printf '%s' "$target"
}

cmd_restore() {
    ensure_repo
    has_head || die "no Git commits exist yet"
    local target
    target="$(validate_yaml_path "${1:-}")"
    local source_ref="${2:-HEAD~1}"
    git_config restore --source "$source_ref" -- "$target"
    printf 'Restored %s from %s. Run ha-config-checkpoint to commit the rollback.\n' "$target" "$source_ref"
}

cmd_help() {
    cat <<'EOF'
Home Assistant config Git helpers:
  ha-config-bootstrap              Initialize /config Git tracking and AGENTS.md
  ha-config-status                 Show Git status for /config
  ha-config-diff                   Show YAML changes, excluding secrets.yaml
  ha-config-checkpoint [message]   Commit changed YAML files, excluding secrets.yaml
  ha-config-restore <file> [ref]   Restore a YAML file from ref, default HEAD~1
EOF
}

main() {
    local invoked
    local command
    invoked="$(basename "$0")"
    case "$invoked" in
        ha-config-bootstrap|ha-config-status|ha-config-diff|ha-config-checkpoint|ha-config-restore)
            command="${invoked#ha-config-}"
            ;;
        *)
            command="${1:-help}"
            if [ "$#" -gt 0 ]; then
                shift
            fi
            ;;
    esac

    case "$command" in
        bootstrap) cmd_bootstrap "$@" ;;
        status) cmd_status "$@" ;;
        diff) cmd_diff "$@" ;;
        checkpoint) cmd_checkpoint "$@" ;;
        restore) cmd_restore "$@" ;;
        help|-h|--help) cmd_help ;;
        *) die "unknown command: $command" ;;
    esac
}

main "$@"
