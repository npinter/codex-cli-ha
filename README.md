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
- ChatGPT login helper with localhost callback forwarding for Home Assistant ingress.

## Image Paste

Paste or drop an image anywhere on the Codex CLI panel. The add-on saves it inside the container and shows the saved path. You can insert the path into the terminal, or use the `Run with image` prompt to start/resume Codex with that image attached.

Codex CLI currently attaches images through the CLI `--image` option. A browser terminal cannot change Codex internals while an already-running TUI is waiting for input, so this add-on implements the reliable part natively in the terminal page: clipboard image capture, upload, persistent storage, and terminal command insertion.

## Authentication

The panel includes a login helper. If ChatGPT OAuth redirects your browser to a failed `http://localhost:...` page, paste that full callback URL into the helper. The add-on forwards it from inside the container to Codex's local OAuth listener.

You can also use an API key in the add-on configuration.
