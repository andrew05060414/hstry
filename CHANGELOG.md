# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This repository is a personal fork of [byteowlz/hstry](https://github.com/byteowlz/hstry).
Upstream last consumed here is `v0.5.21` (`c8923f1`). Upstream `v0.5.22` (TUI overhaul, cursor/web sync harden) is not merged; it may land later.

## [Unreleased]

## [1.0.0] - 2026-08-21

Fork 1.0: local agent archive + NAS hub/satellite. Canonical remote is `andrew05060414/hstry`.

### Added

- Windows as a first-class collector: Cursor Composer import, Node adapter runtime, `scripts/update-adapters.ps1`.
- Adapters: `qclaw` (QClaw / OpenClaw), `workbuddy`, `antigravity` (Gemini CLI sessions under `~/.gemini/tmp`, CLI-only).
- `sync.device_id` namespaces satellite pushes (`arknights` / `macbook`) so Windows and Mac do not overwrite each other on the hub.
- Remote sync fixes for hub paths that contain spaces, Windows SCP, and refreshing source metadata on repeat push.
- Docs for personal NAS hub / Mac satellite setup (fork-only paths).

### Changed

- Adapter canonical-root checks normalize Windows path separators.
- Ignore local adapter test artifacts (`dry-run*.txt`, `parse-limit*.json`).

### Not in 1.0

- Upstream TUI overhaul (Resume / grouping / images) — current three-pane TUI remains.
- Live ChatGPT / Gemini / Copilot web ingest (export adapters already exist for takeout files).
- Antigravity IDE 2.0 session store.

## [0.5.16] - 2026-04-26

### Changed

- **TUI left pane**: Group source entries by adapter instead of individual source ID. One entry per adapter (e.g., one `pi`, one `claude-code`) even when multiple source IDs exist for the same adapter.
- **`hstry list`**: Automatically deduplicate conversations across sources by `external_id`/`readable_id`/`platform_id`. Canonical source IDs (e.g. `pi`) take precedence over `import-pi` style IDs.
- **`hstry import`**: Reuse existing source when importing to a path that already has one, or default to canonical adapter ID instead of `import-<adapter>`. Prevents duplicate source creation.
- **Startup performance**: Replace `COUNT(*)` scans on FTS5 tables with `SELECT 1 LIMIT 1` probes during DB init. Eliminates multi-second startup latency on large databases.

## [0.5.15] - 2026-01-28

### Added

- (previous releases)
