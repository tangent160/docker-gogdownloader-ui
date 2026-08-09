#!/bin/sh
# The CLI is a phar cached under /config by the entrypoint, so this shim has to
# find it at call time. The entrypoint exports GOG_DOWNLOADER_PHAR for the web
# UI's child processes; `docker exec` does not inherit that, so fall back to
# resolving the same path from the image's own environment.
set -eu

phar="${GOG_DOWNLOADER_PHAR:-}"

if [ -z "$phar" ] || [ ! -f "$phar" ]; then
    dir="${GOGDL_CLI_DIR:-${CONFIG_DIRECTORY:-/config}/cli}"
    version="${GOG_DOWNLOADER_VERSION:-${GOGDL_PINNED_VERSION:-}}"
    phar="${dir}/gog-downloader-${version}.phar"
fi

if [ ! -f "$phar" ]; then
    echo "gog-downloader is not installed yet: ${phar} is missing." >&2
    echo "It is downloaded on container start; check the container log for the reason it failed." >&2
    exit 127
fi

exec php "$phar" "$@"
