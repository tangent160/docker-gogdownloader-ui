# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the version of the **web UI and image**, not of the upstream
gog-downloader CLI — that one is chosen per container and shown separately in
Settings.

## [Unreleased]

## [0.1.0] - 2026-08-09

First public release. The version stays below 1.0 while the container's
contract — environment variables, volumes and the API — can still change
without a major bump.

### Added
- Web UI for the gog-downloader CLI: GOG code and password login, cover-art
  library grid with search and sorting, per-game selection of installers,
  patches and extras with platform/language chips, live job progress over
  server-sent events, cloud saves, extras-only downloads, and optional login
  for the UI itself.
- Serialised job queue so only one CLI process ever touches the database.
- Sync modes: incremental, full, search-only and clear-and-resync, plus
  targeted `--updated-only` and `--search` runs from Settings.
- Database backup export and import.
- The CLI phar is downloaded at container start rather than baked into the
  image, and any upstream release can be installed and switched to from
  Settings.
- Shift-click range selection in the installer file list.
- Unraid Community Applications template.
- Version, commit and build date are stamped into the image and shown in an
  About card in Settings, and returned from `/api/status`.
- This changelog, and a release workflow that publishes a GitHub Release from
  the matching section on a `v*` tag; CI refuses a `v*` tag whose number does
  not match `__version__`.
