#!/bin/sh
# Unraid convention: the container runs as root just long enough to fix
# ownership of the mounted volumes, then drops to PUID:PGID (99:100 = nobody:users
# on Unraid) so downloaded files land with the right owner on the array.
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-022}"
WEBUI_PORT="${WEBUI_PORT:-8080}"
CONFIG_DIRECTORY="${CONFIG_DIRECTORY:-/config}"
DOWNLOAD_DIRECTORY="${DOWNLOAD_DIRECTORY:-/downloads}"
SAVES_DIRECTORY="${SAVES_DIRECTORY:-/saves}"

umask "$UMASK"

# ---------------------------------------------------------------------------
# The CLI is not baked into the image: upstream publishes a self-contained phar
# per release, which we cache under /config so only the first start (and a
# version change) needs GitHub. The filename carries the version, so bumping
# GOG_DOWNLOADER_VERSION fetches alongside the old copy rather than over it.
# ---------------------------------------------------------------------------
GOGDL_CLI_DIR="${GOGDL_CLI_DIR:-${CONFIG_DIRECTORY}/cli}"
GOGDL_VERSION="${GOG_DOWNLOADER_VERSION:-${GOGDL_PINNED_VERSION:-}}"

if [ -z "$GOGDL_VERSION" ]; then
    echo "[gogui] no CLI version configured; set GOG_DOWNLOADER_VERSION" >&2
    exit 1
fi

# The pinned checksum only describes the pinned release. If the version was
# overridden without a matching GOG_DOWNLOADER_SHA256, there is nothing to
# verify against and we say so rather than failing on a mismatch.
GOGDL_SHA256="${GOG_DOWNLOADER_SHA256:-}"
if [ -z "$GOGDL_SHA256" ] && [ "$GOGDL_VERSION" = "${GOGDL_PINNED_VERSION:-}" ]; then
    GOGDL_SHA256="${GOGDL_PINNED_SHA256:-}"
fi

GOG_DOWNLOADER_PHAR="${GOGDL_CLI_DIR}/gog-downloader-${GOGDL_VERSION}.phar"
export GOG_DOWNLOADER_PHAR

fetch_cli() {
    url="https://github.com/RikudouSage/GogDownloader/releases/download/${GOGDL_VERSION}/gog-downloader"
    mkdir -p "$GOGDL_CLI_DIR"
    # Not "$$": that is 1 in every container, so two containers sharing this
    # /config would interleave their writes into one corrupt file.
    tmp="$(mktemp "${GOG_DOWNLOADER_PHAR}.part.XXXXXX")"
    echo "[gogui] downloading gog-downloader ${GOGDL_VERSION}"
    if ! curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
        rm -f "$tmp"
        echo "[gogui] download failed: $url" >&2
        return 1
    fi

    if [ -n "$GOGDL_SHA256" ]; then
        if ! echo "${GOGDL_SHA256}  ${tmp}" | sha256sum -c - >/dev/null 2>&1; then
            rm -f "$tmp"
            echo "[gogui] checksum mismatch for gog-downloader ${GOGDL_VERSION}" >&2
            return 1
        fi
    else
        echo "[gogui] no checksum for ${GOGDL_VERSION}; skipping verification" >&2
    fi

    chmod 0644 "$tmp"
    if ! php "$tmp" --version >/dev/null 2>&1; then
        rm -f "$tmp"
        echo "[gogui] downloaded file is not a runnable gog-downloader phar" >&2
        return 1
    fi
    mv "$tmp" "$GOG_DOWNLOADER_PHAR"
    echo "[gogui] gog-downloader ${GOGDL_VERSION} ready"
}

# A failed fetch is not fatal: the web UI still starts and reports the missing
# CLI per job, which beats a container that restart-loops with no way to see why.
if [ ! -f "$GOG_DOWNLOADER_PHAR" ]; then
    fetch_cli || echo "[gogui] continuing without the CLI; fix the problem above and restart" >&2
fi

if [ "$(id -u)" = "0" ]; then
    if ! getent group "$PGID" >/dev/null; then
        groupadd -g "$PGID" gogui
    fi
    if ! getent passwd "$PUID" >/dev/null; then
        useradd -u "$PUID" -g "$PGID" -M -d /config -s /usr/sbin/nologin gogui
    fi

    mkdir -p "$CONFIG_DIRECTORY" "$DOWNLOAD_DIRECTORY" "$SAVES_DIRECTORY"
    # /config is ours to own. The download and saves shares may be large and
    # shared with other containers, so only the top level is adjusted.
    chown -R "$PUID:$PGID" "$CONFIG_DIRECTORY" 2>/dev/null || true
    chown "$PUID:$PGID" "$DOWNLOAD_DIRECTORY" "$SAVES_DIRECTORY" 2>/dev/null || true

    echo "[gogui] starting as ${PUID}:${PGID}, umask ${UMASK}"
    if [ "$#" -gt 0 ]; then
        exec gosu "$PUID:$PGID" "$@"
    fi
    exec gosu "$PUID:$PGID" uvicorn gogui.main:app \
        --host 0.0.0.0 --port "$WEBUI_PORT" --no-server-header --proxy-headers
fi

# Already unprivileged (e.g. `docker run --user`): start directly.
if [ "$#" -gt 0 ]; then
    exec "$@"
fi
exec uvicorn gogui.main:app --host 0.0.0.0 --port "$WEBUI_PORT" --no-server-header --proxy-headers
