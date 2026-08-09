# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A Docker image serving a web UI for the upstream
[RikudouSage/GogDownloader](https://github.com/RikudouSage/GogDownloader) PHP CLI,
targeted at Unraid. No GOG logic is reimplemented: the CLI is driven as a child
process and its own SQLite database is read directly for everything the UI shows.

- Backend: Python 3 / FastAPI (`app/gogui/`), served by uvicorn.
- Frontend: vanilla JS + CSS, no build step (`app/gogui/static/`).
- CLI: the upstream release phar. It is **not** in the image or the repo — the
  entrypoint downloads it into `/config/cli` on first start, pinned by
  `GOGDL_PINNED_VERSION` / `GOGDL_PINNED_SHA256` and overridable per-container
  with `GOG_DOWNLOADER_VERSION` / `GOG_DOWNLOADER_SHA256`. `/app/gog-downloader`
  is a shim that execs `php "$GOG_DOWNLOADER_PHAR"`, exported by the entrypoint.
  The Settings screen can install any other upstream release into the same
  directory (`clireleases.py`); the chosen tag lives in the `cli_version`
  setting and `cli.py` passes its path down as `GOG_DOWNLOADER_PHAR`, so the
  entrypoint's copy is only the fallback. Switching requires an idle queue and
  runs `php <phar> --version` before keeping a download — several pre-1.14
  releases are broken on modern PHP and must not replace a working phar.

## Layout

| Path | Purpose |
| --- | --- |
| `app/gogui/main.py` | FastAPI routes; the only place HTTP is defined. |
| `app/gogui/cli.py` | The single wrapper around the CLI process. |
| `app/gogui/jobs.py` | Serialised job queue + SSE fan-out; builds all CLI arguments. |
| `app/gogui/db.py` | Read-only access to gog-downloader's SQLite file. |
| `app/gogui/config.py` | Env-derived paths, and the UI's own settings store. |
| `app/gogui/clireleases.py` | Lists upstream CLI releases, installs/caches phars. |
| `app/gogui/filters.py` | DB value → CLI `--os`/`--language` argument mapping. |
| `docker/entrypoint.sh` | Fetches/caches the CLI phar, PUID/PGID drop, then starts uvicorn. |
| `unraid/` | Community Applications template. |

## Rules that are load-bearing

- **One CLI process at a time.** gog-downloader owns the database in `/config`;
  concurrent runs corrupt it. Everything goes through `JobQueue`, which drains
  one job at a time. Endpoints that touch the database outside the queue
  (`code-login`, backup import/export) call `_require_idle()` first.
- **The UI never parses CLI output for data** — only for progress and errors.
  Game data comes from `db.py`. Queries open the file read-only with
  `immutable=1` so the CLI is never blocked by a handle we hold.
- **Progress bars redraw with a bare `\r`**, so `cli.py` splits output on `\r`
  as well as `\n`; otherwise nothing surfaces until the process exits.
- **Symfony's last output line is useless on failure** (it is the usage
  synopsis). `Result.error_message` extracts the real message.

## CLI semantics that matter

- The game filter for `download` is `--only=<exact title>` — case-insensitive,
  exact, no regex. Unselected files are excluded per-file with `--skip-download=<name>`.
- Installer `name` is **not** unique: GOG reuses it across platform and language
  variants, and `--skip-download` matches on name, so it skips all variants of a
  name or none. The UI therefore groups same-named variants into one selectable
  row and narrows variants with `--os`/`--language` instead.
- `--os` takes `windows`/`mac`/`linux`; `--language` takes enum *codes* (`en`,
  not `English`). An invalid value aborts the whole run, so `filters.py` maps DB
  values to valid args and drops a filter dimension entirely if any value is
  unmappable.
- `--os`/`--language` filter each game's installer list, then games with zero
  remaining installers are dropped **including their extras** — never pass these
  on an extras-only (`--no-games`) job.
- `--chunk-size` cannot be below 5; `config.SETTING_BOUNDS` clamps it.
- `update-database` skips games hidden on GOG unless `--include-hidden` is
  passed. The setting only affects future syncs; turning it off never removes
  already-synced hidden games.
- `update-database --updated-only` also fetches every owned game *missing* from
  the local database, so it is a safe default — but after a `--search` sync the
  library is partial, which the sync screen warns about.
- GOG login codes are single-use and expire within minutes; login failures are
  usually stale codes.

## Frontend conventions

`app.js` is one state object, a hash router, and render functions — no
framework. Screens are rendered through `renderChrome(heading, content, opts)`,
which owns the app bar, the back button and the tab bar; a screen must not set
the heading itself. All user-supplied strings go through `escapeHtml`. Async
click handlers are wrapped in `guard()` so failures become a toast.

CSS is mobile-first: the base rules are the phone layout, and only two media
queries widen it (720px widens the grid, 960px moves the tab bar to the side).

## Development

There is no test runner in the repo. To exercise the app without a GOG account,
point `GOG_DOWNLOADER_BIN` at a stub script and seed a database with the schema
from upstream's `src/Migration/`:

```bash
CONFIG_DIRECTORY=/tmp/cfg DOWNLOAD_DIRECTORY=/tmp/dl SAVES_DIRECTORY=/tmp/sv \
  GOG_DOWNLOADER_BIN=/tmp/stub.sh uvicorn gogui.main:app --port 8099
```

## Updating upstream

Bump `GOGDL_PINNED_VERSION` and `GOGDL_PINNED_SHA256` in the `Dockerfile`
(`curl -fsSL <release-url> | sha256sum`) and push a new image; existing
containers fetch the new phar on their next start, keeping the old one cached
beside it. Check upstream's migrations for schema changes and the command help
for new or renamed flags.
