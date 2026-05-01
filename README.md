# Codex CLI for Home Assistant

Home Assistant add-on repository for running OpenAI Codex CLI from an ingress panel.

![Codex CLI for Home Assistant screenshot](docs/codex-cli-ha.png)

## Installation

Click the button below to add this repository to Home Assistant:

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fnpinter%2Fcodex-cli-ha)

Or add it manually:

1. In Home Assistant, go to Settings -> Add-ons -> Add-on Store.
2. Open the three-dot menu, then Repositories.
3. Add this repository URL: `https://github.com/npinter/codex-cli-ha`.
4. Install the `Codex CLI` add-on.

## What This Add-On Provides

- Persistent browser terminal backed by `tmux`.
- Codex CLI installed during the Docker build.
- Native browser image paste/drop support with a small preview panel.
- Pasted images are saved under `/tmp/codex-images-tmp` and cleaned up after `Insert Path`.
- The terminal page inserts the saved image path with `Insert Path`, or directly from `Alt+V` when browser clipboard access is allowed.
- Browser sign-in, device-code sign-in, and `auth.json` upload helpers for Codex authentication.
- Header actions for Codex rate limits, image paste, Home Assistant YAML reload, and Home Assistant restart.
- Mobile-friendly terminal controls for text size, arrow up/down keys, and tmux-backed terminal scrollback.
- Docker build uses npm only in a build stage, then ships a reduced runtime image without npm, jq, curl, git, xclip, or Xvfb.

## Image Paste

Paste or drop an image anywhere on the Codex CLI panel. The add-on captures the browser paste event before xterm, saves the image inside the container, and opens a small preview panel. Press `Insert Path` to place the saved image path into Codex.

`Alt+V` / the paste icon uses the browser Clipboard API when available and then inserts the image path directly. If the browser blocks clipboard reads, use `Alt+V -> Ctrl+V -> Insert Path`.

## Authentication

The panel can start Codex's browser sign-in flow directly. If your browser or Home Assistant ingress blocks that flow, use the device-code option from the same authentication panel.

The panel also includes an `auth.json` upload helper. On a logged-in device, Codex usually stores this file at:

```text
~/.codex/auth.json
```

The add-on stores the uploaded file at:

```text
/data/home/.codex/auth.json
```

Uploading `auth.json` restarts the persistent terminal session so Codex picks up the new credentials.

The upload uses a multipart file body, with the older base64 JSON path retained as a fallback.

You can also use an API key in the add-on configuration.

## Security

The add-on is intended to be reached through Home Assistant ingress. Its container service allows only loopback and the Supervisor ingress address by default, and it no longer publishes the terminal port directly on the host. The Docker image uses a minimal Alpine runtime and keeps npm/build tooling out of the final image.

This is a high-trust add-on: Codex can edit files in the configured workspace, and the add-on uses the same Home Assistant API/auth permission class as comparable Claude Code terminal add-ons. The Supervisor token is kept in the Python wrapper process and is stripped from Codex/tmux child processes.

## Home Assistant Actions

`Reload YAML` calls Home Assistant's `homeassistant.reload_all` action through the Supervisor proxy. `Restart HA` restarts Home Assistant Core through the Supervisor API.

## Credits

Codex icon source: [Lobe Icons](https://github.com/lobehub/lobe-icons/blob/master/packages/static-png/dark/codex.png).
