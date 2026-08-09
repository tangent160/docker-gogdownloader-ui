"""Cover art for the library grid.

gog-downloader's database stores no artwork, so covers are resolved from GOG's
public products API and cached on disk under /config — one lookup per game,
then the image bytes are served from the container so the browser never talks
to GOG directly and the cache survives restarts.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

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
        self._lock = asyncio.Lock()
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

        async with self._lock:
            if path.exists():
                return path
            url = await self._resolve_url(gog_id)
            self._index[str(gog_id)] = url or ""
            self._save_index()
            if not url:
                return None
            return await self._download(url, path)

    async def _resolve_url(self, gog_id: int) -> str | None:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(PRODUCT_API.format(gog_id=gog_id))
                if response.status_code != 200:
                    return None
                images = response.json().get("images") or {}
        except (httpx.HTTPError, ValueError):
            return None
        logo = images.get("logo2x") or images.get("logo") or ""
        if not logo:
            return None
        return f"https:{logo}" if logo.startswith("//") else logo

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
