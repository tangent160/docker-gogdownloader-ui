# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Runtime — PHP for gog-downloader, Python for the web UI.
#
# The CLI itself is not baked in: upstream publishes a self-contained phar per
# release, and the entrypoint downloads it into /config on first start. See
# GOGDL_PINNED_* below.
# ---------------------------------------------------------------------------
FROM php:8.4-cli-bookworm

ENV CONFIG_DIRECTORY=/config \
    DOWNLOAD_DIRECTORY=/downloads \
    SAVES_DIRECTORY=/saves \
    GOG_DOWNLOADER_BIN=/app/gog-downloader \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PUID=99 \
    PGID=100 \
    UMASK=022 \
    WEBUI_PORT=8080 \
    GOG_DOWNLOADER_VERSION= \
    GOG_DOWNLOADER_SHA256=

# The CLI release this image was built against. GOG_DOWNLOADER_VERSION (empty
# above, so the template can override it) falls back to this; the checksum is
# only enforced when the resolved version is this one.
ENV GOGDL_PINNED_VERSION=v1.15.1 \
    GOGDL_PINNED_SHA256=3a8e677b69d7ba70bdf787b709857f9552bf2c404d2e716082ed188836a0a27c \
    GOGDL_CLI_DIR=/config/cli

# simplexml + pdo_sqlite are required by gog-downloader; pcntl lets it handle
# signals so an in-flight download stops cleanly when a job is cancelled.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libxml2-dev libsqlite3-dev ca-certificates curl gosu tini \
        python3 python3-pip python3-venv; \
    docker-php-ext-install -j"$(nproc)" simplexml pcntl pdo_sqlite; \
    echo 'memory_limit = -1' > /usr/local/etc/php/conf.d/zz-memory-limit.ini; \
    rm -rf /var/lib/apt/lists/*

# Isolated venv: Debian's python3 is externally managed.
ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH
RUN python3 -m venv "$VIRTUAL_ENV"
COPY app/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Build provenance, surfaced by the UI's About card. Both are optional: a
# plain `docker build` leaves them empty and the UI just shows the version.
ARG GOGUI_COMMIT=
ARG GOGUI_BUILD_DATE=
ENV GOGUI_COMMIT=$GOGUI_COMMIT \
    GOGUI_BUILD_DATE=$GOGUI_BUILD_DATE

COPY app/gogui /app/gogui
COPY docker/entrypoint.sh /entrypoint.sh
# gog-downloader is invoked as a plain command; the shim locates the phar.
COPY docker/gog-downloader.sh /app/gog-downloader

RUN set -eux; \
    chmod +x /app/gog-downloader /entrypoint.sh; \
    ln -s /app/gog-downloader /usr/local/bin/gog-downloader; \
    mkdir -p /config /downloads /saves

WORKDIR /app
VOLUME ["/config", "/downloads", "/saves"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD php -r 'exit(@file_get_contents("http://127.0.0.1:" . (getenv("WEBUI_PORT") ?: 8080) . "/health") ? 0 : 1);'

# No CMD: the entrypoint starts uvicorn on $WEBUI_PORT. Passing arguments to
# the container runs them instead, e.g. `docker run … gog-downloader games`.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]

LABEL org.opencontainers.image.title="GOG Downloader UI" \
      org.opencontainers.image.description="Web UI for RikudouSage/GogDownloader, built for Unraid" \
      org.opencontainers.image.source="https://github.com/tangent160/docker-gogdownloader-ui" \
      org.opencontainers.image.licenses="MIT"
