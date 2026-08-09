"""Container configuration, read once from the environment at import time."""

from __future__ import annotations

import json
import os
import secrets
import threading
from dataclasses import dataclass, field
from pathlib import Path


def _env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name) or default)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Config:
    """Paths and knobs fixed for the lifetime of the container."""

    #: Persisted across restarts; holds gog-downloader's SQLite db (auth tokens
    #: + synced library), our own settings file and the cover-art cache.
    config_dir: Path = field(default_factory=lambda: _env_path("CONFIG_DIRECTORY", "/config"))
    #: Where downloaded installers/extras land — the user's share in Unraid.
    download_dir: Path = field(default_factory=lambda: _env_path("DOWNLOAD_DIRECTORY", "/downloads"))
    #: Where cloud saves land.
    saves_dir: Path = field(default_factory=lambda: _env_path("SAVES_DIRECTORY", "/saves"))
    cli_path: Path = field(default_factory=lambda: _env_path("GOG_DOWNLOADER_BIN", "/app/gog-downloader"))

    username: str = field(default_factory=lambda: os.environ.get("WEBUI_USERNAME", "").strip())
    password: str = field(default_factory=lambda: os.environ.get("WEBUI_PASSWORD", ""))
    #: Cover art is fetched from GOG's public products API when enabled.
    covers_enabled: bool = field(default_factory=lambda: _env_bool("COVER_ART", True))
    #: Serving over plain http on a LAN is the norm for Unraid, so the session
    #: cookie can't be Secure by default.
    cookie_secure: bool = field(default_factory=lambda: _env_bool("WEBUI_COOKIE_SECURE", False))

    @property
    def auth_required(self) -> bool:
        return bool(self.username and self.password)

    @property
    def database_file(self) -> Path:
        return self.config_dir / "gog-downloader.db"

    @property
    def covers_dir(self) -> Path:
        return self.config_dir / "covers"

    @property
    def settings_file(self) -> Path:
        return self.config_dir / "webui-settings.json"

    def session_secret(self) -> bytes:
        """Stable across restarts so sessions survive a container update."""
        path = self.config_dir / ".session_secret"
        if not path.exists():
            path.write_bytes(secrets.token_bytes(32))
            path.chmod(0o600)
        return path.read_bytes()

    def prepare(self) -> None:
        for path in (self.config_dir, self.download_dir, self.saves_dir, self.covers_dir):
            path.mkdir(parents=True, exist_ok=True)


config = Config()


# Defaults for everything the user can change from the Settings screen. Values
# here are passed straight to the CLI, so they mirror its flag names.
DEFAULT_SETTINGS: dict[str, object] = {
    "include_hidden": False,
    "library_sort": "title",  # title | recent | size
    "sync_mode": "incremental",  # full | incremental | search — how the library was populated
    "retry": 3,
    "idle_timeout": 3,
    "chunk_size": 10,
    "bandwidth": "",  # e.g. "4m"; empty means unlimited
    "skip_errors": True,
    "no_patches": False,
    "skip_existing_extras": True,
    "language_fallback_english": False,
}

#: Bounds the CLI itself enforces (or that make no sense to exceed). A value
#: outside these aborts the whole run, so they are clamped rather than trusted.
SETTING_BOUNDS: dict[str, tuple[int, int]] = {
    "chunk_size": (5, 1024),
    "retry": (0, 100),
    "idle_timeout": (1, 3600),
}


class SettingsStore:
    """The web UI's own preferences, as a JSON file in /config."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._values = dict(DEFAULT_SETTINGS)
        self._load()

    def _load(self) -> None:
        try:
            stored = json.loads(self._path.read_text())
        except (OSError, ValueError):
            return
        if isinstance(stored, dict):
            self._values.update({k: v for k, v in stored.items() if k in DEFAULT_SETTINGS})

    def all(self) -> dict[str, object]:
        with self._lock:
            return dict(self._values)

    def get(self, key: str) -> object:
        with self._lock:
            return self._values.get(key, DEFAULT_SETTINGS.get(key))

    def update(self, values: dict[str, object]) -> dict[str, object]:
        with self._lock:
            for key, value in values.items():
                if key not in DEFAULT_SETTINGS:
                    continue
                default = DEFAULT_SETTINGS[key]
                if isinstance(default, bool):
                    value = bool(value)
                elif isinstance(default, int):
                    try:
                        value = int(value)
                    except (TypeError, ValueError):
                        continue
                    low, high = SETTING_BOUNDS.get(key, (value, value))
                    value = max(low, min(high, value))
                else:
                    value = str(value)
                self._values[key] = value
            snapshot = dict(self._values)
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(snapshot, indent=2))
        tmp.replace(self._path)
        return snapshot
