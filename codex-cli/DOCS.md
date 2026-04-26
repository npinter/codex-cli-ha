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
codex_image_dir: /tmp/codex-images-tmp
codex_max_upload_mb: 25
codex_image_cleanup_seconds: 60
terminal_font_size: 14
openai_api_key: ""
openai_base_url: ""
openai_organization: ""
```

## Image Paste

Paste or drop an image anywhere in the panel. The add-on captures browser paste events before xterm, saves the image under `codex_image_dir`, and shows a small preview with an `Insert Path` action.

`Alt+V` / the paste icon uses the browser Clipboard API when available and then inserts the image path directly. If Home Assistant ingress or the browser blocks programmatic clipboard access, use `Alt+V -> Ctrl+V -> Insert Path`.

If the browser provides a clipboard image in a format Codex does not normally accept, such as BMP or TIFF, the page converts it to PNG before upload.

Image uploads use multipart file bodies, with the older base64 JSON upload path retained as a fallback.

Temporary image files are deleted after `codex_image_cleanup_seconds` once `Insert Path` is pressed.

Existing add-on configs that still use the old `/data/codex-images` default are automatically mapped to `/tmp/codex-images-tmp`.

The image panel only contains `Insert Path` and `Close`; it does not include a prompt box or auto-run action.

The container installs `bubblewrap`, `xvfb`, and `xclip` for Codex sandboxing and the clipboard bridge.

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

The upload uses a multipart file body, with the older base64 JSON path retained as a fallback.

Device-code login can still be run inside the terminal if needed. API-key auth can be configured with `openai_api_key`.

## Header Actions

- `Paste Image`: Reads an image from the browser clipboard and opens the image preview panel.
- `Reload YAML`: Calls Home Assistant's `homeassistant.reload_all` action through the Supervisor proxy.
- `Restart HA`: Restarts Home Assistant Core through the Supervisor API.
- `Rate limit`: Polls Codex app-server's `account/rateLimits/read` method every 60 seconds when credentials are available.

## Mobile Controls

The control strip below the header provides runtime terminal text scaling, arrow up/down keys for command history, and tmux-backed terminal scrollback buttons. Text size changes are stored in the browser, so the Home Assistant companion app can use a different size than desktop.

The scroll buttons control tmux copy-mode because Codex runs inside a persistent tmux session. Press the bottom scroll button, or start typing, to return to the live prompt after scrolling back.

## Codex CLI Version

The Docker build installs Codex CLI with `npm install -g @openai/codex`.

## Persistence

The terminal is backed by `tmux` using `codex_session_name`, so switching away from the Home Assistant panel does not kill the Codex session. Add-on restarts still restart the container, but Codex can resume previous sessions.

## Credits

Codex icon source: [Lobe Icons](https://github.com/lobehub/lobe-icons/blob/master/packages/static-png/dark/codex.png).
