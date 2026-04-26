# Codex CLI for Home Assistant

Home Assistant add-on repository for running OpenAI Codex CLI from an ingress panel.

## Installation

1. In Home Assistant, go to Settings -> Add-ons -> Add-on Store.
2. Open the three-dot menu, then Repositories.
3. Add this repository URL: `https://github.com/npinter/codex-cli-ha`.
4. Install the `Codex CLI` add-on.

## What This Add-On Provides

- Persistent browser terminal backed by `tmux`.
- Codex CLI installed during the Docker build.
- Native browser image paste/drop support in the terminal page.
- Pasted images are saved under `/data/codex-images`.
- The terminal page can insert the saved image path or a generated `codex-image` command.
- `auth.json` upload helper for copying an existing Codex login into the add-on.
- Header actions for Codex rate limits, image paste, Home Assistant YAML reload, and Home Assistant restart.
- Docker build pins Codex CLI to `@openai/codex@0.125.0`.

## Image Paste

Paste or drop an image anywhere on the Codex CLI panel. The add-on captures the browser paste event before xterm, saves the image inside the container, and inserts the saved path into the terminal. `Alt+V` / the paste icon uses the browser Clipboard API when available; if the browser blocks it, the page arms a paste target and asks you to paste with `Ctrl+V` or the browser paste action.

Codex CLI currently attaches images through the CLI `--image` option. A browser terminal cannot change Codex internals while an already-running TUI is waiting for input, so this add-on implements the reliable part natively in the terminal page: clipboard image capture, upload, persistent storage, and terminal command insertion.

## Authentication

The panel includes an `auth.json` upload helper. On a logged-in device, Codex usually stores this file at:

```text
~/.codex/auth.json
```

The add-on stores the uploaded file at:

```text
/data/home/.codex/auth.json
```

Uploading `auth.json` restarts the persistent terminal session so Codex picks up the new credentials.

You can also use an API key in the add-on configuration.

## Home Assistant Actions

`Reload YAML` calls Home Assistant's `homeassistant.reload_all` action through the Supervisor proxy. `Restart HA` restarts Home Assistant Core through the Supervisor API.
