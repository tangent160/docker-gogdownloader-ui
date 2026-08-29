"""Wrapper around the gog-downloader PHP CLI.

Every invocation is a child process whose merged stdout/stderr is streamed line
by line. Symfony redraws its progress bars with bare carriage returns, so the
reader splits on ``\\r`` as well as ``\\n`` — otherwise progress would only
surface when the process exits.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Iterable

from .config import Config

LineHandler = Callable[[str], Awaitable[None] | None]

_MESSAGE_PATTERN = re.compile(r'Message: "(.+?)"')
_IN_FILE_PATTERN = re.compile(r"^In .+ line \d+:$")
#: ` 12/300 [===>------]   4% - Game Title`
PROGRESS_PATTERN = re.compile(r"(\d+)/(\d+)\s*\[[^\]]*\]\s*(\d+)%(.*)")


@dataclass
class Progress:
    current: int
    total: int
    fraction: float
    label: str


def parse_progress(line: str) -> Progress | None:
    match = PROGRESS_PATTERN.search(line.strip())
    if not match:
        return None
    current, total = int(match.group(1)), int(match.group(2))
    label = match.group(4).strip().lstrip("-").strip()
    return Progress(
        current=current,
        total=total,
        fraction=(current / total) if total else 0.0,
        label=label,
    )


@dataclass
class Result:
    exit_code: int
    output: str

    @property
    def success(self) -> bool:
        return self.exit_code == 0

    @property
    def error_message(self) -> str:
        """The actual error from CLI output.

        On failure Symfony prints the exception message, a boxed copy of it and
        finally the command's usage synopsis — so "the last line" is useless.
        """
        match = _MESSAGE_PATTERN.search(self.output)
        if match:
            return match.group(1)
        lines = self.output.splitlines()
        for index, line in enumerate(lines):
            if _IN_FILE_PATTERN.match(line.strip()):
                for candidate in lines[index + 1 :]:
                    if candidate.strip():
                        return candidate.strip()
        for line in reversed(lines):
            if line.strip():
                return line.strip()
        return f"gog-downloader failed (exit {self.exit_code})"


class GogCli:
    """Runs the CLI. Not concurrency-safe by design — see ``jobs.JobQueue``.

    The CLI owns the SQLite database in /config; two simultaneous runs would
    fight over it, so all invocations are serialised through the job queue.
    """

    def __init__(self, config: Config, phar: Callable[[], Path | None] | None = None) -> None:
        self._config = config
        #: Resolves the phar the user picked in Settings, or None to keep the
        #: one the entrypoint installed.
        self._phar = phar

    def _environment(self) -> dict[str, str]:
        environment = dict(os.environ)
        selected = self._phar() if self._phar is not None else None
        if selected is not None:
            environment["GOG_DOWNLOADER_PHAR"] = str(selected)
        environment["CONFIG_DIRECTORY"] = str(self._config.config_dir)
        environment["DOWNLOAD_DIRECTORY"] = str(self._config.download_dir)
        # Symfony's progress bars are far easier to parse without ANSI escapes.
        environment["NO_COLOR"] = "1"
        environment.pop("COLUMNS", None)
        return environment

    async def run(
        self,
        args: Iterable[str],
        on_line: LineHandler | None = None,
        cancel_event: asyncio.Event | None = None,
        cwd: Path | None = None,
    ) -> Result:
        argv = [str(self._config.cli_path), *args, "--no-interaction", "--no-ansi"]
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL,
            env=self._environment(),
            cwd=str(cwd or self._config.download_dir),
            # Own process group, so cancelling kills the CLI's own children too.
            start_new_session=True,
        )

        collected: list[str] = []
        reader = asyncio.create_task(self._pump(process, collected, on_line))
        waiter = asyncio.create_task(process.wait())

        if cancel_event is not None:
            canceller = asyncio.create_task(cancel_event.wait())
            done, _ = await asyncio.wait({waiter, canceller}, return_when=asyncio.FIRST_COMPLETED)
            if waiter not in done:
                self._terminate(process)
                await waiter
            canceller.cancel()
        else:
            await waiter

        await reader
        return Result(exit_code=process.returncode or 0, output="\n".join(collected))

    @staticmethod
    def _terminate(process: asyncio.subprocess.Process) -> None:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            process.terminate()

    @staticmethod
    async def _pump(
        process: asyncio.subprocess.Process,
        collected: list[str],
        on_line: LineHandler | None,
    ) -> None:
        assert process.stdout is not None
        buffer = bytearray()
        while True:
            chunk = await process.stdout.read(1024)
            if not chunk:
                break
            buffer.extend(chunk)
            # Split on the bytes, not on decoded text: a multi-byte character
            # straddling a chunk boundary would otherwise be decoded with
            # errors="replace" and the replacement re-encoded into the
            # remainder, corrupting it permanently.
            # Progress bars redraw with a bare \r, so both are line breaks here.
            parts = re.split(rb"[\r\n]", bytes(buffer))
            buffer = bytearray(parts.pop())
            for raw in parts:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                collected.append(line)
                if on_line is not None:
                    result = on_line(line)
                    if asyncio.iscoroutine(result):
                        await result
        trailing = buffer.decode("utf-8", errors="replace").strip()
        if trailing:
            collected.append(trailing)
            if on_line is not None:
                result = on_line(trailing)
                if asyncio.iscoroutine(result):
                    await result

    async def version(self) -> str:
        result = await self.run(["--version"])
        match = re.search(r"([0-9]+\.[0-9]+\.[0-9]+)", result.output)
        return match.group(1) if match else "unknown"

    async def code_login(self, code: str) -> Result:
        return await self.run(["code-login", code])

    async def password_login(self, email: str, password: str) -> Result:
        return await self.run(["login", email, f"--password={password}"])
