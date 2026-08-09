# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: install the CLI's PHP dependencies from the pinned submodule.
# ---------------------------------------------------------------------------
FROM composer:2 AS cli-build

WORKDIR /build
# Copy the manifests first so the dependency install layer caches independently
# of the CLI's own source.
COPY vendor/GogDownloader/composer.json vendor/GogDownloader/composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist --ignore-platform-reqs

COPY vendor/GogDownloader/ ./
# Not --classmap-authoritative: src/DTO/DownloadDescription.php declares no
# class (it is a class_alias shim), so it never lands in the classmap and an
# authoritative loader refuses the PSR-4 fallback that would run the alias —
# which breaks Symfony's service autodiscovery and every CLI command with it.
RUN composer dump-autoload --no-dev --optimize \
    && rm -rf .git .github tests windows setup.iss shell.nix

# ---------------------------------------------------------------------------
# Stage 2: runtime — PHP CLI for gog-downloader, Python for the web UI.
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
    WEBUI_PORT=8080

# simplexml + pdo_sqlite are required by gog-downloader; pcntl lets it handle
# signals so an in-flight download stops cleanly when a job is cancelled.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libxml2-dev libsqlite3-dev ca-certificates gosu tini \
        python3 python3-pip python3-venv; \
    docker-php-ext-install -j"$(nproc)" simplexml pcntl pdo_sqlite; \
    echo 'memory_limit = -1' > /usr/local/etc/php/conf.d/zz-memory-limit.ini; \
    rm -rf /var/lib/apt/lists/*

# Isolated venv: Debian's python3 is externally managed.
ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:$PATH
RUN python3 -m venv "$VIRTUAL_ENV"
COPY app/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt

COPY --from=cli-build /build /app/gog-downloader-src
COPY app/gogui /app/gogui
COPY docker/entrypoint.sh /entrypoint.sh

# gog-downloader is invoked as a plain command; bin/app.php is the CLI entry.
RUN set -eux; \
    printf '#!/bin/sh\nexec php /app/gog-downloader-src/bin/app.php "$@"\n' > /app/gog-downloader; \
    chmod +x /app/gog-downloader /entrypoint.sh; \
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
