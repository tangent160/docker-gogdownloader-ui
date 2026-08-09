# docker-gogdownloader-ui

A mobile-first web UI for [RikudouSage/GogDownloader](https://github.com/RikudouSage/GogDownloader),
packaged as a Docker container and designed for the Unraid Docker UI.

The container does not reimplement any GOG logic. It ships the upstream PHP CLI
(a git submodule pinned to a release tag), drives it as a child process, and
reads the CLI's own SQLite database directly for the library — the same approach
as the Android front-end this UI is modelled on.

## Features

- **GOG login in the browser** — code login (recommended) or email/password.
- **Library** — a grid of covers, searchable and sortable by title, recently
  added, or total size.
- **Per-game selection** — pick exactly which installers, patches and extras you
  want. Platform and language chips narrow multi-variant games.
- **Live progress** — jobs stream to every open tab over server-sent events,
  with the CLI's own output available per job.
- **Sync modes** — incremental, full, search-only, and clear-and-resync.
- **Cloud saves** and **extras-only** downloads.
- **Backup** — export and import the gog-downloader database (your login token
  and whole synced library in one file) to migrate between installs.
- **Optional login** for the web UI itself.

## Quick start

### Unraid

Install from Community Applications, or add the template manually from
[`unraid/gogdownloader-ui.xml`](unraid/gogdownloader-ui.xml).

1. Point **Downloads** at the share where you want your games stored.
2. Leave **Config** on the default appdata path — it holds the gog-downloader
   database and must persist across restarts.
3. Start the container, open the WebUI, and log in to GOG with a code.
4. Run a sync, then download whatever you like.

Set **WebUI Username** and **WebUI Password** if the container is reachable from
outside your LAN. The session is a live GOG login.

### Docker Compose

```bash
git clone --recurse-submodules https://github.com/tangent160/docker-gogdownloader-ui.git
```

```bash
docker compose up -d
```

Then open <http://localhost:8080>.

### Building the image directly

```bash
git submodule update --init
```

```bash
docker build -t gogdownloader-ui .
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBUI_USERNAME` | *(empty)* | Web UI username. Both this and the password must be set for the login to be enforced. |
| `WEBUI_PASSWORD` | *(empty)* | Web UI password. |
| `WEBUI_PORT` | `8080` | Port inside the container. |
| `WEBUI_COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS via a reverse proxy. |
| `COVER_ART` | `true` | Fetch cover art from GOG's public product API and cache it under `/config`. |
| `PUID` / `PGID` | `99` / `100` | Ownership of downloaded files (Unraid's `nobody:users`). |
| `UMASK` | `022` | File mode mask for downloads. |
| `TZ` | `Etc/UTC` | Container timezone. |

| Volume | Purpose |
| --- | --- |
| `/config` | gog-downloader's SQLite database (login token + synced library), UI settings, cover cache. **Must persist.** |
| `/downloads` | Downloaded installers, patches and extras. |
| `/saves` | Downloaded GOG cloud saves. |

## Running the CLI directly

Any arguments passed to the container run instead of the web server, so the
bundled CLI is available for scripting against the same database:

```bash
docker exec gogdownloader-ui gog-downloader games
```

## Updating the bundled CLI

`vendor/GogDownloader` is a submodule pinned to a release tag — currently
**v1.15.1**. To move it:

```bash
git -C vendor/GogDownloader fetch --tags && git -C vendor/GogDownloader checkout <tag>
```

Commit the new submodule revision and rebuild the image.

## Security notes

- The UI holds a live GOG session. Do not expose it to the internet without the
  built-in login, and preferably a reverse proxy with TLS.
- Cover art is the only outbound request the UI makes on its own; set
  `COVER_ART=false` for a text-only library with no such calls.
- Only one CLI process runs at a time. gog-downloader owns the database in
  `/config`, so jobs are queued and run strictly one after another.

## License

MIT (this project). The bundled [GogDownloader](https://github.com/RikudouSage/GogDownloader)
is MIT.
