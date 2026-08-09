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
