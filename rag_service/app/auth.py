"""Local account storage and short-lived HS256 JWTs for the SAE prototype."""

import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time


JWT_ISSUER = "sae-local-demo"
JWT_AUDIENCE = "sae-portal"
JWT_LIFETIME_SECONDS = 60 * 60
PASSWORD_ITERATIONS = 240_000
MIN_PASSWORD_LENGTH = 12

SEED_CANDIDATES = (
    ("vivek.reddy@sae.demo", "1", "Vivek Reddy", "DemoPass123!"),
    ("swati.chatterjee@sae.demo", "2", "Swati Chatterjee", "DemoPass123!"),
    ("rahul.menon@sae.demo", "3", "Rahul Menon", "DemoPass123!"),
)
SEED_ADMIN = ("admin@sae.demo", "SAE Demo Administrator", "AdminPass123!")


@dataclass(frozen=True)
class Account:
    email: str
    candidate_id: str | None
    display_name: str
    role: str
    salt: bytes
    password_digest: bytes
    token_version: int
    active: bool


def hash_password(password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    active_salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), active_salt, PASSWORD_ITERATIONS)
    return active_salt, digest


class AccountStore:
    """Small SQLite store for local candidate/admin accounts."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS accounts (
                    email TEXT PRIMARY KEY COLLATE NOCASE,
                    candidate_id TEXT UNIQUE,
                    display_name TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('candidate', 'admin')),
                    salt BLOB NOT NULL,
                    password_digest BLOB NOT NULL,
                    token_version INTEGER NOT NULL DEFAULT 0,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
        # SQLite creates files using the process umask; enforce private access
        # because this database contains password hashes and account metadata.
        os.chmod(self.path, 0o600)

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout = 10000")
        return db

    @staticmethod
    def _account(row) -> Account | None:
        if row is None:
            return None
        return Account(
            email=row["email"], candidate_id=row["candidate_id"],
            display_name=row["display_name"], role=row["role"],
            salt=bytes(row["salt"]), password_digest=bytes(row["password_digest"]),
            token_version=int(row["token_version"]), active=bool(row["active"]),
        )

    def seed(self, candidates: dict) -> None:
        """Insert demo identities once without resetting changed passwords."""
        with self._connect() as db:
            for email, candidate_id, name, password in SEED_CANDIDATES:
                candidate = candidates.get(candidate_id)
                if candidate is None or candidate.name != name:
                    continue
                self._insert(db, email, candidate_id, name, "candidate", password)
            email, name, password = SEED_ADMIN
            self._insert(db, email, None, name, "admin", password)

    def _insert(self, db, email, candidate_id, name, role, password) -> None:
        salt, digest = hash_password(password)
        db.execute(
            "INSERT OR IGNORE INTO accounts(email,candidate_id,display_name,role,salt,password_digest) VALUES(?,?,?,?,?,?)",
            (email.strip().lower(), candidate_id, name, role, salt, digest),
        )

    def create_candidate(self, email: str, candidate_id: str, display_name: str, password: str) -> Account:
        normalized = email.strip().lower()
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"Password must contain at least {MIN_PASSWORD_LENGTH} characters.")
        salt, digest = hash_password(password)
        try:
            with self._connect() as db:
                db.execute(
                    "INSERT INTO accounts(email,candidate_id,display_name,role,salt,password_digest) VALUES(?,?,?,?,?,?)",
                    (normalized, candidate_id, display_name.strip(), "candidate", salt, digest),
                )
        except sqlite3.IntegrityError as exc:
            raise ValueError("An account already exists for that email or candidate.") from exc
        return self.get(normalized)

    def get(self, email: str) -> Account | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM accounts WHERE email = ?", (email.strip().lower(),)).fetchone()
        return self._account(row)

    def list_candidates(self) -> list[Account]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM accounts WHERE role='candidate' ORDER BY display_name COLLATE NOCASE").fetchall()
        return [self._account(row) for row in rows]

    def list_all(self) -> list[Account]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM accounts ORDER BY role, display_name COLLATE NOCASE").fetchall()
        return [self._account(row) for row in rows]

    def set_password(self, email: str, password: str, current_password: str | None = None) -> Account:
        account = self.get(email)
        if account is None or not account.active:
            raise ValueError("Account is unavailable.")
        if current_password is not None and not verify_password(current_password, account):
            raise ValueError("Current password is incorrect.")
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"Password must contain at least {MIN_PASSWORD_LENGTH} characters.")
        salt, digest = hash_password(password)
        with self._connect() as db:
            db.execute(
                "UPDATE accounts SET salt=?, password_digest=?, token_version=token_version+1, updated_at=CURRENT_TIMESTAMP WHERE email=?",
                (salt, digest, account.email),
            )
        return self.get(account.email)

    def set_active(self, email: str, active: bool) -> Account | None:
        with self._connect() as db:
            db.execute(
                "UPDATE accounts SET active=?, token_version=token_version+1, updated_at=CURRENT_TIMESTAMP WHERE email=?",
                (int(active), email.strip().lower()),
            )
        return self.get(email)


def verify_password(password: str, account: Account) -> bool:
    _, supplied = hash_password(password, account.salt)
    return account.active and hmac.compare_digest(supplied, account.password_digest)


def load_or_create_jwt_secret(configured: str, path: Path) -> bytes:
    if configured:
        secret = configured.encode("utf-8")
        if len(secret) < 32:
            raise ValueError("JWT_SECRET_KEY must contain at least 32 bytes when configured")
        return secret
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        secret = path.read_bytes()
        if len(secret) < 32:
            raise ValueError("Saved JWT signing key is invalid; remove it and restart the local service")
        return secret
    secret = secrets.token_bytes(48)
    with os.fdopen(fd, "wb") as stream:
        stream.write(secret)
    return secret


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)


def issue_access_token(email: str, role: str, token_version: int, secret: bytes,
                       now: int | None = None) -> tuple[str, int]:
    issued = int(time.time() if now is None else now)
    expires = issued + JWT_LIFETIME_SECONDS
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": email,
        "role": role,
        "ver": token_version,
        "iss": JWT_ISSUER,
        "aud": JWT_AUDIENCE,
        "iat": issued,
        "exp": expires,
        "jti": secrets.token_urlsafe(12),
    }
    signing_input = f"{_b64encode(json.dumps(header, separators=(',', ':')).encode())}.{_b64encode(json.dumps(payload, separators=(',', ':')).encode())}"
    signature = hmac.new(secret, signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64encode(signature)}", JWT_LIFETIME_SECONDS


def verify_access_token(token: str, secret: bytes, now: int | None = None) -> dict | None:
    if len(token) > 4096:
        return None
    try:
        header_part, payload_part, signature_part = token.split(".")
        signing_input = f"{header_part}.{payload_part}"
        header = json.loads(_b64decode(header_part))
        claims = json.loads(_b64decode(payload_part))
        signature = _b64decode(signature_part)
        expected = hmac.new(secret, signing_input.encode("ascii"), hashlib.sha256).digest()
        current = int(time.time() if now is None else now)
        if not isinstance(header, dict) or not isinstance(claims, dict):
            return None
        if header != {"alg": "HS256", "typ": "JWT"} or not hmac.compare_digest(signature, expected):
            return None
        if claims.get("iss") != JWT_ISSUER or claims.get("aud") != JWT_AUDIENCE:
            return None
        subject, role, version = claims.get("sub"), claims.get("role"), claims.get("ver")
        if not isinstance(subject, str) or role not in {"candidate", "admin"}:
            return None
        if not isinstance(version, int) or version < 0:
            return None
        issued, expires = claims.get("iat"), claims.get("exp")
        if not isinstance(issued, int) or not isinstance(expires, int):
            return None
        if issued > current + 30 or expires <= current or expires - issued > JWT_LIFETIME_SECONDS:
            return None
        return claims
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        return None
