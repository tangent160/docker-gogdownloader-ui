"""Serialised job queue driving the CLI, plus a fan-out event stream for the UI.

Only one CLI process runs at a time: gog-downloader owns the SQLite database in
/config and a concurrent run would corrupt or deadlock it. Jobs therefore queue
up and a single worker drains them, publishing state to every connected browser
over server-sent events.
"""

from __future__ import annotations

import asyncio
import itertools
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from .cli import GogCli, parse_progress
from .config import Config, SettingsStore
from .filters import cli_filter_args, language_arg, os_arg

#: Log lines retained per job — enough to diagnose a failure, bounded so a long
#: library sync can't grow without limit.
LOG_LIMIT = 500


class JobState(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def finished(self) -> bool:
        return self in (JobState.DONE, JobState.FAILED, JobState.CANCELLED)


class JobType(str, Enum):
    SYNC = "sync"
    DOWNLOAD = "download"
    SAVES = "saves"


@dataclass
class Job:
    id: int
    type: JobType
    title: str
    #: Type-specific parameters; consumed by ``JobQueue._build_args``.
    params: dict[str, Any] = field(default_factory=dict)
    state: JobState = JobState.QUEUED
    last_line: str = ""
    error: str = ""
    progress: float | None = None
    progress_current: int = 0
    progress_total: int = 0
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    log: deque[str] = field(default_factory=lambda: deque(maxlen=LOG_LIMIT))
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type.value,
            "title": self.title,
            "state": self.state.value,
            "lastLine": self.last_line,
            "error": self.error,
            "progress": self.progress,
            "progressCurrent": self.progress_current,
            "progressTotal": self.progress_total,
            "createdAt": self.created_at,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
        }


