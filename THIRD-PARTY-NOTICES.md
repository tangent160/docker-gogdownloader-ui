# Third-party notices

This project uses the components that follow. Each one keeps its own license.
The code of this project is under the MIT license. See [LICENSE.md](LICENSE.md).

Some components are not in the source tree. They enter the image at build time,
or the container gets them at the first start. They are listed here because
they ship to the user inside the image.

## The gog-downloader CLI

| Item | Value |
| --- | --- |
| Project | [RikudouSage/GogDownloader](https://github.com/RikudouSage/GogDownloader) |
| License | MIT |
| How it ships | The container downloads the release phar into `/config/cli` at the first start. It is not in this repository and not in the image. |

The phar is a single file that holds the CLI and its own PHP dependencies. The
license of each of those dependencies is in the `composer.json` file and the
`composer.lock` file of the upstream project.

This project is not made by the authors of GogDownloader, and they do not
support it.

## The base image

| Item | Value |
| --- | --- |
| Image | `php:8.4-cli-bookworm` |
| PHP | [PHP License 3.01](https://www.php.net/license/3_01.txt) |
| Debian packages | Each package keeps its own license. |

The image adds these Debian packages: `libxml2-dev`, `libsqlite3-dev`,
`ca-certificates`, `curl`, `gosu`, `tini`, `python3`, `python3-pip` and
`python3-venv`. The full license text of every Debian package is in
`/usr/share/doc/<package>/copyright` inside the container. The license text of
PHP is in `/usr/local/lib/php/`.

## Python packages

`app/requirements.txt` names four packages. `pip` installs their dependencies
with them. The table gives the direct packages and the dependencies that reach
the image.

| Package | License | Project |
| --- | --- | --- |
| fastapi | MIT | https://github.com/fastapi/fastapi |
| starlette | BSD-3-Clause | https://github.com/encode/starlette |
| pydantic | MIT | https://github.com/pydantic/pydantic |
| pydantic-core | MIT | https://github.com/pydantic/pydantic-core |
| annotated-types | MIT | https://github.com/annotated-types/annotated-types |
| typing-extensions | PSF-2.0 | https://github.com/python/typing_extensions |
| typing-inspection | MIT | https://github.com/pydantic/typing-inspection |
| uvicorn | BSD-3-Clause | https://github.com/encode/uvicorn |
| click | BSD-3-Clause | https://github.com/pallets/click |
| h11 | MIT | https://github.com/python-hyper/h11 |
| httptools | MIT | https://github.com/MagicStack/httptools |
| uvloop | MIT and Apache-2.0 | https://github.com/MagicStack/uvloop |
| watchfiles | MIT | https://github.com/samuelcolvin/watchfiles |
| websockets | BSD-3-Clause | https://github.com/python-websockets/websockets |
| python-dotenv | BSD-3-Clause | https://github.com/theskumar/python-dotenv |
| PyYAML | MIT | https://github.com/yaml/pyyaml |
| httpx | BSD-3-Clause | https://github.com/encode/httpx |
| httpcore | BSD-3-Clause | https://github.com/encode/httpcore |
| anyio | MIT | https://github.com/agronholm/anyio |
| sniffio | MIT and Apache-2.0 | https://github.com/python-trio/sniffio |
| idna | BSD-3-Clause | https://github.com/kjd/idna |
| certifi | MPL-2.0 | https://github.com/certifi/python-certifi |
| python-multipart | Apache-2.0 | https://github.com/Kludex/python-multipart |

The full license text of each package is in its `*.dist-info` directory under
`/opt/venv/lib/` inside the container.

certifi is under the Mozilla Public License 2.0. The source is at the address
in the table.

## Cover art

The UI gets cover art from the public product API of GOG
(`https://api.gog.com/products/<id>`) and caches the images under `/config`.
The images belong to GOG and to the publishers of the games. They are not part
of this project, and this project gives no license for them. Set
`COVER_ART=false` to stop these requests.

This project is not made by GOG, and GOG does not support it.
