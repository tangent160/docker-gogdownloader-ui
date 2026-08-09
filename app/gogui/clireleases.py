"""Discovering, installing and switching between gog-downloader releases.

The CLI is not part of the image: upstream publishes a self-contained phar with
every release, and the entrypoint fetches one into ``/config/cli`` on first
start. This module lets the UI do the same thing on demand — list what upstream
offers, download another version alongside the current one, and switch to it.

Every installed version stays on disk under its own name, so switching back is
free and never needs the network.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

RELEASES_API = "https://api.github.com/repos/RikudouSage/GogDownloader/releases"
ASSET_NAME = "gog-downloader"
#: The phar is ~14 MB; anything far past that is not the asset we expect.
MAX_PHAR_BYTES = 64 * 1024 * 1024
#: GitHub's unauthenticated rate limit is low and the release list barely
#: changes, so the listing is cached in memory.
CACHE_TTL_SECONDS = 900
#: Release tags become filenames, so keep them to something obviously safe.
TAG_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class ReleaseError(RuntimeError):
    """Raised when upstream cannot be listed, or a version cannot be installed."""


@dataclass(frozen=True)
class Release:
    version: str
    name: str
    published_at: str
    size: int
    prerelease: bool
    url: str


def _parse(payload: object) -> list[Release]:
    releases: list[Release] = []
    if not isinstance(payload, list):
        raise ReleaseError("Unexpected response from GitHub.")
    for entry in payload:
        if not isinstance(entry, dict) or entry.get("draft"):
            continue
        tag = str(entry.get("tag_name") or "")
        if not TAG_PATTERN.match(tag):
            continue
        # Only releases that actually ship the phar can be installed; early
        # releases and Windows-only ones are not usable here.
        asset = next(
            (
                a
                for a in entry.get("assets", [])
                if isinstance(a, dict) and a.get("name") == ASSET_NAME
            ),
            None,
        )
        if asset is None:
            continue
        releases.append(
            Release(
                version=tag,
                name=str(entry.get("name") or tag),
                published_at=str(entry.get("published_at") or ""),
                size=int(asset.get("size") or 0),
                prerelease=bool(entry.get("prerelease")),
                url=str(asset.get("browser_download_url") or ""),
            )
        )
    return releases


class CliReleases:
    """Reads and writes the phar cache in ``/config/cli``."""

    def __init__(self, directory: Path) -> None:
        self._directory = directory
        self._lock = asyncio.Lock()
        self._cache: list[Release] = []
        self._cached_at = 0.0

    def path_for(self, version: str) -> Path:
        if not TAG_PATTERN.match(version):
            raise ReleaseError(f"Invalid version: {version!r}")
        return self._directory / f"gog-downloader-{version}.phar"

    def installed(self) -> list[str]:
        """Versions already downloaded, newest-looking last."""
        try:
            names = [p.name for p in self._directory.glob("gog-downloader-*.phar")]
        except OSError:
            return []
        versions = [n[len("gog-downloader-") : -len(".phar")] for n in names]
        return sorted(v for v in versions if TAG_PATTERN.match(v))

    def is_installed(self, version: str) -> bool:
        try:
            return self.path_for(version).is_file()
        except ReleaseError:
            return False

    async def available(self, refresh: bool = False) -> list[Release]:
        """The releases upstream offers, newest first."""
        async with self._lock:
            fresh = time.monotonic() - self._cached_at < CACHE_TTL_SECONDS
            if self._cache and fresh and not refresh:
                return list(self._cache)
            try:
                async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
                    response = await client.get(
                        RELEASES_API,
                        params={"per_page": 100},
                        headers={"Accept": "application/vnd.github+json"},
                    )
                    response.raise_for_status()
                    releases = _parse(response.json())
            except httpx.HTTPError as exc:
                raise ReleaseError(f"Could not reach GitHub: {exc}") from exc
            except ValueError as exc:
                raise ReleaseError("Could not read the response from GitHub.") from exc
            self._cache = releases
            self._cached_at = time.monotonic()
            return list(releases)

    async def install(self, version: str) -> Path:
        """Download a release's phar if it isn't cached already."""
        target = self.path_for(version)
        if target.is_file():
            return target

        releases = await self.available()
        release = next((r for r in releases if r.version == version), None)
        if release is None or not release.url:
            raise ReleaseError(f"{version} is not an installable release.")

        self._directory.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f"{target.name}.part.{time.time_ns()}")
        try:
            await self._download(release.url, tmp)
            await self._verify(tmp)
            tmp.replace(target)
        finally:
            tmp.unlink(missing_ok=True)
        return target

    def remove(self, version: str) -> None:
        """Delete a cached phar. Callers decide which versions may go."""
        path = self.path_for(version)
        if not path.is_file():
            raise ReleaseError(f"{version} is not installed.")
        try:
            path.unlink()
        except OSError as exc:
            raise ReleaseError(f"Could not remove {version}: {exc}") from exc

    async def _download(self, url: str, destination: Path) -> None:
        try:
            async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
                async with client.stream("GET", url) as response:
                    response.raise_for_status()
                    written = 0
                    with destination.open("wb") as handle:
                        async for chunk in response.aiter_bytes(256 * 1024):
                            written += len(chunk)
                            if written > MAX_PHAR_BYTES:
                                raise ReleaseError("The download is implausibly large.")
                            handle.write(chunk)
        except httpx.HTTPError as exc:
            raise ReleaseError(f"Download failed: {exc}") from exc

    @staticmethod
    async def _verify(phar: Path) -> None:
        """A phar that cannot report its own version is not worth keeping.

        Upstream publishes no checksums, so running the file is the strongest
        check available — and it also catches an HTML error page saved as a phar.
        """
        process = await asyncio.create_subprocess_exec(
            "php",
            str(phar),
            "--version",
            "--no-interaction",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            stdin=asyncio.subprocess.DEVNULL,
        )
        if await process.wait() != 0:
            # Not necessarily a bad download: some older releases fail to boot
            # on the PHP version in this image, and one broken build should not
            # replace a working one.
            raise ReleaseError(
                "That release does not start in this container — it is either "
                "damaged or too old for the bundled PHP. Pick another version."
            )