class EventBus:
    """Fan-out of job updates to every open browser tab."""

    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    def publish(self, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # A stalled client must not slow down the worker; it will
                # resync from /api/jobs when it reconnects.
                self._subscribers.discard(queue)


class JobQueue:
    def __init__(self, cli: GogCli, config: Config, settings: SettingsStore) -> None:
        self._cli = cli
        self._config = config
        self._settings = settings
        self._jobs: dict[int, Job] = {}
        self._order: list[int] = []
        self._ids = itertools.count(1)
        self._wakeup = asyncio.Event()
        self._worker: asyncio.Task | None = None
        self.events = EventBus()

    # ----- lifecycle -------------------------------------------------

    def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._drain())

    async def stop(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None

    # ----- queue api -------------------------------------------------

    def enqueue(self, type: JobType, title: str, **params: Any) -> Job:
        job = Job(id=next(self._ids), type=type, title=title, params=params)
        self._jobs[job.id] = job
        self._order.append(job.id)
        self._publish(job)
        self._wakeup.set()
        self.start()
        return job

    def list(self) -> list[dict[str, Any]]:
        return [self._jobs[job_id].public() for job_id in self._order]

    def get(self, job_id: int) -> Job | None:
        return self._jobs.get(job_id)

    @property
    def active(self) -> Job | None:
        for job_id in self._order:
            if self._jobs[job_id].state is JobState.RUNNING:
                return self._jobs[job_id]
        return None

    @property
    def busy(self) -> bool:
        return any(not self._jobs[job_id].state.finished for job_id in self._order)

    def cancel(self, job_id: int) -> bool:
        job = self._jobs.get(job_id)
        if job is None or job.state.finished:
            return False
        job.cancel_event.set()
        if job.state is JobState.QUEUED:
            # Nothing is running it yet, so retire it here.
            self._finish(job, JobState.CANCELLED)
        return True

    def clear_finished(self) -> None:
        for job_id in list(self._order):
            if self._jobs[job_id].state.finished:
                self._order.remove(job_id)
                del self._jobs[job_id]
        self.events.publish({"type": "jobs", "jobs": self.list()})

    # ----- worker ----------------------------------------------------

    async def _drain(self) -> None:
        while True:
            job = self._next_queued()
            if job is None:
                self._wakeup.clear()
                await self._wakeup.wait()
                continue
            await self._run(job)

    def _next_queued(self) -> Job | None:
        for job_id in self._order:
            if self._jobs[job_id].state is JobState.QUEUED:
                return self._jobs[job_id]
        return None

    async def _run(self, job: Job) -> None:
        job.state = JobState.RUNNING
        job.started_at = time.time()
        self._publish(job)

        def on_line(line: str) -> None:
            job.log.append(line)
            progress = parse_progress(line)
            if progress is not None:
                job.progress = progress.fraction
                job.progress_current = progress.current
                job.progress_total = progress.total
                job.last_line = progress.label or job.last_line
            else:
                job.last_line = line
            self._publish(job)

        try:
            args = self._build_args(job)
            result = await self._cli.run(args, on_line=on_line, cancel_event=job.cancel_event)
        except Exception as error:  # noqa: BLE001 — surfaced to the user verbatim
            job.error = str(error)
            self._finish(job, JobState.FAILED)
            return

        if job.cancel_event.is_set():
            self._finish(job, JobState.CANCELLED)
        elif result.success:
            job.progress = 1.0
            self._finish(job, JobState.DONE)
        else:
            job.error = result.error_message
            self._finish(job, JobState.FAILED)

    def _finish(self, job: Job, state: JobState) -> None:
        job.state = state
        job.finished_at = time.time()
        self._publish(job)

    def _publish(self, job: Job) -> None:
        self.events.publish({"type": "job", "job": job.public()})

    # ----- argument building -----------------------------------------

    def _build_args(self, job: Job) -> list[str]:
        settings = self._settings.all()
        if job.type is JobType.SYNC:
            return self._sync_args(job, settings)
        if job.type is JobType.SAVES:
            return self._saves_args(settings)
        return self._download_args(job, settings)

    def _sync_args(self, job: Job, settings: dict[str, Any]) -> list[str]:
        mode = job.params.get("mode", "incremental")
        args = ["update-database"]
        if mode == "incremental":
            args.append("--updated-only")
        elif mode in ("search", "update_search"):
            args.append(f"--search={job.params.get('query', '')}")
        elif mode == "clear":
            args.append("--clear")
        if settings["include_hidden"]:
            args.append("--include-hidden")
        args += self._retry_args(settings)
        return args

    def _saves_args(self, settings: dict[str, Any]) -> list[str]:
        target = Path(self._config.saves_dir)
        target.mkdir(parents=True, exist_ok=True)
        return ["download-saves", str(target), *self._retry_args(settings)]

    def _download_args(self, job: Job, settings: dict[str, Any]) -> list[str]:
        target = Path(job.params.get("target_dir") or self._config.download_dir)
        target.mkdir(parents=True, exist_ok=True)

        include_installers: bool = job.params.get("include_installers", True)
        include_extras: bool = job.params.get("include_extras", False)
        skipped: list[str] = job.params.get("skipped_names", [])
        platforms: list[str] = job.params.get("platforms", [])
        languages: list[str] = job.params.get("languages", [])

        args = ["download", str(target), f"--only={job.params['game_title']}"]
        if include_extras:
            args.append("--extras")
            if settings["skip_existing_extras"]:
                args.append("--skip-existing-extras")
        if not include_installers:
            args.append("--no-games")
        elif settings["no_patches"]:
            args.append("--no-patches")

        # An extras-only run must not be filtered: --os/--language drop games
        # with no matching installers *including their extras*.
        if include_installers:
            for value in cli_filter_args(platforms, os_arg):
                args.append(f"--os={value}")
            for value in cli_filter_args(languages, language_arg):
                args.append(f"--language={value}")
            if settings["language_fallback_english"]:
                args.append("--language-fallback-english")

        for name in skipped:
            args.append(f"--skip-download={name}")

        args += self._retry_args(settings)
        if settings["chunk_size"]:
            args.append(f"--chunk-size={settings['chunk_size']}")
        if settings["bandwidth"]:
            args.append(f"--bandwidth={settings['bandwidth']}")
        return args

    @staticmethod
    def _retry_args(settings: dict[str, Any]) -> list[str]:
        args = [f"--retry={settings['retry']}", f"--idle-timeout={settings['idle_timeout']}"]
        if settings["skip_errors"]:
            args.append("--skip-errors")
        return args
