"""Export/import of gog-downloader's SQLite database.

That single file holds the login tokens and the whole synced library, so it is
both the backup and the migration path between installs.
"""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
from pathlib import Path

SQLITE_MAGIC = b"SQLite format 3\x00"
REQUIRED_TABLES = {"games", "auth"}


class InvalidBackup(ValueError):
    """Raised when an uploaded file isn't a gog-downloader database."""


def validate(path: Path) -> None:
    with path.open("rb") as handle:
        if handle.read(len(SQLITE_MAGIC)) != SQLITE_MAGIC:
            raise InvalidBackup("Not a SQLite database file.")
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            rows = connection.execute("select name from sqlite_master where type='table'")
            tables = {row[0] for row in rows}
        finally:
            connection.close()
    except sqlite3.Error as error:
        raise InvalidBackup(f"Could not read the database: {error}") from error
    missing = REQUIRED_TABLES - tables
    if missing:
        raise InvalidBackup(
            "This does not look like a gog-downloader database "
            f"(missing table{'s' if len(missing) > 1 else ''}: {', '.join(sorted(missing))})."
        )


def import_database(upload: bytes, destination: Path) -> None:
    """Validate an uploaded backup and swap it in atomically.

    The caller must ensure no job is running: the CLI child process writes this
    file, and replacing it underneath a live run would lose data.
    """
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".upload", delete=False) as handle:
        staged = Path(handle.name)
        handle.write(upload)
    try:
        validate(staged)
        if destination.exists():
            shutil.copy2(destination, destination.with_suffix(".db.bak"))
        # Same filesystem, so this is an atomic rename.
        staged.replace(destination)
    except Exception:
        staged.unlink(missing_ok=True)
        raise
