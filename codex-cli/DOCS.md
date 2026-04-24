# Codex CLI

`Codex CLI` runs OpenAI Codex inside a Home Assistant ingress panel.

## Configuration

```yaml
auto_launch_codex: true
codex_workspace: /config
codex_session_name: codex-cli
codex_approval_policy: on-request
codex_sandbox: workspace-write
codex_model: ""
codex_image_dir: /data/codex-images
codex_max_upload_mb: 25
terminal_font_size: 14
openai_api_key: ""
openai_base_url: ""
openai_organization: ""
```

## Image Paste

Paste or drop an image anywhere in the panel. The add-on saves it under `codex_image_dir`, then inserts the saved path into the terminal.

The image panel also has `Run with Image`. This inserts:

```bash
codex-image /data/codex-images/example.png "your prompt"
```

`codex-image` resumes the latest Codex session with `--image`. If no previous session exists, it starts a new one.

## Login

Use `Upload auth.json` in the top bar. On a logged-in device, Codex usually stores this file at:

```text
~/.codex/auth.json
```

The add-on stores the uploaded file at:

```text
/data/home/.codex/auth.json
```

After uploading, restart Codex in the terminal if it was already running.

Device-code login is also available. API-key auth can be configured with `openai_api_key`.

## Persistence

The terminal is backed by `tmux` using `codex_session_name`, so switching away from the Home Assistant panel does not kill the Codex session. Add-on restarts still restart the container, but Codex can resume previous sessions.
