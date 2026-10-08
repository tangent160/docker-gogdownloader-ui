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
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, AsyncIterator, Callable

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


class Subscription:
    """One browser's event stream.

    Dropping a stalled client is not enough on its own: the reader would sit on
    an empty queue forever and the tab would show frozen job state behind a
    stream that still looks healthy. Closing therefore hands the reader a
    sentinel so it can end the response and let EventSource reconnect, which
    resyncs from the full job list.
    """

    def __init__(self, maxsize: int = 64) -> None:
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self.closed = False

    async def get(self) -> dict[str, Any] | None:
        """The next event, or ``None`` once the subscription is closed."""
        return await self._queue.get()

    def put(self, event: dict[str, Any]) -> bool:
        try:
            self._queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            self.close()
            return False

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        # The queue is full in the overflow case, so make room for the sentinel.
        try:
            self._queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            self._queue.put_nowait(None)
        except asyncio.QueueFull:  # pragma: no cover — room was just made
            pass


class EventBus:
    """Fan-out of job updates to every open browser tab."""

    def __init__(self) -> None:
        self._subscribers: set[Subscription] = set()

    def subscribe(self) -> Subscription:
        subscription = Subscription()
        self._subscribers.add(subscription)
        return subscription

    def unsubscribe(self, subscription: Subscription) -> None:
        self._subscribers.discard(subscription)
        subscription.close()

    def publish(self, event: dict[str, Any]) -> None:
        for subscription in list(self._subscribers):
            # A stalled client must not slow down the worker: it is dropped and
            # woken, and resyncs from /api/jobs when EventSource reconnects.
            if not subscription.put(event):
                self._subscribers.discard(subscription)


class JobQueue:
    def __init__(
        self,
        cli: GogCli,
        config: Config,
        settings: SettingsStore,
        library_empty: Callable[[], bool] = lambda: False,
    ) -> None:
        self._cli = cli
        self._config = config
        self._settings = settings
        #: Asked before a sync starts, to decide whether a search sync leaves
        #: the library partial.
        self._library_empty = library_empty
        self._jobs: dict[int, Job] = {}
        self._order: list[int] = []
        self._ids = itertools.count(1)
        self._wakeup = asyncio.Event()
        self._worker: asyncio.Task | None = None
        #: Held for the whole of a CLI invocation, by the worker and by the
        #: endpoints that run the CLI outside the queue. Checking ``busy`` is
        #: not enough for those: they await something long afterwards, and a
        #: job enqueued during that await would otherwise start a second
        #: process against the same database.
        self._gate = asyncio.Lock()
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

    @asynccontextmanager
    async def exclusive(self) -> AsyncIterator[None]:
        """Run the CLI outside the queue with the worker held off.

        Callers still check ``busy`` first so a user gets an immediate 409
        instead of a request that blocks for the length of a download; this
        closes the window between that check and the work itself.
        """
        async with self._gate:
            yield

    @asynccontextmanager
    async def try_exclusive(self) -> AsyncIterator[bool]:
        """:meth:`exclusive` for callers that must never wait.

        Yields ``False`` and runs nothing when a CLI process is already in
        flight. An endpoint the UI polls cannot use ``exclusive``: the gate is
        held for the whole of a download, so waiting on it would stall the
        poll for hours. There is no await between the check and the acquire,
        so nothing can take the gate in between.
        """
        if self._gate.locked():
            yield False
            return
        async with self._gate:
            yield True

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

        # Read before the run: a search sync marks the library partial only when
        # it was empty or already partial. A complete library stays complete.
        library_was_complete = (
            job.type is JobType.SYNC
            and self._settings.get("sync_mode") != "search"
            and not self._library_empty()
        )

        try:
            args = self._build_args(job)
            async with self._gate:
                result = await self._cli.run(
                    args, on_line=on_line, cancel_event=job.cancel_event
                )
        except Exception as error:  # noqa: BLE001 — surfaced to the user verbatim
            job.error = str(error)
            self._finish(job, JobState.FAILED)
            return

        if job.cancel_event.is_set():
            self._finish(job, JobState.CANCELLED)
        elif result.success:
            job.progress = 1.0
            if job.type is JobType.SYNC:
                self._record_sync(job, library_was_complete)
            self._finish(job, JobState.DONE)
        else:
            job.error = result.error_message
            self._finish(job, JobState.FAILED)

    def _record_sync(self, job: Job, library_was_complete: bool) -> None:
        """Store how the library was populated, once a sync has succeeded.

        A sync that fails or is cancelled leaves ``sync_mode`` as it was.
        ``--updated-only`` also fetches every owned game missing locally, so an
        incremental sync clears the partial flag like a full one.
        """
        mode = job.params.get("mode", "incremental")
        if mode == "search":
            if library_was_complete:
                return
            value = "search"
        elif mode == "incremental":
            value = "incremental"
        else:
            value = "full"
        self._settings.update({"sync_mode": value})

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
        elif mode == "search":
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
