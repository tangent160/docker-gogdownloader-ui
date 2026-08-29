# docker-gogdownloader-ui

This project is a mobile-first web UI for
[RikudouSage/GogDownloader](https://github.com/RikudouSage/GogDownloader). It is
packaged as a Docker container and designed for the Unraid Docker UI.

The container does not write its own GOG logic. It runs the upstream PHP CLI:
the released `gog-downloader` phar, which the container downloads into
`/config/cli` on the first start. It drives the phar as a child process, and it
reads the SQLite database of the CLI directly for the library. This is the same
method as the Android front-end that this UI is modelled on.

## Features

- **GOG login in the browser** — code login (recommended) or email and
  password.
- **Library** — a grid of covers. You can search it, and you can sort it by
  title, by recently added, or by total size.
- **Selection per game** — select exactly which installers, patches and extras
  you want. Platform chips and language chips narrow a game that has more than
  one variant.
- **Live progress** — jobs stream to each open tab with server-sent events. The
  output of the CLI is available for each job.
- **Sync modes** — incremental, full, search-only, and clear-and-resync.
- **Cloud saves** and **extras-only** downloads.
- **Backup** — export and import the database of gog-downloader to move between
  installations. The file holds your login token and your full synced library.
- **Optional login** for the web UI itself.

## Quick start

### Unraid

Install from Community Applications, or add the template manually from
[`unraid/gogdownloader-ui.xml`](unraid/gogdownloader-ui.xml).

1. Point **Downloads** at the share where you want your games.
2. Leave **Config** on the default appdata path. It holds the database of
   gog-downloader, and it must stay across a restart.
3. Start the container, open the WebUI, and log in to GOG with a code.
4. Run a sync. Then download what you want.

If the container is reachable from outside your LAN, set **WebUI Username** and
**WebUI Password**. The session is a live GOG login.

### Docker Compose

```bash
git clone https://github.com/tangent160/docker-gogdownloader-ui.git
```

```bash
docker compose up -d
```

Then open <http://localhost:8080>.

### Building the image directly

```bash
docker build -t gogdownloader-ui .
```

The image holds only the web UI and a PHP runtime. The container gets the CLI on
the first start, thus the build itself needs no access to GitHub.

A local build leaves the commit and the build date empty in **Settings →
About**. CI fills them in. If you want them, give them yourself:

```bash
docker build -t gogdownloader-ui --build-arg GOGUI_COMMIT="$(git rev-parse HEAD)" --build-arg GOGUI_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBUI_USERNAME` | *(empty)* | Web UI username. The login is enforced only if you set this variable and the password. |
| `WEBUI_PASSWORD` | *(empty)* | Web UI password. |
| `WEBUI_PORT` | `8080` | Port inside the container. |
| `WEBUI_COOKIE_SECURE` | `false` | Set it to `true` when a reverse proxy serves the UI over HTTPS. |
| `COVER_ART` | `true` | Get cover art from the public product API of GOG and cache it under `/config`. |
| `PUID` / `PGID` | `99` / `100` | Owner of the downloaded files (`nobody:users` on Unraid). |
| `UMASK` | `022` | File mode mask for downloads. |
| `TZ` | `Etc/UTC` | Time zone of the container. |

| Volume | Purpose |
| --- | --- |
| `/config` | The SQLite database of gog-downloader (login token and synced library), the UI settings, and the cover cache. **It must persist.** |
| `/downloads` | Downloaded installers, patches and extras. |
| `/saves` | Downloaded GOG cloud saves. |

## Running the CLI directly

Arguments that you give to the container run in place of the web server. Thus
you can use the CLI in a script against the same database:

```bash
docker exec gogdownloader-ui gog-downloader games
```

## Updating the bundled CLI

On the first start the container downloads the `gog-downloader` phar from the
upstream GitHub release into `/config/cli/gog-downloader-<tag>.phar`. It uses
that file again on each later start. Only the first start needs internet access
for the CLI itself. The container makes sure that the checksum of the built-in
version is correct after the download.

The version in use is `GOGDL_PINNED_VERSION` in the `Dockerfile`, at this time
**v1.15.1**. To run a different release without a rebuild, set
`GOG_DOWNLOADER_VERSION`. You can also set `GOG_DOWNLOADER_SHA256`, because the
built-in checksum describes only the built-in version:

```bash
curl -fsSL https://github.com/RikudouSage/GogDownloader/releases/download/<tag>/gog-downloader | sha256sum
```

In the Unraid template these are the advanced **CLI Version** and **CLI
Checksum** fields.

You can also change the version from the UI. **Settings → gog-downloader →
Check for versions** lists each upstream release that has a phar. It downloads
the release that you select into `/config/cli`, and it changes to it. The
container keeps your selection across a restart, and versions that you
installed before stay on disk. Thus a change back to one of them needs no
network. If a release does not start in the container, the container rejects it
and keeps the version that runs. Some older releases do not run on the PHP of
the container. To change the default for all users, bump
`GOGDL_PINNED_VERSION` and `GOGDL_PINNED_SHA256` in the `Dockerfile` and push a
new image.

## Versioning and releases

The image has its own version, which is not the version of the CLI that it
drives. **Settings → About** shows the version of the UI, the commit and build
date of the image, and the version of the CLI in use. Give these values when you
report a problem. `GET /api/status` returns the same values as `appVersion`,
`appCommit` and `appBuildDate`.

Versions are [semantic](https://semver.org/):

- Major for a breaking change to the environment variables, the volumes or the
  API of the container.
- Minor for new function.
- Patch for fixes.

`CHANGELOG.md` records each change.

While the version is less than 1.0, the contract of the container is not
settled. A minor bump (`0.1` → `0.2`) can change environment variables, volumes
or the API. Thus read the changelog before you update.

Published image tags:

| Tag | Moves | Use it for |
| --- | --- | --- |
| `latest` | each tagged release | tracking releases, the Unraid default |
| `0.1` | each patch release in that line | staying current in one line |
| `0.1.0` | never | pinning exactly |

To make a release:

1. Make sure that `README.md` and `CLAUDE.md` describe the current behavior.
2. Move the `Unreleased` entries in `CHANGELOG.md` under a new
   `## [x.y.z] - YYYY-MM-DD` heading. Leave an empty `Unreleased` above it.
3. Bump `__version__` in `app/gogui/__init__.py` to the same number.
4. Commit. Then tag `vx.y.z` and push the commit and the tag.

The push of a `v*` tag is the only thing that builds an image. Normal pushes to
`main` and pull requests run no workflow. Thus `latest` can never move ahead of
a release. The tag run fails if the tag does not agree with `__version__`. Then
it publishes the image tags and a GitHub Release. The body of that release is
that changelog section.

Nothing builds before the tag. Thus a commit that breaks the `Dockerfile` is
found only at release time. If you touched it, build it locally first.

## Security notes

- The UI holds a live GOG session. Do not make it available on the internet
  without the built-in login, and preferably with a reverse proxy that has TLS.
- Cover art is the only outbound request that the UI makes on its own. Set
  `COVER_ART=false` for a text-only library that makes no such request.
- Only one CLI process runs at a time. gog-downloader owns the database in
  `/config`, thus jobs are queued and run strictly one after the other.

## License

This project is under the MIT license. See [LICENSE.md](LICENSE.md).

The CLI that the container downloads,
[GogDownloader](https://github.com/RikudouSage/GogDownloader), is also under the
MIT license. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) lists every other
component in the image and its license.
