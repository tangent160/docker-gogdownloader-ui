"""FastAPI application: JSON API + static single-page UI."""

from __future__ import annotations

import asyncio
import json
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .auth import COOKIE_NAME, SESSION_TTL, Authenticator
from .backup import InvalidBackup, import_database
from .cli import GogCli
from .clireleases import TAG_PATTERN, CliReleases, ReleaseError
from .config import SettingsStore, config
from .covers import CoverStore
from .db import GameDatabase
from .filters import LANGUAGES
from .jobs import JobQueue, JobType

STATIC_DIR = Path(__file__).parent / "static"

config.prepare()
settings_store = SettingsStore(config.settings_file)
cli_releases = CliReleases(config.cli_dir)


def _selected_phar() -> Path | None:
    """The CLI version chosen in Settings, if it is actually installed."""
    version = str(settings_store.get("cli_version") or "")
    if not version or not cli_releases.is_installed(version):
        return None
    return cli_releases.path_for(version)


cli = GogCli(config, phar=_selected_phar)
database = GameDatabase(config.database_file)
covers = CoverStore(config.covers_dir, enabled=config.covers_enabled)
authenticator = Authenticator(config)
queue = JobQueue(cli, config, settings_store)


@asynccontextmanager
async def lifespan(_: FastAPI):
    queue.start()
    yield
    await queue.stop()


app = FastAPI(title="GOG Downloader UI", lifespan=lifespan, docs_url=None, redoc_url=None)


def authenticated(request: Request) -> None:
    authenticator.require(request)


# --------------------------------------------------------------------------
# UI authentication
# --------------------------------------------------------------------------


class LoginRequest(BaseModel):
    username: str = ""
    password: str = ""


@app.post("/api/auth/login")
async def ui_login(payload: LoginRequest, response: Response) -> dict[str, Any]:
    if not authenticator.required:
        return {"authenticated": True}
    if not authenticator.verify_credentials(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="Incorrect username or password.")
    response.set_cookie(
        COOKIE_NAME,
        authenticator.issue_token(),
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        secure=config.cookie_secure,
    )
    return {"authenticated": True}


@app.post("/api/auth/logout")
async def ui_logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(COOKIE_NAME)
    return {"authenticated": False}


# --------------------------------------------------------------------------
# Status
# --------------------------------------------------------------------------


@app.get("/api/status")
async def status(request: Request) -> dict[str, Any]:
    """Deliberately unauthenticated: the login screen needs to know whether a
    UI login is required at all. It exposes no library data."""
    authed = authenticator.is_authenticated(request)
    body: dict[str, Any] = {
        "authRequired": authenticator.required,
        "authenticated": authed,
    }
    if not authed:
        return body
    body.update(
        {
            "gogLoggedIn": database.is_logged_in(),
            "hasLibrary": bool(database.games()),
            "downloadDir": str(config.download_dir),
            "savesDir": str(config.saves_dir),
            "configDir": str(config.config_dir),
            "coversEnabled": config.covers_enabled,
            "busy": queue.busy,
            "version": await cli.version(),
            "appVersion": __version__,
            "appCommit": config.commit,
            "appBuildDate": config.build_date,
            "diskFree": _disk_free(config.download_dir),
        }
    )
    return body


def _disk_free(path: Path) -> int | None:
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return None


# --------------------------------------------------------------------------
# GOG account
# --------------------------------------------------------------------------


class CodeLoginRequest(BaseModel):
    code: str = Field(min_length=1)


class PasswordLoginRequest(BaseModel):
    email: str = Field(min_length=1)
    password: str = Field(min_length=1)


def _require_idle() -> None:
    if queue.busy:
        raise HTTPException(
            status_code=409,
            detail="A job is running. Wait for it to finish — the CLI writes the same database.",
        )


@app.post("/api/gog/code-login", dependencies=[Depends(authenticated)])
async def gog_code_login(payload: CodeLoginRequest) -> dict[str, Any]:
    _require_idle()
    result = await cli.code_login(payload.code.strip())
    if not result.success:
        raise HTTPException(status_code=400, detail=result.error_message)
    return {"gogLoggedIn": database.is_logged_in()}


@app.post("/api/gog/login", dependencies=[Depends(authenticated)])
async def gog_password_login(payload: PasswordLoginRequest) -> dict[str, Any]:
    _require_idle()
    result = await cli.password_login(payload.email, payload.password)
    if not result.success:
        raise HTTPException(status_code=400, detail=result.error_message)
    return {"gogLoggedIn": database.is_logged_in()}


# --------------------------------------------------------------------------
# Library
# --------------------------------------------------------------------------


@app.get("/api/library", dependencies=[Depends(authenticated)])
async def library(q: str = "", sort: str = "title") -> dict[str, Any]:
    games = database.games()
    query = q.strip().lower()
    if query:
        games = [game for game in games if query in game.title.lower()]
    if sort == "size":
        games.sort(key=lambda game: game.total_size, reverse=True)
    elif sort == "recent":
        # The db has no timestamp; insertion order (rowid) is the closest proxy.
        games.sort(key=lambda game: game.row_id, reverse=True)
    else:
        games.sort(key=lambda game: game.title.lower())
    return {
        "games": [
            {
                "id": game.row_id,
                "gogId": game.gog_id,
                "title": game.title,
                "slug": game.slug,
                "totalSize": game.total_size,
            }
            for game in games
        ]
    }


