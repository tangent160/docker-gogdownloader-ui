"""Web UI for the gog-downloader CLI."""

#: The UI's own version, distinct from the gog-downloader CLI's. This file is
#: the source of truth: `release.yml` refuses to publish a `v*` tag that does
#: not match it, and the image tag is derived from the git tag.
__version__ = "0.2.0"
