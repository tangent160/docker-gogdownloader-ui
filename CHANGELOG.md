# Changelog

This file records each important change to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the version of the **web UI and the image**. It is not the version of
the upstream gog-downloader CLI. You select that version for each container,
and Settings shows it separately.

## [Unreleased]

### Added
- `THIRD-PARTY-NOTICES.md` lists each third-party component in the image and
  its license.

### Changed
- Images are built and published only from a `v*` tag. Pushes to `main` and
  pull requests no longer run a workflow. Thus `latest` now tracks the newest
  release, not the newest commit.
- The overview of the Unraid template points at Settings > About for the
  version details to put in a bug report.

### Fixed
- A GOG login, a backup import and a change of the CLI version can no longer
  overlap with a job that another tab starts while they run. They made sure
  that the queue was idle, but not that it stayed idle. Thus a second
  downloader process could start against the same database.
- The version on the status screen no longer starts a downloader process beside
  a job that runs. While a job runs, the version comes from a cache. The
  container fills that cache at startup. Thus a container that boots directly
  into a long download still shows its CLI version.
- A browser that falls behind the live job stream is now disconnected, thus it
  reconnects and syncs again. Before, it was dropped without a message. It
  showed frozen progress behind a connection that still looked good.
- Cover art is no longer given up permanently after a network failure. Only a
  true "no artwork" answer from GOG is remembered. If the image download of a
  cover failed, the cover is retried from the address that is already known,
  and the product API of GOG is not asked the same question again.
- The covers of a library are fetched in parallel, not one at a time. Thus the
  first render of a large library fills in much faster.
- Accented characters in job output are no longer corrupted when they fall on a
  read boundary.

## [0.1.0] - 2026-08-09

This is the first public release. The version stays less than 1.0 while the
contract of the container — the environment variables, the volumes and the API
— can still change without a major bump.

### Added
- A web UI for the gog-downloader CLI. It has GOG code login and password
  login, a library grid of cover art with search and sorting, selection of
  installers, patches and extras for each game with platform chips and language
  chips, live job progress with server-sent events, cloud saves, extras-only
  downloads, and an optional login for the UI itself.
- A serial job queue, thus only one CLI process touches the database.
- Sync modes: incremental, full, search-only and clear-and-resync. Settings can
  also run targeted `--updated-only` and `--search` jobs.
- Export and import of a database backup.
- The CLI phar is downloaded at container start. It is no longer part of the
  image. You can install any upstream release from Settings and change to it.
- Range selection with shift-click in the installer file list.
- An Unraid Community Applications template.
- The version, the commit and the build date are put into the image. An About
  card in Settings shows them, and `/api/status` returns them.
- This changelog, and a release workflow that publishes a GitHub Release from
  the matching section on a `v*` tag. CI rejects a `v*` tag whose number does
  not agree with `__version__`.
