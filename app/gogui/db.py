"""Read-only view of gog-downloader's own SQLite database.

The UI never parses CLI output for data — the CLI writes everything it knows
into this one file (tables ``games``, ``downloads``, ``game_extras``, ``auth``;
schema in ``vendor/GogDownloader/src/Migration/``) and we read it directly.
Every query opens the file read-only and closes it again, so the CLI child
process is never blocked by a handle we hold.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Game:
    row_id: int
    gog_id: int
    title: str
    slug: str | None
    #: Sum of every installer variant — overstates any one install, sort key only.
    total_size: int
    #: Distinct installer platforms, as stored in the db (windows, mac, linux).
    platforms: tuple[str, ...] = ()


@dataclass(frozen=True)
class DownloadFile:
    language: str | None
    platform: str | None
    name: str
    size: int
    md5: str | None
    is_patch: bool


@dataclass(frozen=True)
class ExtraFile:
    name: str
    size: int


class GameDatabase:
    def __init__(self, path: Path) -> None:
        self._path = path

    @property
    def exists(self) -> bool:
        return self._path.exists()

    def _connect(self) -> sqlite3.Connection:
        # immutable=1 keeps us from creating -wal/-shm files or taking locks
        # while the CLI child process is writing.
        uri = f"file:{self._path}?mode=ro&immutable=1"
        connection = sqlite3.connect(uri, uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    def _query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        if not self.exists:
            return []
        try:
            with self._connect() as connection:
                return connection.execute(sql, params).fetchall()
        except sqlite3.Error:
            # A missing table means an older db revision; treat as "no data"
            # rather than failing the request.
            return []

    def is_logged_in(self) -> bool:
        rows = self._query(
            "select count(*) as count from auth where token is not null and refreshToken is not null"
        )
        return bool(rows and rows[0]["count"] > 0)

    def games(self) -> list[Game]:
        rows = self._query(
            """
            select g.id, g.game_id, g.title, g.slug, coalesce(sum(d.size), 0) as total_size,
                   group_concat(distinct d.platform) as platforms
            from games g left join downloads d on d.game_id = g.id
            group by g.id order by g.title collate nocase
            """
        )
        return [
            Game(
                row_id=row["id"],
                gog_id=row["game_id"],
                title=row["title"],
                slug=row["slug"],
                total_size=int(row["total_size"] or 0),
                platforms=tuple(sorted(filter(None, (row["platforms"] or "").split(",")))),
            )
            for row in rows
        ]

    def game(self, row_id: int) -> Game | None:
        rows = self._query(
            """
            select g.id, g.game_id, g.title, g.slug, coalesce(sum(d.size), 0) as total_size
            from games g left join downloads d on d.game_id = g.id
            where g.id = ? group by g.id
            """,
            (row_id,),
        )
        if not rows:
            return None
        row = rows[0]
        return Game(
            row_id=row["id"],
            gog_id=row["game_id"],
            title=row["title"],
            slug=row["slug"],
            total_size=int(row["total_size"] or 0),
        )

    def downloads(self, game_row_id: int) -> list[DownloadFile]:
        rows = self._query(
            """
            select language, platform, name, size, md5, is_patch
            from downloads where game_id = ? order by platform, language, name
            """,
            (game_row_id,),
        )
        return [
            DownloadFile(
                language=row["language"],
                platform=row["platform"],
                name=row["name"],
                size=int(row["size"] or 0),
                md5=row["md5"],
                is_patch=bool(row["is_patch"]),
            )
            for row in rows
        ]

    def extras(self, game_row_id: int) -> list[ExtraFile]:
        rows = self._query(
            "select name, size from game_extras where game_id = ? order by name",
            (game_row_id,),
        )
        return [ExtraFile(name=row["name"], size=int(row["size"] or 0)) for row in rows]
