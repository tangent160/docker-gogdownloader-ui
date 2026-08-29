"""Cover art for the library grid.

gog-downloader's database stores no artwork, so covers are resolved from GOG's
public products API and cached on disk under /config — one lookup per game,
then the image bytes are served from the container so the browser never talks
to GOG directly and the cache survives restarts.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx

PRODUCT_API = "https://api.gog.com/products/{gog_id}"
#: Refuse to cache anything implausibly large for a cover image.
MAX_COVER_BYTES = 4 * 1024 * 1024


class CoverStore:
    def __init__(self, directory: Path, enabled: bool = True) -> None:
        self._directory = directory
        self._enabled = enabled
        self._index_file = directory / "index.json"
        self._index: dict[str, str] = {}
        #: One lock per game, not one for the store: a first library render
        #: fetches every cover at once and a single lock would serialise them
        #: behind each other's network timeouts. Refcounted by ``_lock_for``
        #: so a large library does not leave a lock per game behind.
        self._locks: dict[str, asyncio.Lock] = {}
        self._lock_users: dict[str, int] = {}
        self._load_index()

    def _load_index(self) -> None:
        try:
            data = json.loads(self._index_file.read_text())
        except (OSError, ValueError):
            return
        if isinstance(data, dict):
            self._index = {str(k): str(v) for k, v in data.items()}

    def _save_index(self) -> None:
        try:
            tmp = self._index_file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._index))
            tmp.replace(self._index_file)
        except OSError:
            pass

    def cached_path(self, gog_id: int) -> Path:
        return self._directory / f"{gog_id}.jpg"

    async def fetch(self, gog_id: int) -> Path | None:
        """Return a local cover file, downloading it once if needed."""
        if not self._enabled:
            return None
        path = self.cached_path(gog_id)
        if path.exists():
            return path
        # An empty index entry is a remembered miss — don't retry every render.
        if self._index.get(str(gog_id)) == "":
            return None

        key = str(gog_id)
        async with self._lock_for(key):
            if path.exists():
                return path
            # A remembered URL whose image never made it to disk: the download
            # failed, not the lookup, so retry it directly rather than asking
            # the products API the same question over again.
            url: str | None = self._index.get(key) or None
            if url is None:
                url, remember = await self._resolve_url(gog_id)
                # Only a definite answer from GOG is worth remembering. Caching
                # a network failure would mean a container that was offline on
                # its first library render never shows a cover again.
                if url or remember:
                    self._index[key] = url or ""
                    self._save_index()
            if not url:
                return None
            return await self._download(url, path)

    @asynccontextmanager
    async def _lock_for(self, key: str) -> AsyncIterator[None]:
        """Serialise work on one game, holding a lock only while it is in use.

        The locks are refcounted rather than dropped on release: a waiter woken
        by ``release`` has not run yet, so the lock still looks unheld to the
        coroutine leaving it, and discarding the entry there would let the next
        caller create a second lock for the same game.
        """
        lock = self._locks.get(key)
        if lock is None:
            lock = self._locks[key] = asyncio.Lock()
        self._lock_users[key] = self._lock_users.get(key, 0) + 1
        try:
            async with lock:
                yield
        finally:
            remaining = self._lock_users[key] - 1
            if remaining:
                self._lock_users[key] = remaining
            else:
                del self._lock_users[key]
                self._locks.pop(key, None)

    async def _resolve_url(self, gog_id: int) -> tuple[str | None, bool]:
        """The cover URL, and whether the answer is worth caching."""
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(PRODUCT_API.format(gog_id=gog_id))
                if response.status_code == 404:
                    return None, True  # GOG has no such product; settled.
                if response.status_code != 200:
                    return None, False  # Rate limit or outage; try again later.
                images = response.json().get("images") or {}
        except (httpx.HTTPError, ValueError):
            return None, False
        logo = images.get("logo2x") or images.get("logo") or ""
        if not logo:
            return None, True  # The product exists and simply has no artwork.
        return (f"https:{logo}" if logo.startswith("//") else logo), True

    async def _download(self, url: str, path: Path) -> Path | None:
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
                response = await client.get(url)
                if response.status_code != 200 or len(response.content) > MAX_COVER_BYTES:
                    return None
                tmp = path.with_suffix(".tmp")
                tmp.write_bytes(response.content)
                tmp.replace(path)
                return path
        except (httpx.HTTPError, OSError):
            return None
