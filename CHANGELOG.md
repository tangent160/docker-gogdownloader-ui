# Changelog

This file records each important change to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the version of the **web UI and the image**. It is not the version of
the upstream gog-downloader CLI. You select that version for each container,
and Settings shows it separately.

## [Unreleased]

## [0.2.0] - 2026-10-07

### Added
- A new design for the whole UI. The library is a grid of covers under one app
  bar with search, Sync and Settings. A game, the sync options and Settings open
  in a panel at the right edge, over the library. The queue is a bar at the
  bottom that opens into a list of jobs. The layout works at phone, tablet and
  desktop widths.
- A dark mode, and nine accent colours in **Settings → Appearance**. Sage is the
  default. The choice is stored on the server, thus every browser shows the
  same look. The moon or sun button in the app bar changes between light and
  dark.
- A game without a cover image shows a coloured block with its initials.
- Each game card shows its platforms as W, M and L tags.
- The library sort has a direction. Select the active sort again to reverse it.
- Clear and resync, a database import and the removal of a CLI version ask for
  confirmation in a dialog that names the action.
- `THIRD-PARTY-NOTICES.md` lists each third-party component in the image and
  its license.

### Changed
- The UI uses the system fonts of the device. It loads no web fonts.
- The "Recently added" sort is now called "Date added".
- Settings sections are in A to Z order, with About last.
- The partial-library warning changes only when a sync succeeds. A sync that
  fails or that you cancel leaves it as it was.
- A search sync marks the library as incomplete only when the library was empty
  or already incomplete. A search sync on a complete library refreshes the
  matching games, and the library stays complete. A "Changed games" sync also
  gets every missing game, thus it clears the warning.
- The cloud saves job is now called "Download cloud saves".
- Images are built and published only from a `v*` tag. Pushes to `main` and
  pull requests no longer run a workflow. Thus `latest` now tracks the newest
  release, not the newest commit.
- The overview of the Unraid template points at Settings > About for the
  version details to put in a bug report.

### Removed
- The "Library updates" card in Settings. The sync panel does the same work:
  "Changed games" is the old "Update changed games", and "Search by title" on a
  complete library is the old "Update matching games". The `update_search` sync
  mode of the internal API is gone.

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
