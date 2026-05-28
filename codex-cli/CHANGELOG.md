# Changelog

## Unreleased

- Added Git-backed Home Assistant YAML checkpoints with `/config/AGENTS.md` instructions and helper commands.
- Added `ripgrep` so the container includes the `rg` search command.
- Added PyYAML support for Python YAML parsing inside the container.

## 0.1.26 - 2026-05-28

- Added an image upload dialog for browser and Home Assistant companion app use.
- Kept keyboard image paste shortcuts and drag/drop image attachment support.
- Added line-by-line terminal scroll controls for finer mobile navigation.
- Added a companion-app mobile input bar to avoid keyboard suggestion text being sent directly to xterm.
- Made the companion-app Send action return to the live terminal prompt before sending the line.
- Made dev add-on rebuilds refresh the Codex CLI install layer instead of reusing an older cached version.
- Replaced rate limit text with remaining-capacity bars for the 5h and weekly limits.
- Tightened the rate-limit bar layout and color-coded remaining capacity from red to green.
