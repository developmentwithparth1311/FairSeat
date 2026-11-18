from pathlib import Path
import csv
from collections import defaultdict, deque
import ipaddress
import io
import logging
import re
import subprocess
import tempfile
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import Settings, settings
from .auth import (
    AccountStore, MIN_PASSWORD_LENGTH, issue_access_token, load_or_create_jwt_secret,
    verify_access_token, verify_password,
)
from .loaders import CandidateExport, CompanyExport, ExportData, ExportLoadError, load_exports
from .profiles import CandidateDataStore
from .skills import SkillAnalyzer


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = REPO_ROOT / "frontend"
MAX_REQUEST_BYTES = 2_100_000
MAX_CHAT_SESSIONS = 1000
logger = logging.getLogger(__name__)


class RequestBodyLimitMiddleware:
    """Bound request bodies even when the client uses chunked transfer."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BYTES):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        content_length = headers.get(b"content-length", b"")
        if content_length.isdigit() and int(content_length) > self.max_bytes:
            await self._too_large(send)
            return

        messages = []
        body_size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            messages.append(message)
            if message["type"] == "http.request":
                body_size += len(message.get("body", b""))
                if body_size > self.max_bytes:
                    await self._too_large(send)
                    return
                if not message.get("more_body", False):
                    break

        async def replay_receive():
            if messages:
                return messages.pop(0)
            return await receive()

        await self.app(scope, replay_receive, send)

    @staticmethod
    async def _too_large(send: Send) -> None:
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": b'{"detail":"Request body is too large."}'})


class DemoCsvRequest(BaseModel):
    candidates_csv: str = Field(min_length=1, max_length=1_000_000)
    companies_csv: str = Field(min_length=1, max_length=1_000_000)


class DemoRunRequest(DemoCsvRequest):
    dataset_name: str = Field(default="Synthetic demo dataset", min_length=1, max_length=100)
    synthetic: bool = False


class CandidateSimulationRequest(BaseModel):
    opportunity_ids: list[str] = Field(max_length=100)


def _csv_preview(content: str) -> tuple[int, list[dict[str, str]]]:
    reader = csv.DictReader(io.StringIO(content))
    rows = list(reader)
    return len(rows), rows[:5]


def _ensure_runner(config: Settings) -> None:
    try:
        result = subprocess.run(
            ["make", "allocator_runner"], cwd=REPO_ROOT,
            capture_output=True, text=True, timeout=90, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=503, detail=f"Could not prepare the allocation engine: {exc}") from exc
    if result.returncode != 0 or not config.engine_runner_path.is_file():
        detail = result.stderr.strip()[-1200:] or "C++ engine build failed"
        raise HTTPException(status_code=503, detail=detail)


def _validate_csv_pair(config: Settings, candidates_csv: str, companies_csv: str) -> dict:
    _ensure_runner(config)
    with tempfile.TemporaryDirectory(prefix="sae-validate-") as temp:
        root = Path(temp)
        candidates_path = root / "candidates.csv"
        companies_path = root / "companies.csv"
        candidates_path.write_text(candidates_csv, encoding="utf-8")
        companies_path.write_text(companies_csv, encoding="utf-8")
        try:
            result = subprocess.run(
                [str(config.engine_runner_path), "--validate-only", str(candidates_path), str(companies_path)],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(status_code=503, detail=f"Could not validate the CSV files: {exc}") from exc
        if result.returncode != 0:
            raise HTTPException(status_code=422, detail=result.stderr.strip() or "CSV validation failed")
        import json
        counts = json.loads(result.stdout)
        candidate_rows, candidate_preview = _csv_preview(candidates_csv)
        company_rows, company_preview = _csv_preview(companies_csv)
        return {
            "valid": True,
            "candidates": counts["candidates"],
            "companies": counts["companies"],
            "candidate_preview": candidate_preview,
            "company_preview": company_preview,
            "preview_limit": 5,
            "rows_seen": {"candidates": candidate_rows, "companies": company_rows},
        }


def demo_state_payload(app: FastAPI) -> dict:
    data: ExportData | None = app.state.data
    if data is None:
        return {
            "status": "exports_unavailable",
            "dataset_name": None,
            "dataset_kind": None,
            "error": app.state.load_error,
            "summary": None,
            "candidates": [],
            "companies": [],
            "allocation_trace": [],
            "graph": {},
            "operation_counts": {},
            "policy_rules": {},
        }

    candidates = data.candidates_export.candidates
    companies = data.companies_export.companies
    assigned = sum(candidate.allocation.status == "matched" for candidate in candidates)
    total_seats = sum(company.seats for company in companies)
    seats_filled = sum(company.seats_filled for company in companies)
    return {
        "status": "ready",
        "dataset_name": app.state.dataset_name,
        "dataset_kind": app.state.dataset_kind,
        "policy_version": data.candidates_export.policy_version or "legacy policy",
        "algorithm": data.candidates_export.algorithm or "candidate-proposing-deferred-acceptance",
        "schema_version": data.candidates_export.schema_version,
        "policy_rules": data.candidates_export.policy_rules,
        "summary": {
            "candidates": len(candidates),
            "companies": len(companies),
            "assigned": assigned,
            "unmatched": len(candidates) - assigned,
            "seats_filled": seats_filled,
            "total_seats": total_seats,
            "capacity_utilization": seats_filled / total_seats if total_seats else 0.0,
        },
        "candidates": [candidate.model_dump() for candidate in candidates],
        "companies": [company.model_dump() for company in companies],
        "allocation_trace": [event.model_dump() for event in data.candidates_export.allocation_trace],
        "graph": data.candidates_export.graph,
        "operation_counts": data.candidates_export.operation_counts,
        "scoring_weights": data.candidates_export.scoring_weights,
    }


class ChatRequest(BaseModel):
    candidate_id: str = Field(min_length=1, max_length=100)
    session_id: str | None = Field(default=None, max_length=100)
    message: str = Field(min_length=1)
    debug: bool = False


class CandidateChatRequest(BaseModel):
    session_id: str | None = Field(default=None, max_length=100)
    message: str = Field(min_length=1)


class LoginRequest(BaseModel):
    email: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=128)
    role: str = Field(default="candidate", pattern="^(candidate|admin)$")


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=128)


class CreateAccountRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    candidate_id: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=128)


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=128)


class AccountStatusRequest(BaseModel):
    active: bool


class CandidateProfileUpdate(BaseModel):
    expected_profile_version: int | None = Field(default=None, ge=1)
    skills: list[str] = Field(max_length=80)
    cgpa: float = Field(ge=0, le=10)
    sector: str = Field(min_length=1, max_length=80)
    location: str = Field(min_length=1, max_length=120)
    qualifications: list[str] = Field(max_length=40)
    preferred_locations: list[str] = Field(max_length=40)
    sector_interests: list[str] = Field(max_length=40)


class CandidatePreferencesUpdate(BaseModel):
    expected_profile_version: int | None = Field(default=None, ge=1)
    opportunity_ids: list[str] = Field(max_length=100)


class OpportunityInput(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=160)
    required_skills: list[str] = Field(max_length=100)
    seats: int = Field(ge=0, le=100_000)
    required_qualifications: list[str] = Field(default_factory=list, max_length=100)
    sector: str = Field(min_length=1, max_length=80)
    location: str = Field(min_length=1, max_length=120)


class OpportunitiesUpdate(BaseModel):
    opportunities: list[OpportunityInput] = Field(min_length=1, max_length=1000)
    expected_version: int | None = Field(default=None, ge=0)


class ReloadResponse(BaseModel):
    candidates: int
    companies: int
    status: str


def create_app(config: Settings = settings) -> FastAPI:
    app = FastAPI(title="SAE Candidate Assistant", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[],
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT"],
        allow_headers=["*"],
    )
    app.state.config = config
    app.state.jwt_secret = load_or_create_jwt_secret(config.jwt_secret_key, config.jwt_secret_path)
    app.state.accounts = AccountStore(config.auth_db_path)
    profile_db_path = config.data_db_path or Path(config.auth_db_path).with_name("sae.sqlite3")
    app.state.profiles = CandidateDataStore(profile_db_path)
    app.state.profiles.initialize_from_csv(REPO_ROOT / "data" / "candidates.csv", REPO_ROOT / "data" / "companies.csv")
    app.state.accounts.seed({item["candidate_id"]: item for item in app.state.profiles.list_candidates()})
    app.state.data = None
    app.state.demo_allocation_published = False
    app.state.load_error = None
    app.state.analyzer = None
    app.state.kb_index = None
    app.state.retriever = None
    app.state.sessions = {}
    app.state.llm = None
    app.state.demo_directory = None
    app.state.dataset_name = "Existing export"
    app.state.dataset_kind = "saved_export"
    app.state.allocation_lock = threading.Lock()
    app.state.retrieval_mode = "not_ready"
    request_events: dict[tuple[str, str], deque[float]] = defaultdict(deque)
    app.add_middleware(RequestBodyLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)

    def build_local_retriever(data: ExportData) -> None:
        from .kb_index import KBIndex, LocalHashingEmbedder
        from .retriever import Retriever

        index = KBIndex.build_or_load(
            Path(config.kb_dir), data.companies, Path(config.index_dir) / "local-hashing",
            embedder=LocalHashingEmbedder(), model_name=LocalHashingEmbedder.model_name,
        )
        app.state.kb_index = index
        app.state.retriever = Retriever(
            index, company_names=[company.name for company in data.companies.values()],
            minimum_similarity=min(config.min_similarity, 0.04),
        )
        app.state.retrieval_mode = "offline-hashing"

    @app.middleware("http")
    async def local_access_and_rate_limits(request: Request, call_next):
        peer = request.client.host if request.client else ""
        if not peer:
            return JSONResponse(status_code=403, content={"detail": "This prototype accepts local connections only."})
        try:
            peer_ip = ipaddress.ip_address(peer)
            if isinstance(peer_ip, ipaddress.IPv6Address) and peer_ip.ipv4_mapped:
                peer_ip = peer_ip.ipv4_mapped
            if not peer_ip.is_loopback:
                return JSONResponse(status_code=403, content={"detail": "This prototype accepts local connections only."})
        except ValueError:
            if peer != "testclient":
                return JSONResponse(status_code=403, content={"detail": "This prototype accepts local connections only."})

        path = request.url.path
        if path in {"/auth/login", "/auth/password"}:
            limit = 10
            bucket = "login"
        elif path.startswith("/auth/admin/"):
            limit = 10
            bucket = "login"
        elif path in {"/admin/allocations/run", "/demo/validate", "/demo/run", "/me/simulate-preferences"}:
            limit = 12
            bucket = "allocation"
        elif path.startswith("/admin/"):
            limit = 120 if request.method == "GET" else 5
            bucket = "admin_read" if request.method == "GET" else "admin_write"
        elif path in {"/chat", "/me/chat"}:
            limit = 20
            bucket = "chat"
        else:
            limit = 120
            bucket = "other"
        now = time.monotonic()
        events = request_events[(peer, bucket)]
        while events and now - events[0] >= 60:
            events.popleft()
        if len(events) >= limit:
            return JSONResponse(status_code=429, content={"detail": "Too many requests. Wait a minute and try again."})
        events.append(now)
        return await call_next(request)

    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def frontend():
        return FileResponse(FRONTEND_DIR / "index.html")

    def reload_data() -> ExportData:
        if app.state.demo_directory is not None:
            app.state.demo_directory.cleanup()
            app.state.demo_directory = None
        data = load_exports(Path(config.export_dir))
        if Path(config.export_dir).resolve() != (REPO_ROOT / "exports").resolve():
            app.state.profiles.import_missing_export_records(data)
        app.state.data = data
        app.state.analyzer = SkillAnalyzer(data, Path(config.kb_dir) / "skill_aliases.json")
        app.state.load_error = None
        app.state.kb_index = None
        app.state.retriever = None
        app.state.retrieval_mode = "not_ready"
        app.state.sessions.clear()
        app.state.dataset_name = "Existing export"
        app.state.dataset_kind = "saved_export"
        app.state.demo_allocation_published = False
        try:
            build_local_retriever(data)
        except (RuntimeError, OSError, ValueError) as exc:
            logger.warning("Offline knowledge index could not be prepared: %s", exc)
        return data

    try:
        reload_data()
    except ExportLoadError as exc:
        app.state.load_error = str(exc)
        app.state.accounts.seed({})

    def restore_active_allocation() -> bool:
        saved = app.state.profiles.active_run()
        if saved is None:
            app.state.demo_allocation_published = False
            return False
        snapshot = saved["snapshot"]
        try:
            candidate_export = CandidateExport.model_validate(snapshot["candidates_export"])
            company_export = CompanyExport.model_validate(snapshot["companies_export"])
        except (KeyError, ValueError) as exc:
            logger.exception("Saved allocation run %s cannot be loaded", saved["run_id"])
            app.state.load_error = f"Saved allocation run could not be loaded: {exc}"
            return False
        data = ExportData(candidates_export=candidate_export, companies_export=company_export)
        app.state.data = data
        app.state.analyzer = SkillAnalyzer(data, Path(config.kb_dir) / "skill_aliases.json")
        app.state.dataset_name = snapshot.get("dataset_name", "Saved allocation")
        app.state.dataset_kind = snapshot.get("dataset_kind", "synthetic")
        app.state.demo_allocation_published = True
        app.state.load_error = None
        try:
            build_local_retriever(data)
        except (RuntimeError, OSError, ValueError) as exc:
            logger.warning("Offline knowledge index could not be prepared for the saved allocation: %s", exc)
        return True

    restore_active_allocation()

    def current_data() -> ExportData:
        if app.state.data is None:
            raise HTTPException(status_code=503, detail=app.state.load_error or "SAE exports are unavailable")
        return app.state.data

    def account_candidate(account):
        candidate = app.state.profiles.get_candidate(account.candidate_id or "")
        if candidate is None or candidate["name"] != account.display_name:
            raise HTTPException(status_code=404, detail="This candidate profile is unavailable.")
        return candidate

    def current_identity(request: Request):
        authorization = request.headers.get("authorization", "")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(status_code=401, detail="Sign in to access this page.")
        claims = verify_access_token(token, app.state.jwt_secret)
        if claims is None:
            raise HTTPException(status_code=401, detail="Your sign-in has expired. Please sign in again.")
        account = app.state.accounts.get(claims["sub"])
        if (account is None or not account.active or account.role != claims["role"]
                or account.token_version != claims["ver"]):
            raise HTTPException(status_code=401, detail="Your sign-in is no longer valid. Please sign in again.")
        return account

    def current_candidate(request: Request):
        account = current_identity(request)
        if account.role != "candidate":
            raise HTTPException(status_code=403, detail="Candidate sign-in is required.")
        candidate = account_candidate(account)
        return account, candidate

    def current_admin(request: Request):
        account = current_identity(request)
        if account.role != "admin":
            raise HTTPException(status_code=403, detail="Allocator sign-in is required.")
        return account

    def authorize_candidate_record(request: Request, candidate_id: str):
        account = current_identity(request)
        if account.role == "admin":
            return account
        if account.role != "candidate" or account.candidate_id != candidate_id:
            raise HTTPException(status_code=403, detail="You can only access the signed-in candidate's record.")
        account_candidate(account)
        return account

    @app.get("/auth/demo-profiles")
    def demo_profiles():
        accounts = app.state.accounts.list_candidates()
        profiles_by_id = {item["candidate_id"]: item for item in app.state.profiles.list_candidates()}
        profiles = [
            {"email": item.email, "display_name": item.display_name, "candidate_id": item.candidate_id}
            for item in accounts
            if item.active and item.candidate_id in profiles_by_id
            and profiles_by_id[item.candidate_id]["name"] == item.display_name
        ]
        return {"profiles": profiles}

    @app.post("/auth/login")
    def login(body: LoginRequest):
        account = app.state.accounts.get(body.email)
        if account is None or not verify_password(body.password, account) or account.role != body.role:
            raise HTTPException(status_code=401, detail="Email or password is incorrect.")
        if account.role == "candidate":
            candidate = account_candidate(account)
            display_name = candidate["name"]
        else:
            display_name = account.display_name
        token, expires_in = issue_access_token(account.email, account.role, account.token_version, app.state.jwt_secret)
        return {
            "access_token": token,
            "token_type": "bearer",
            "expires_in": expires_in,
            "role": account.role,
            "profile": {"name": display_name, "email": account.email},
        }

    @app.post("/auth/password")
    def change_password(body: PasswordChangeRequest, request: Request):
        account = current_identity(request)
        try:
            updated = app.state.accounts.set_password(account.email, body.new_password, body.current_password)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        token, expires_in = issue_access_token(updated.email, updated.role, updated.token_version, app.state.jwt_secret)
        return {"access_token": token, "token_type": "bearer", "expires_in": expires_in, "role": updated.role}

    @app.get("/auth/me")
    def auth_me(request: Request):
        account = current_identity(request)
        if account.role == "admin":
            return {"profile": {"name": account.display_name, "email": account.email, "role": "admin"}}
        candidate = account_candidate(account)
        return {"profile": {
            "candidate_id": candidate["candidate_id"],
            "name": candidate["name"],
            "email": account.email,
            "sector": candidate["sector"],
            "role": "candidate",
        }}

    def candidate_portal_payload(account):
        profile = app.state.profiles.candidate_view(account.candidate_id, config.engine_policy_path)
        if profile is None or profile["name"] != account.display_name:
            raise HTTPException(status_code=404, detail="This candidate profile is unavailable.")
        run = app.state.profiles.active_run()
        result = app.state.profiles.active_candidate_result(account.candidate_id)
        if result is None:
            profile["allocation"] = {"status": "pending", "company_id": None, "score": None, "preference_rank": None}
            profile["allocation_status"] = "not_allocated"
            profile["allocation_message"] = {
                "profile_updated": "Your profile or preferences changed. Your previous result is retained in history; the admin must run allocation again.",
                "opportunities_updated": "Opportunity requirements or seats changed. Your previous result is retained in history; the admin must run allocation again.",
                "reset": "The admin reset the current allocation. Your profile and preferences are still saved.",
            }.get(profile["allocation_state"]["status"], "Your profile is saved. An allocation has not been published yet.")
        else:
            company = next((item for item in run["snapshot"]["companies_export"]["companies"]
                            if item["id"] == result["allocation"].get("company_id")), None)
            profile["allocation"] = result["allocation"]
            profile["allocation_status"] = "allocated"
            profile["allocation_message"] = f"Latest published result · run {run['run_id'][:8]} · {run['created_at']}"
            profile["assigned_company"] = company
            profile["explanation"] = app.state.analyzer.explain_outcome(account.candidate_id) if app.state.analyzer else None
            profile["skill_gap"] = app.state.analyzer.skill_gap(account.candidate_id) if app.state.analyzer else None
            profile["policy_version"] = run["policy_version"]
            profile["dataset_name"] = run["snapshot"].get("dataset_name", "Saved allocation")
            profile["synthetic"] = run["snapshot"].get("dataset_kind") == "synthetic"
            profile["run_id"] = run["run_id"]
            company_names = {item["id"]: item["name"] for item in run["snapshot"]["companies_export"]["companies"]}
            trace = run["snapshot"].get("candidates_export", {}).get("allocation_trace", [])
            profile["allocation_replay"] = [
                {
                    "step": index + 1,
                    "type": event["type"],
                    "company_id": event.get("company_id"),
                    "company": company_names.get(event.get("company_id")),
                    "score": event.get("score") if event["type"] not in {"completion", "unmatched"} else None,
                    "reason_code": event.get("reason_code"),
                }
                for index, event in enumerate(
                    item for item in trace if item.get("candidate_id") == account.candidate_id
                )
            ]
        return profile

    @app.get("/me/profile")
    def my_profile(request: Request):
        account, _ = current_candidate(request)
        return candidate_portal_payload(account)

    @app.put("/me/profile")
    def update_my_profile(body: CandidateProfileUpdate, request: Request):
        account, profile = current_candidate(request)
        values = body.model_dump(exclude={"expected_profile_version"})
        values.update({"name": profile["name"]})
        values["sector"] = values["sector"].strip()
        values["location"] = values["location"].strip()
        if not values["sector"] or not values["location"]:
            raise HTTPException(status_code=422, detail="Sector and location cannot be blank.")
        for key in ("skills", "qualifications", "preferred_locations", "sector_interests"):
            values[key] = list(dict.fromkeys(item.strip() for item in values[key] if item.strip()))
        try:
            updated = app.state.profiles.update_candidate(account.candidate_id, values, body.expected_profile_version)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if updated is None:
            raise HTTPException(status_code=404, detail="Candidate profile not found.")
        app.state.demo_allocation_published = False
        app.state.sessions.clear()
        return candidate_portal_payload(account)

    @app.put("/me/preferences")
    def update_my_preferences(body: CandidatePreferencesUpdate, request: Request):
        account, _ = current_candidate(request)
        try:
            app.state.profiles.update_preferences(account.candidate_id, body.opportunity_ids, body.expected_profile_version)
        except ValueError as exc:
            status = 409 if str(exc).startswith("Your profile changed") else 422
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        app.state.demo_allocation_published = False
        app.state.sessions.clear()
        return candidate_portal_payload(account)

    @app.get("/me/result")
    def my_result(request: Request):
        account, _ = current_candidate(request)
        return candidate_portal_payload(account)

    @app.post("/me/chat")
    def my_chat(body: CandidateChatRequest, request: Request):
        account, _ = current_candidate(request)
        if not app.state.demo_allocation_published or app.state.data is None:
            raise HTTPException(status_code=409, detail="The assistant can explain your result after an allocation is published.")
        candidate = app.state.data.candidates.get(account.candidate_id)
        if candidate is None:
            raise HTTPException(status_code=404, detail="Your result is not included in the current allocation.")
        return build_chat_response(ChatRequest(
            candidate_id=candidate.id,
            session_id=body.session_id,
            message=body.message,
        ))

    @app.get("/health")
    def health():
        data = app.state.data
        external_provider = config.llm_provider in {"gemini", "groq"}
        provider_name = {"gemini": "Google Gemini", "groq": "Groq"}.get(config.llm_provider)
        provider_ready = config.llm_provider == "mock" or (
            external_provider and bool(config.llm_api_key and config.llm_model)
        )
        return {
            "status": "ok" if data else "exports_unavailable",
            "exports_loaded": data is not None,
            "candidates": len(data.candidates) if data else 0,
            "companies": len(data.companies) if data else 0,
            "kb_chunks": len(app.state.kb_index.chunks) if app.state.kb_index else 0,
            "retrieval_mode": app.state.retrieval_mode,
            "llm_provider": config.llm_provider,
            "llm_provider_ready": provider_ready,
            "external_llm_processing": external_provider,
            "privacy_notice": (
                f"{provider_name} is enabled. Minimized candidate result and skill facts, your question, and up to "
                f"{config.max_history_turns} recent chat turns may be sent to {provider_name} for a response."
                if external_provider else "The mock provider runs locally; chat data is not sent to an external LLM."
            ),
            "error": app.state.load_error,
        }

    @app.get("/demo/sample")
    def demo_sample():
        candidates_path = REPO_ROOT / "data" / "candidates.csv"
        companies_path = REPO_ROOT / "data" / "companies.csv"
        return {
            "dataset_name": "Synthetic sample data",
            "candidates_csv": candidates_path.read_text(encoding="utf-8"),
            "companies_csv": companies_path.read_text(encoding="utf-8"),
        }

    @app.post("/demo/validate")
    def demo_validate(body: DemoCsvRequest, request: Request):
        current_admin(request)
        return _validate_csv_pair(config, body.candidates_csv, body.companies_csv)

    @app.post("/demo/run")
    def demo_run(body: DemoRunRequest, request: Request):
        current_admin(request)
        if not body.synthetic and not config.allow_real_data:
            raise HTTPException(
                status_code=403,
                detail="Real candidate data is disabled. Mark synthetic uploads as synthetic, or explicitly enable SAE_ALLOW_REAL_DATA for an authorized local evaluation.",
            )
        _validate_csv_pair(config, body.candidates_csv, body.companies_csv)
        temp = tempfile.TemporaryDirectory(prefix="sae-demo-run-")
        root = Path(temp.name)
        candidates_path = root / "candidates.csv"
        companies_path = root / "companies.csv"
        output_path = root / "exports"
        candidates_path.write_text(body.candidates_csv, encoding="utf-8")
        companies_path.write_text(body.companies_csv, encoding="utf-8")
        try:
            result = subprocess.run(
                [str(config.engine_runner_path), str(candidates_path), str(companies_path),
                 str(output_path), str(config.engine_policy_path)],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=60, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            temp.cleanup()
            raise HTTPException(status_code=503, detail=f"Allocation could not be completed: {exc}") from exc
        if result.returncode != 0:
            temp.cleanup()
            raise HTTPException(status_code=422, detail=result.stderr.strip() or "Allocation failed")
        try:
            data = load_exports(output_path)
        except ExportLoadError as exc:
            temp.cleanup()
            raise HTTPException(status_code=500, detail=f"Engine produced invalid exports: {exc}") from exc

        old_temp = app.state.demo_directory
        app.state.data = data
        app.state.analyzer = SkillAnalyzer(data, Path(config.kb_dir) / "skill_aliases.json")
        app.state.load_error = None
        app.state.kb_index = None
        app.state.retriever = None
        app.state.retrieval_mode = "not_ready"
        app.state.sessions.clear()
        app.state.demo_directory = temp
        app.state.dataset_name = body.dataset_name.strip()
        app.state.dataset_kind = "synthetic" if body.synthetic else "uploaded"
        app.state.accounts.seed({item["candidate_id"]: item for item in app.state.profiles.list_candidates()})
        app.state.demo_allocation_published = True
        try:
            build_local_retriever(data)
        except (RuntimeError, OSError, ValueError) as exc:
            logger.warning("Could not refresh offline knowledge index after allocation: %s", exc)
        if old_temp is not None:
            old_temp.cleanup()
        return demo_state_payload(app)

    @app.get("/demo/state")
    def demo_state(request: Request):
        current_admin(request)
        return demo_state_payload(app)

    @app.get("/demo/scenarios")
    def demo_scenarios(request: Request):
        current_admin(request)
        try:
            built = subprocess.run(
                ["make", "tools/phase3_scenarios"], cwd=REPO_ROOT,
                capture_output=True, text=True, timeout=90, check=False,
            )
            if built.returncode != 0:
                raise HTTPException(status_code=503, detail=built.stderr.strip()[-1200:] or "Scenario tool build failed")
            result = subprocess.run(
                [str(REPO_ROOT / "tools" / "phase3_scenarios"), "400", "24", "25033"],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=30, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HTTPException(status_code=503, detail=f"Scenario report is unavailable: {exc}") from exc
        if result.returncode != 0:
            raise HTTPException(status_code=503, detail=result.stderr.strip() or "Scenario report failed")
        return {"seed": 25033, "synthetic": True, "rows": list(csv.DictReader(io.StringIO(result.stdout)))}

    @app.get("/candidates/{candidate_id}/summary")
    def summary(candidate_id: str, request: Request):
        from .guardrails import DISCLAIMER
        authorize_candidate_record(request, candidate_id)
        data = current_data()
        if candidate_id not in data.candidates:
            raise HTTPException(status_code=404, detail=f"Unknown candidate id: {candidate_id}")
        if not app.state.demo_allocation_published:
            raise HTTPException(status_code=409, detail="No allocation has been published yet.")
        return {**app.state.analyzer.explain_outcome(candidate_id), "disclaimer": DISCLAIMER}

    @app.get("/candidates/{candidate_id}/skill-gap")
    def skill_gap(candidate_id: str, request: Request, sector: str | None = None):
        from .guardrails import DISCLAIMER
        authorize_candidate_record(request, candidate_id)
        data = current_data()
        if candidate_id not in data.candidates:
            raise HTTPException(status_code=404, detail=f"Unknown candidate id: {candidate_id}")
        if not app.state.demo_allocation_published:
            raise HTTPException(status_code=409, detail="Skill-gap results will be available after an allocation is published.")
        return {**app.state.analyzer.skill_gap(candidate_id, sector), "disclaimer": DISCLAIMER}

    def admin_dashboard_payload() -> dict:
        profiles = app.state.profiles.list_candidates()
        opportunities = app.state.profiles.list_opportunities()
        state = app.state.profiles.allocation_state()
        run = app.state.profiles.active_run()
        summary = run["snapshot"].get("summary") if run else None
        if summary is None:
            summary = {
                "candidates": 0, "companies": 0, "assigned": 0, "unmatched": 0,
                "seats_filled": 0, "total_seats": 0, "capacity_utilization": 0.0,
            }
        return {
            "allocation_state": state,
            "candidate_count": len(profiles),
            "opportunity_count": len(opportunities),
            "summary": summary,
            "current_run": ({"run_id": run["run_id"], "created_at": run["created_at"],
                             "created_by": run["created_by"], "policy_version": run["policy_version"]}
                            if run else None),
            "history": app.state.profiles.allocation_history(),
        }

    @app.get("/admin/dashboard")
    def admin_dashboard(request: Request):
        current_admin(request)
        return admin_dashboard_payload()

    @app.get("/admin/candidates")
    def admin_candidates(request: Request):
        current_admin(request)
        accounts = {item.candidate_id: item for item in app.state.accounts.list_candidates()}
        opportunities_by_id = {
            item["id"]: item["name"] for item in app.state.profiles.list_opportunities()
        }
        state = app.state.profiles.allocation_state()
        results = {}
        run = app.state.profiles.active_run()
        if run:
            results = {item["id"]: item for item in run["snapshot"]["candidates_export"]["candidates"]}
        rows = []
        for profile in app.state.profiles.list_candidates():
            account = accounts.get(profile["candidate_id"])
            result = results.get(profile["candidate_id"])
            candidate_view = app.state.profiles.candidate_view(profile["candidate_id"], config.engine_policy_path)
            rows.append({
                **profile,
                "email": account.email if account else None,
                "preferences": [{"id": item["id"], "name": item["name"]}
                                for item in candidate_view["preferences"]],
                "allocation": result["allocation"] if result else None,
                "allocation_company": opportunities_by_id.get(result["allocation"].get("company_id")) if result else None,
                "allocation_status": "current" if result else state["status"],
            })
        return {"version": state["version"], "candidates": rows}

    @app.get("/admin/opportunities")
    def admin_opportunities(request: Request):
        current_admin(request)
        return {"version": app.state.profiles.allocation_state()["version"],
                "opportunities": app.state.profiles.list_opportunities()}

    @app.put("/admin/opportunities")
    def update_admin_opportunities(body: OpportunitiesUpdate, request: Request):
        current_admin(request)
        opportunities = [item.model_dump() for item in body.opportunities]
        ids = [item["id"] for item in opportunities]
        if len(set(ids)) != len(ids):
            raise HTTPException(status_code=422, detail="Opportunity IDs must be unique.")
        try:
            for item in opportunities:
                int(item["id"])
                item["name"] = item["name"].strip()
                item["sector"] = item["sector"].strip()
                item["location"] = item["location"].strip()
                for key in ("required_skills", "required_qualifications"):
                    item[key] = list(dict.fromkeys(value.strip() for value in item[key] if value.strip()))
                if not item["name"] or not item["sector"] or not item["location"]:
                    raise ValueError("Opportunity name, sector, and location cannot be blank.")
            app.state.profiles.save_opportunities(opportunities, body.expected_version)
        except ValueError as exc:
            status = 409 if str(exc).startswith("Candidate or opportunity data changed") else 422
            raise HTTPException(status_code=status, detail=str(exc)) from exc
        app.state.demo_allocation_published = False
        app.state.sessions.clear()
        return admin_dashboard_payload()

    @app.post("/admin/allocations/run")
    def admin_run_allocation(request: Request):
        admin = current_admin(request)
        if not app.state.allocation_lock.acquire(blocking=False):
            raise HTTPException(status_code=409, detail="An allocation is already running.")
        previous = (app.state.data, app.state.analyzer, app.state.dataset_name,
                    app.state.dataset_kind, app.state.demo_allocation_published)
        temp = None
        try:
            try:
                candidates_csv, companies_csv, profile_snapshot = app.state.profiles.allocator_csv(config.engine_policy_path)
            except (OSError, ValueError) as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            _validate_csv_pair(config, candidates_csv, companies_csv)
            temp = tempfile.TemporaryDirectory(prefix="sae-database-allocation-")
            root = Path(temp.name)
            candidates_path, companies_path, output_path = root / "candidates.csv", root / "opportunities.csv", root / "exports"
            candidates_path.write_text(candidates_csv, encoding="utf-8")
            companies_path.write_text(companies_csv, encoding="utf-8")
            try:
                completed = subprocess.run(
                    [str(config.engine_runner_path), str(candidates_path), str(companies_path),
                     str(output_path), str(config.engine_policy_path)],
                    cwd=REPO_ROOT, capture_output=True, text=True, timeout=60, check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise HTTPException(status_code=503, detail=f"Allocation could not be completed: {exc}") from exc
            if completed.returncode != 0:
                raise HTTPException(status_code=422, detail=completed.stderr.strip() or "Allocation failed")
            try:
                data = load_exports(output_path)
            except ExportLoadError as exc:
                raise HTTPException(status_code=500, detail=f"Engine produced invalid exports: {exc}") from exc
            original_company_ids = {engine_id: company_id for company_id, engine_id
                                    in profile_snapshot.get("engine_company_id_map", {}).items()}
            original_candidate_ids = {engine_id: candidate_id for candidate_id, engine_id
                                      in profile_snapshot.get("engine_candidate_id_map", {}).items()}
            for company in data.companies_export.companies:
                company.id = original_company_ids.get(company.id, company.id)
            for candidate in data.candidates_export.candidates:
                candidate.id = original_candidate_ids.get(candidate.id, candidate.id)
                if candidate.allocation.company_id is not None:
                    candidate.allocation.company_id = original_company_ids.get(
                        candidate.allocation.company_id, candidate.allocation.company_id,
                    )
                for choice in candidate.top_choices:
                    choice.company_id = original_company_ids.get(choice.company_id, choice.company_id)
            for event in data.candidates_export.allocation_trace:
                event.candidate_id = original_candidate_ids.get(event.candidate_id, event.candidate_id)
                if event.displaced_candidate_id is not None:
                    event.displaced_candidate_id = original_candidate_ids.get(
                        event.displaced_candidate_id, event.displaced_candidate_id,
                    )
                if event.company_id is not None:
                    event.company_id = original_company_ids.get(event.company_id, event.company_id)
            app.state.data = data
            app.state.analyzer = SkillAnalyzer(data, Path(config.kb_dir) / "skill_aliases.json")
            app.state.dataset_name = "Candidate database"
            app.state.dataset_kind = "synthetic"
            app.state.demo_allocation_published = True
            app.state.sessions.clear()
            payload = demo_state_payload(app)
            payload.update({
                "candidates_export": data.candidates_export.model_dump(),
                "companies_export": data.companies_export.model_dump(),
                "profile_snapshot": profile_snapshot["candidates"],
                "dataset_name": app.state.dataset_name,
                "dataset_kind": app.state.dataset_kind,
            })
            try:
                run_id = app.state.profiles.publish_allocation(profile_snapshot["version"], admin.email, payload)
            except RuntimeError as exc:
                (app.state.data, app.state.analyzer, app.state.dataset_name,
                 app.state.dataset_kind, app.state.demo_allocation_published) = previous
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            try:
                build_local_retriever(data)
            except (RuntimeError, OSError, ValueError) as exc:
                logger.warning("Could not refresh offline knowledge index after allocation: %s", exc)
            return {**payload, "run_id": run_id, "allocation_state": app.state.profiles.allocation_state()}
        finally:
            if temp is not None:
                temp.cleanup()
            app.state.allocation_lock.release()

    @app.post("/admin/allocations/reset")
    def admin_reset_allocation(request: Request):
        current_admin(request)
        state = app.state.profiles.reset_allocation()
        app.state.demo_allocation_published = False
        app.state.sessions.clear()
        return {"allocation_state": state, "summary": {
            "candidates": 0, "companies": 0, "assigned": 0, "unmatched": 0,
            "seats_filled": 0, "total_seats": 0, "capacity_utilization": 0.0,
        }, "message": "Current allocation reset. Candidate profiles and run history were retained."}

    @app.get("/admin/allocations/history")
    def admin_allocation_history(request: Request):
        current_admin(request)
        return {"history": app.state.profiles.allocation_history()}

    @app.get("/admin/allocations/current")
    def admin_current_allocation(request: Request):
        current_admin(request)
        run = app.state.profiles.active_run()
        if run is None:
            return {"current_run": None}
        return {**run["snapshot"], "run_id": run["run_id"], "created_at": run["created_at"],
                "allocation_state": app.state.profiles.allocation_state()}

    @app.post("/admin/reload", response_model=ReloadResponse)
    def reload_endpoint(request: Request):
        current_admin(request)
        try:
            data = reload_data()
        except ExportLoadError as exc:
            app.state.load_error = str(exc)
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"candidates": len(data.candidates), "companies": len(data.companies), "status": "reloaded"}

    @app.post("/admin/reindex")
    def reindex_endpoint(request: Request):
        current_admin(request)
        data = current_data()
        try:
            from .kb_index import KBIndex
            from .retriever import Retriever

            index = KBIndex.build_or_load(
                Path(config.kb_dir), data.companies, Path(config.index_dir) / "sentence-transformer",
                model_name=config.embed_model,
            )
            app.state.kb_index = index
            app.state.retriever = Retriever(
                index,
                company_names=[company.name for company in data.companies.values()],
                minimum_similarity=config.min_similarity,
            )
            app.state.retrieval_mode = "sentence-transformer"
        except (RuntimeError, OSError, ValueError) as exc:
            raise HTTPException(status_code=503, detail=f"Could not build knowledge index: {exc}") from exc
        return {"status": "reindexed", "kb_chunks": len(index.chunks)}

    def build_chat_response(request: ChatRequest):
        from .guardrails import (
            DISCLAIMER, InputError, asks_for_other_candidate, clean_message,
            is_out_of_scope, unverified_numbers,
        )

        try:
            message = clean_message(request.message)
        except InputError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        data = current_data()
        candidate = data.candidates.get(request.candidate_id)
        if candidate is None:
            raise HTTPException(status_code=404, detail=f"Unknown candidate id: {request.candidate_id}")

        if asks_for_other_candidate(message, candidate.id):
            return {
                "answer": "I can only help with the candidate record selected for this chat.",
                "sources": [], "facts_used": {}, "disclaimer": DISCLAIMER,
            }

        known_skills = {
            skill.lower() for company in data.companies.values()
            for skill in company.required_skills
        }
        known_skills.update(skill.lower() for skill in candidate.skills)
        if is_out_of_scope(message, known_skills):
            return {
                "answer": "I can help with SAE allocation results, PM Internship Scheme information in the knowledge base, and skill guidance.",
                "sources": [], "facts_used": {}, "disclaimer": DISCLAIMER,
            }

        sectors = {company.sector for company in data.companies.values() if company.sector}
        requested_sector = next((
            sector for sector in sorted(sectors, key=len, reverse=True)
            if re.search(rf"\b{re.escape(sector)}\b", message, re.I)
        ), None)
        retrieval_query = message
        if re.search(r"skill|learn|improv|what should i study|missing", message, re.I):
            gap = app.state.analyzer.skill_gap(candidate.id, sector=requested_sector)
            retrieval_query += " " + " ".join(item["skill"] for item in gap["missing_ranked"][:3])
        retrieved = []
        if app.state.retriever is not None:
            retrieved = app.state.retriever.retrieve(retrieval_query, k=config.top_k_chunks)

        session_id = request.session_id or str(uuid.uuid4())
        session_key = (candidate.id, session_id)
        if session_key not in app.state.sessions and len(app.state.sessions) >= MAX_CHAT_SESSIONS:
            app.state.sessions.pop(next(iter(app.state.sessions)))
        history = app.state.sessions.get(session_key, [])
        from .prompts import build_prompt
        system, messages, facts = build_prompt(
            candidate, app.state.analyzer, message, retrieved, history,
            max_history_turns=config.max_history_turns,
            sector=requested_sector,
        )

        from .llm import LLMError, create_llm
        try:
            if app.state.llm is None:
                app.state.llm = create_llm(config.llm_provider, config.llm_api_key, config.llm_model)
            answer = app.state.llm.generate(system, messages)
        except LLMError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        numbers = unverified_numbers(answer, facts, retrieved)
        if numbers:
            answer = (
                "I couldn't verify every numeric detail in that response, so I can't provide it safely. "
                "Please use the official source or the allocation result shown in the app."
            )
        retained = history + [
            {"role": "user", "content": message}, {"role": "assistant", "content": answer}
        ]
        app.state.sessions[session_key] = retained[-(config.max_history_turns * 2):] if config.max_history_turns > 0 else []

        sources = []
        for item in retrieved:
            sources.append({
                "label": item.label,
                "path": f"kb/{item.chunk.source_path}",
                "title": item.chunk.title,
                "urls": ([
                    "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2254498&lang=2&reg=3",
                    "https://pminternship.mca.gov.in/",
                ] if item.chunk.source_path == "scheme_faq.md" else []),
            })
        choices = facts["outcome"]["choices"]
        mentioned_choice = next((
            choice for choice in choices
            if choice["company_name"].lower() in message.lower()
        ), None)
        selected_choice = mentioned_choice or next((
            choice for choice in choices if choice["outcome"] == "lost_seat"
        ), None)
        facts_used = {
            "outcome": selected_choice["outcome"] if selected_choice else facts["outcome"]["status"],
        }
        if selected_choice and selected_choice["points_short"] is not None:
            facts_used["points_short"] = selected_choice["points_short"]
        response = {
            "answer": answer,
            "sources": sources,
            "facts_used": facts_used,
            "disclaimer": DISCLAIMER,
            "session_id": session_id,
            "external_llm_processing": config.llm_provider in {"gemini", "groq"},
            "privacy_notice": (
                f"This answer used { {'gemini': 'Google Gemini', 'groq': 'Groq'}.get(config.llm_provider, 'an external provider')}. "
                "Minimized candidate result and skill facts, your question, and limited recent chat history were sent to that provider."
                if config.llm_provider in {"gemini", "groq"} else "This answer used the local mock provider."
            ),
        }
        if request.debug:
            response["unverified_numbers"] = numbers
        return response

    @app.post("/chat")
    def chat(request: ChatRequest, http_request: Request):
        account = current_identity(http_request)
        if account.role != "candidate" or account.candidate_id != request.candidate_id:
            raise HTTPException(status_code=403, detail="You can only access the signed-in candidate's assistant.")
        account_candidate(account)
        if not app.state.demo_allocation_published:
            raise HTTPException(status_code=409, detail="The assistant can explain your result after an allocation is published.")
        return build_chat_response(request)

    @app.get("/admin/accounts")
    def admin_accounts(request: Request):
        current_admin(request)
        return {"accounts": [{
            "email": account.email,
            "candidate_id": account.candidate_id,
            "display_name": account.display_name,
            "role": account.role,
            "active": account.active,
        } for account in app.state.accounts.list_all()]}

    @app.post("/admin/accounts")
    def admin_create_account(body: CreateAccountRequest, request: Request):
        current_admin(request)
        candidate = app.state.profiles.get_candidate(body.candidate_id)
        if candidate is None:
            raise HTTPException(status_code=404, detail="Candidate ID is not present in the candidate database.")
        if candidate["name"].strip().casefold() != body.display_name.strip().casefold():
            raise HTTPException(status_code=422, detail="Display name must match the candidate profile.")
        try:
            account = app.state.accounts.create_candidate(
                body.email, candidate["candidate_id"], candidate["name"], body.password,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return {"email": account.email, "candidate_id": account.candidate_id,
                "display_name": account.display_name, "role": account.role}

    @app.post("/admin/accounts/{email}/reset-password")
    def admin_reset_password(email: str, body: ResetPasswordRequest, request: Request):
        current_admin(request)
        account = app.state.accounts.get(email)
        if account is None or account.role != "candidate":
            raise HTTPException(status_code=404, detail="Candidate account not found.")
        try:
            account = app.state.accounts.set_password(email, body.new_password)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"email": account.email, "status": "password_reset", "sessions_revoked": True}

    @app.post("/admin/accounts/{email}/status")
    def admin_account_status(email: str, body: AccountStatusRequest, request: Request):
        current_admin(request)
        account = app.state.accounts.get(email)
        if account is None or account.role != "candidate":
            raise HTTPException(status_code=404, detail="Candidate account not found.")
        updated = app.state.accounts.set_active(email, body.active)
        return {"email": updated.email, "active": updated.active, "sessions_revoked": True}

    return app


app = create_app()