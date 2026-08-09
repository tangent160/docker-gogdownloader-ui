"""Optional username/password gate for the web UI.

Credentials come from the container's environment. When either is unset the UI
is open (the usual Unraid "trusted LAN" setup) and every request is treated as
authenticated. The session cookie is an HMAC over an expiry stamp; the secret
lives in /config so sessions survive a container update.
"""

from __future__ import annotations

import base64
import hmac
import time
from hashlib import sha256

from fastapi import HTTPException, Request

from .config import Config

COOKIE_NAME = "gogui_session"
SESSION_TTL = 30 * 24 * 60 * 60  # 30 days


class Authenticator:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._secret = config.session_secret() if config.auth_required else b""

    @property
    def required(self) -> bool:
        return self._config.auth_required

    def verify_credentials(self, username: str, password: str) -> bool:
        # compare_digest on both halves so neither is a timing oracle.
        user_ok = hmac.compare_digest(username.encode(), self._config.username.encode())
        password_ok = hmac.compare_digest(password.encode(), self._config.password.encode())
        return user_ok and password_ok

    def issue_token(self) -> str:
        expiry = str(int(time.time()) + SESSION_TTL).encode()
        signature = hmac.new(self._secret, expiry, sha256).digest()
        return base64.urlsafe_b64encode(expiry + b"." + signature).decode()

    def valid_token(self, token: str | None) -> bool:
        if not token:
            return False
        try:
            raw = base64.urlsafe_b64decode(token.encode())
            expiry, signature = raw.split(b".", 1)
            expected = hmac.new(self._secret, expiry, sha256).digest()
            if not hmac.compare_digest(signature, expected):
                return False
            return int(expiry) > time.time()
        except (ValueError, TypeError):
            return False

    def is_authenticated(self, request: Request) -> bool:
        if not self.required:
            return True
        return self.valid_token(request.cookies.get(COOKIE_NAME))

    def require(self, request: Request) -> None:
        if not self.is_authenticated(request):
            raise HTTPException(status_code=401, detail="Authentication required")
