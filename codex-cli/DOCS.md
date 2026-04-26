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

Paste or drop an image anywhere in the panel, or press `Alt+V` / click `Paste Image`. The add-on reads the browser clipboard, saves the image under `codex_image_dir`, then inserts the saved path into the terminal. This prevents Codex CLI from trying to read a non-existent X11 clipboard inside the container.

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

After uploading, the add-on restarts the persistent terminal session so Codex picks up the new credentials.

Device-code login can still be run inside the terminal if needed. API-key auth can be configured with `openai_api_key`.

## Header Actions

- `Paste Image`: Reads an image from the browser clipboard and inserts the saved path into the terminal.
- `Reload YAML`: Calls Home Assistant's `homeassistant.reload_all` action through the Supervisor proxy.
- `Restart HA`: Restarts Home Assistant Core through the Supervisor API.
- `Rate limit`: Polls Codex app-server's `account/rateLimits/read` method every 60 seconds when credentials are available.

## Persistence

The terminal is backed by `tmux` using `codex_session_name`, so switching away from the Home Assistant panel does not kill the Codex session. Add-on restarts still restart the container, but Codex can resume previous sessions.
