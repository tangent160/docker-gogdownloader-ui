"""Mapping of database values to the arguments the CLI's filters accept.

The CLI validates ``--os``/``--language`` strictly (``src/Enum/OperatingSystem.php``
and ``src/Enum/Language.php``) and aborts the whole run on an unknown value, so
anything that cannot be mapped must simply not be passed.
"""

from __future__ import annotations

OPERATING_SYSTEMS = ("windows", "mac", "linux")

#: code -> local name, mirroring vendor/GogDownloader/src/Enum/Language.php
LANGUAGES: dict[str, str] = {
    "en": "English",
    "bl": "български",
    "ru": "русский",
    "ar": "العربية",
    "br": "Português do Brasil",
    "jp": "日本語",
    "ko": "한국어",
    "fr": "français",
    "cn": "中文(简体)",
    "cz": "český",
    "hu": "magyar",
    "pt": "português",
    "tr": "Türkçe",
    "nl": "nederlands",
    "ro": "română",
    "es": "español",
    "pl": "polski",
    "it": "italiano",
    "de": "Deutsch",
    "da": "Dansk",
    "sv": "svenska",
    "fi": "suomi",
    "no": "norsk",
    "es_mx": "Español (AL)",
    "is": "Íslenska",
    "uk": "yкраїнська",
    "th": "ไทย",
    "zh": "中文(繁體)",
}

_LOCAL_NAME_TO_CODE = {name: code for code, name in LANGUAGES.items()}


def os_arg(platform: str) -> str | None:
    return platform if platform in OPERATING_SYSTEMS else None


def language_arg(language: str) -> str | None:
    """Accepts either a language code or a local name as stored in the db."""
    if language in LANGUAGES:
        return language
    return _LOCAL_NAME_TO_CODE.get(language)


def cli_filter_args(values: list[str], mapper) -> list[str]:
    """Map a whole filter dimension, or drop it entirely.

    Passing only the mappable values would silently exclude files the user
    selected under an unmappable one, so a single failure discards the lot.
    """
    mapped = []
    for value in values:
        arg = mapper(value)
        if arg is None:
            return []
        mapped.append(arg)
    return mapped