@app.get("/api/games/{row_id}", dependencies=[Depends(authenticated)])
async def game_detail(row_id: int) -> dict[str, Any]:
    game = database.game(row_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found.")

    files = database.downloads(row_id)
    # GOG reuses one installer name across platform/language variants and
    # --skip-download matches on the name, so a name is the smallest unit that
    # can be selected or skipped: group the variants under it.
    groups: dict[str, list[dict[str, Any]]] = {}
    for file in files:
        groups.setdefault(file.name, []).append(
            {
                "language": file.language,
                "platform": file.platform,
                "size": file.size,
                "isPatch": file.is_patch,
            }
        )

    return {
        "game": {
            "id": game.row_id,
            "gogId": game.gog_id,
            "title": game.title,
            "slug": game.slug,
            "totalSize": game.total_size,
        },
        "groups": [
            {
                "name": name,
                "variants": variants,
                "totalSize": sum(variant["size"] for variant in variants),
            }
            for name, variants in groups.items()
        ],
        "extras": [{"name": extra.name, "size": extra.size} for extra in database.extras(row_id)],
        "platforms": sorted({file.platform for file in files if file.platform}),
        "languages": sorted({file.language for file in files if file.language}),
    }


@app.get("/api/covers/{gog_id}", dependencies=[Depends(authenticated)])
async def cover(gog_id: int) -> Response:
    path = await covers.fetch(gog_id)
    if path is None:
        raise HTTPException(status_code=404, detail="No cover available.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


@app.get("/api/languages", dependencies=[Depends(authenticated)])
async def languages() -> dict[str, Any]:
    return {"languages": [{"code": code, "name": name} for code, name in LANGUAGES.items()]}


# --------------------------------------------------------------------------
# Jobs
# --------------------------------------------------------------------------


class SyncRequest(BaseModel):
    mode: str = "incremental"  # full | incremental | search | update_search | clear
    query: str = ""


class DownloadRequest(BaseModel):
    game_id: int
    #: Installer group names the user selected; empty means installers are off.
    selected: list[str] = []
    #: Every group name currently visible, so unselected ones can be skipped.
    visible: list[str] = []
    include_extras: bool = False
    platforms: list[str] = []
    languages: list[str] = []


@app.get("/api/jobs", dependencies=[Depends(authenticated)])
async def list_jobs() -> dict[str, Any]:
    return {"jobs": queue.list()}


@app.get("/api/jobs/{job_id}/log", dependencies=[Depends(authenticated)])
async def job_log(job_id: int) -> dict[str, Any]:
    job = queue.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return {"log": list(job.log)}


@app.post("/api/jobs/sync", dependencies=[Depends(authenticated)])
async def enqueue_sync(payload: SyncRequest) -> dict[str, Any]:
    if payload.mode not in ("full", "incremental", "search", "update_search", "clear"):
        raise HTTPException(status_code=400, detail="Unknown sync mode.")
    if payload.mode in ("search", "update_search") and not payload.query.strip():
        raise HTTPException(status_code=400, detail="A search sync needs a search term.")
    # A --search sync only fetches matching games; remember that so the UI can
    # warn that the library is partial. "update_search" is a targeted refresh of
    # games the user already has, so it must not downgrade a full library to
    # "partial" — leave sync_mode alone for it.
    if payload.mode != "update_search":
        settings_store.update({"sync_mode": payload.mode if payload.mode != "clear" else "full"})
    titles = {
        "full": "Full library sync",
        "incremental": "Incremental sync",
        "clear": "Clear and resync library",
        "search": f"Sync matching “{payload.query.strip()}”",
        "update_search": f"Update matching “{payload.query.strip()}”",
    }
    job = queue.enqueue(
        JobType.SYNC, titles[payload.mode], mode=payload.mode, query=payload.query.strip()
    )
    return {"job": job.public()}


@app.post("/api/jobs/download", dependencies=[Depends(authenticated)])
async def enqueue_download(payload: DownloadRequest) -> dict[str, Any]:
    game = database.game(payload.game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Game not found.")
    if not payload.selected and not payload.include_extras:
        raise HTTPException(status_code=400, detail="Select at least one file or the extras.")

    include_installers = bool(payload.selected)
    selected = set(payload.selected)
    job = queue.enqueue(
        JobType.DOWNLOAD,
        game.title,
        game_title=game.title,
        include_installers=include_installers,
        include_extras=payload.include_extras,
        skipped_names=[name for name in payload.visible if name not in selected],
        platforms=payload.platforms,
        languages=payload.languages,
        target_dir=str(config.download_dir),
    )
    return {"job": job.public()}


@app.post("/api/jobs/saves", dependencies=[Depends(authenticated)])
async def enqueue_saves() -> dict[str, Any]:
    job = queue.enqueue(JobType.SAVES, "Cloud saves")
    return {"job": job.public()}


@app.post("/api/jobs/{job_id}/cancel", dependencies=[Depends(authenticated)])
async def cancel_job(job_id: int) -> dict[str, Any]:
    if not queue.cancel(job_id):
        raise HTTPException(status_code=404, detail="Job is not running.")
    return {"cancelled": True}


@app.delete("/api/jobs/finished", dependencies=[Depends(authenticated)])
async def clear_finished() -> dict[str, Any]:
    queue.clear_finished()
    return {"jobs": queue.list()}


@app.get("/api/jobs/stream", dependencies=[Depends(authenticated)])
async def job_stream(request: Request) -> StreamingResponse:
    subscription = queue.events.subscribe()

    async def publisher():
        try:
            yield f"data: {json.dumps({'type': 'jobs', 'jobs': queue.list()})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(subscription.get(), timeout=20)
                except asyncio.TimeoutError:
                    # Comment frame; keeps proxies from closing an idle stream.
                    yield ": keepalive\n\n"
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            queue.events.unsubscribe(subscription)

    return StreamingResponse(
        publisher(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------
# Settings and backup
# --------------------------------------------------------------------------


@app.get("/api/settings", dependencies=[Depends(authenticated)])
async def get_settings() -> dict[str, Any]:
    return {"settings": settings_store.all()}


@app.put("/api/settings", dependencies=[Depends(authenticated)])
async def put_settings(payload: dict[str, Any]) -> dict[str, Any]:
    return {"settings": settings_store.update(payload)}


# --------------------------------------------------------------------------
# gog-downloader releases
# --------------------------------------------------------------------------


class CliVersionRequest(BaseModel):
    version: str = ""


def _active_cli_version() -> str:
    selected = str(settings_store.get("cli_version") or "")
    return selected or config.default_cli_version


@app.get("/api/cli/releases", dependencies=[Depends(authenticated)])
async def cli_release_list(refresh: bool = False) -> dict[str, Any]:
    try:
        releases = await cli_releases.available(refresh=refresh)
    except ReleaseError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    active = _active_cli_version()
    return {
        "active": active,
        "default": config.default_cli_version,
        "installed": cli_releases.installed(),
        "releases": [
            {
                "version": release.version,
                "name": release.name,
                "publishedAt": release.published_at,
                "size": release.size,
                "prerelease": release.prerelease,
                "installed": cli_releases.is_installed(release.version),
                "active": release.version == active,
            }
            for release in releases
        ],
    }


@app.put("/api/cli/version", dependencies=[Depends(authenticated)])
async def set_cli_version(payload: CliVersionRequest) -> dict[str, Any]:
    # Switching swaps the binary the next job runs, and a download of a few
    # tens of MB has to finish first — neither is safe mid-job.
    _require_idle()
    version = payload.version.strip()
    if version and not TAG_PATTERN.match(version):
        raise HTTPException(status_code=400, detail=f"Not a valid release tag: {version}")
    if version and not cli_releases.is_installed(version):
        try:
            await cli_releases.install(version)
        except ReleaseError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    settings_store.update({"cli_version": version})
    return {
        "active": _active_cli_version(),
        "installed": cli_releases.installed(),
        "version": await cli.version(),
    }


@app.delete("/api/cli/version/{version}", dependencies=[Depends(authenticated)])
async def remove_cli_version(version: str) -> dict[str, Any]:
    # Deleting the phar out from under a running job would kill it.
    _require_idle()
    version = version.strip()
    if not TAG_PATTERN.match(version):
        raise HTTPException(status_code=400, detail=f"Not a valid release tag: {version}")
    # The image default is what everything falls back to, including a deletion
    # of the version in use, so it is the one copy that has to stay.
    if version == config.default_cli_version:
        raise HTTPException(
            status_code=400,
            detail=f"{version} is the version this image ships with and cannot be removed.",
        )
    try:
        cli_releases.remove(version)
    except ReleaseError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    # Removing the version in use falls back to the image default rather than
    # leaving the UI pointing at a file that is gone.
    if str(settings_store.get("cli_version") or "") == version:
        settings_store.update({"cli_version": ""})
    return {
        "active": _active_cli_version(),
        "installed": cli_releases.installed(),
        "version": await cli.version(),
    }


@app.get("/api/backup/export", dependencies=[Depends(authenticated)])
async def export_backup() -> FileResponse:
    if not config.database_file.exists():
        raise HTTPException(status_code=404, detail="There is no database to export yet.")
    _require_idle()
    return FileResponse(
        config.database_file,
        media_type="application/vnd.sqlite3",
        filename="gog-downloader.db",
    )


@app.post("/api/backup/import", dependencies=[Depends(authenticated)])
async def import_backup(file: UploadFile) -> dict[str, Any]:
    _require_idle()
    try:
        import_database(await file.read(), config.database_file)
    except InvalidBackup as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"gogLoggedIn": database.is_logged_in()}


# --------------------------------------------------------------------------
# Static UI
# --------------------------------------------------------------------------


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
