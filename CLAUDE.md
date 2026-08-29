# CLAUDE.md

This file gives guidance to Claude Code for work in this repository.

## What this is

This project is a Docker image. The image gives a web UI for the upstream
[RikudouSage/GogDownloader](https://github.com/RikudouSage/GogDownloader) PHP
CLI. The target platform is Unraid.

The project does not write its own GOG logic. It runs the CLI as a child
process. It reads the SQLite database of the CLI for all data that the UI
shows.

- Backend: Python 3 and FastAPI (`app/gogui/`). Uvicorn serves it.
- Frontend: plain JS and CSS in `app/gogui/static/`. There is no build step.
- CLI: the upstream release phar.

The phar is **not** in the image and not in the repository. On the first start,
the entrypoint downloads it into `/config/cli`. `GOGDL_PINNED_VERSION` and
`GOGDL_PINNED_SHA256` pin the version. Each container can override the version
with `GOG_DOWNLOADER_VERSION` and `GOG_DOWNLOADER_SHA256`.
`/app/gog-downloader` is a shim that runs `php "$GOG_DOWNLOADER_PHAR"`. The
entrypoint exports this variable.

The Settings screen can install any other upstream release into the same
directory (`clireleases.py`). The selected tag is in the `cli_version` setting.
`cli.py` sends the path of that phar down as `GOG_DOWNLOADER_PHAR`. Thus the
copy of the entrypoint is only the fallback. A version change needs an idle
queue. It also runs `php <phar> --version` before it keeps a download. Some
releases before 1.14 do not run on a modern PHP, and they must not replace a
good phar.

## Layout

| Path | Purpose |
| --- | --- |
| `app/gogui/main.py` | FastAPI routes. HTTP is defined only here. |
| `app/gogui/cli.py` | The single wrapper around the CLI process. |
| `app/gogui/jobs.py` | Serial job queue and SSE fan-out. Builds all CLI arguments. |
| `app/gogui/db.py` | Read-only access to the SQLite file of gog-downloader. |
| `app/gogui/config.py` | Paths from the environment, and the settings store of the UI. |
| `app/gogui/clireleases.py` | Lists upstream CLI releases. Installs and caches phars. |
| `app/gogui/filters.py` | Maps a DB value to a CLI `--os` or `--language` argument. |
| `docker/entrypoint.sh` | Gets and caches the CLI phar, drops to PUID/PGID, then starts uvicorn. |
| `unraid/` | Community Applications template. |
| `THIRD-PARTY-NOTICES.md` | Licenses of the components in the image. Update it when a dependency in `app/requirements.txt` or the `Dockerfile` changes. |

## Rules that are load-bearing

- **One CLI process at a time.** gog-downloader owns the database in `/config`.
  Two runs at the same time corrupt it. All work goes through `JobQueue`, which
  drains one job at a time. Endpoints that touch the database outside the queue
  (`code-login`, backup import and export) call `_require_idle()` first.
- **The UI never reads CLI output for data.** It reads that output only for
  progress and for errors. Game data comes from `db.py`. Queries open the file
  read-only with `immutable=1`. Thus a handle of the UI never blocks the CLI.
- **Progress bars redraw with a bare `\r`.** Thus `cli.py` splits output on
  `\r` and on `\n`. If it did not, no output would show until the process
  stops.
- **The last output line of Symfony is of no use after a failure.** That line
  is the usage synopsis. `Result.error_message` gets the true message.

## CLI semantics that matter

- The game filter for `download` is `--only=<exact title>`. It is
  case-insensitive and exact, and it accepts no regex. Files that the user does
  not select are excluded one file at a time with `--skip-download=<name>`.
- The installer `name` is **not** unique. GOG uses one name for more than one
  platform variant and language variant. `--skip-download` matches on the name,
  so it skips all variants of a name or none of them. Thus the UI groups the
  variants with the same name into one row that the user can select, and it
  narrows the variants with `--os` and `--language`.
- `--os` accepts `windows`, `mac` or `linux`. `--language` accepts enum *codes*
  (`en`, not `English`). A value that is not valid stops the full run. Thus
  `filters.py` maps DB values to valid arguments, and it removes a full filter
  dimension if one value has no valid map.
- `--os` and `--language` filter the installer list of each game. Then games
  with no remaining installers are removed **together with their extras**.
  Never send these arguments on an extras-only (`--no-games`) job.
- `--chunk-size` cannot be less than 5. `config.SETTING_BOUNDS` clamps it.
- `update-database` skips games that are hidden on GOG, unless
  `--include-hidden` is given. The setting changes only future syncs. If you
  set it off, hidden games that are already synced stay in the database.
- `update-database --search=<term>` refreshes only the games that match. The
  `update` alias is the same command. The sync screen shows this as the
  `search` mode, which marks the library partial. Settings shows the same flag
  as the `update_search` mode, to refresh games that are already synced. This
  mode leaves `sync_mode` unchanged on purpose. Settings groups it with an
  `--updated-only` run (the `incremental` mode, the same as on the sync screen)
  in one "Library updates" card, with `.subcard` blocks.
- `update-database --updated-only` also gets every owned game that is *missing*
  from the local database. Thus it is a safe default. But after a `--search`
  sync the library is partial, and the sync screen gives a warning about this.
- GOG login codes are single-use, and they expire in some minutes. A login
  failure is usually the result of a stale code.

## Frontend conventions

`app.js` has one state object, a hash router, and render functions. There is no
framework. Screens are rendered through `renderChrome(heading, content, opts)`,
which owns the app bar, the back button and the tab bar. A screen must not set
the heading itself. All strings from the user go through `escapeHtml`. Async
click handlers are wrapped in `guard()`, thus a failure becomes a toast.

The CSS is mobile-first. The base rules are the phone layout. Only two media
queries make it wider: 720px makes the grid wider, and 960px moves the tab bar
to the side.

## Development

There is no test runner in the repository. To use the app without a GOG
account, point `GOG_DOWNLOADER_BIN` at a stub script. Then seed a database with
the schema from `src/Migration/` of the upstream project:

```bash
CONFIG_DIRECTORY=/tmp/cfg DOWNLOAD_DIRECTORY=/tmp/dl SAVES_DIRECTORY=/tmp/sv \
  GOG_DOWNLOADER_BIN=/tmp/stub.sh uvicorn gogui.main:app --port 8099
```

## Versioning

The version of the image is `__version__` in `app/gogui/__init__.py`. This is
the only source of truth. `docker.yml` reads it and fails a `v*` tag that does
not agree with it. Then it publishes the semver image tags and a GitHub Release
built from the section of `CHANGELOG.md` for that version.

The commit and the build date come to the app as the `GOGUI_COMMIT` and
`GOGUI_BUILD_DATE` build arguments. These are empty outside CI. The app shows
them through `config.commit` and `config.build_date`, `/api/status` and the
About card in Settings.

Put each change that the user can see under `## [Unreleased]` in `CHANGELOG.md`
when you make it, not at release time.

### Bumping the version

Documents first, version last. The version bump is the step that makes a state
releasable, thus nothing must be stale when it occurs. Do these steps in order.

1. **Decide the number.** Use semver against the *contract of the container*.
   Use a major bump for a breaking change to the environment variables, the
   volumes or the API. Use a minor bump for new function. Use a patch bump for
   fixes only. If the change can reasonably be read in two ways, ask the user
   which number they want.
2. **Bring `CLAUDE.md` up to date.** Read the sections that touch the change
   again: the layout table, the load-bearing rules, and the CLI semantics.
   Correct all text that the change made wrong. A new file that carries a rule
   gets a row in the table.
3. **Bring `README.md` up to date.** Correct all content that the user can see:
   features, container settings, the table of environment variables, and the
   descriptions of the screenshots. A new setting or endpoint that is not in
   the README does not exist.
4. **Bring `CHANGELOG.md` up to date.** Every change since the last release
   that the user can see must be under `## [Unreleased]`. Compare `git log`
   against that section. Do not assume that the section is complete. Then
   change that heading to `## [x.y.z] - YYYY-MM-DD` with the date of today, and
   open a new empty `## [Unreleased]` above it.
5. **Bump `__version__`** in `app/gogui/__init__.py` to the same number. The
   tag check in `docker.yml` compares against exactly this string. Thus it must
   agree with the changelog heading and with the tag that follows.
6. **Make sure that the three documents agree** with each other and with the
   code. Also make sure that the changelog section for the new version says
   what you want the GitHub Release to say. It becomes the release body word
   for word.
7. **Stop, and ask the user to commit and push.** Never run `git add`, `git
   commit`, `git tag` or `git push` yourself. Leave all changes in the working
   tree. Summarize what changed. Then give the user the commands that they
   need:

   ```
   git add -A && git commit -m "Release vx.y.z"
   git tag vx.y.z && git push && git push origin vx.y.z
   ```

   The push of the tag starts the release, and it is the *only* thing that runs
   the workflow. A commit to `main` builds nothing, thus a broken `Dockerfile`
   shows itself only after the push of the tag. If you changed the Dockerfile,
   test it with a local `docker build` before step 7.

## Updating upstream

Bump `GOGDL_PINNED_VERSION` and `GOGDL_PINNED_SHA256` in the `Dockerfile`. To
get the checksum, run `curl -fsSL <release-url> | sha256sum`. Then push a new
image. Containers that exist get the new phar on their next start, and they
keep the old one in the cache beside it. Examine the upstream migrations for
changes to the schema, and the command help for new flags and renamed flags.
