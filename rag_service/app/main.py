from pathlib import Path
import csv
from collections import defaultdict, deque
import hmac
import ipaddress
import io
import re
import subprocess
import tempfile
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import Settings, settings
from .loaders import ExportData, ExportLoadError, load_exports
from .skills import SkillAnalyzer


REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = REPO_ROOT / "frontend"
MAX_REQUEST_BYTES = 2_100_000
MAX_CHAT_SESSIONS = 1000


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
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    app.state.config = config
    app.state.data = None
    app.state.load_error = None
    app.state.analyzer = None
    app.state.kb_index = None
    app.state.retriever = None
    app.state.sessions = {}
    app.state.llm = None
    app.state.demo_directory = None
    app.state.dataset_name = "Existing export"
    app.state.dataset_kind = "saved_export"
    request_events: dict[tuple[str, str], deque[float]] = defaultdict(deque)
    app.add_middleware(RequestBodyLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)

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
            # Only the explicit in-process test transport uses this peer name.
            if peer != "testclient":
                return JSONResponse(status_code=403, content={"detail": "This prototype accepts local connections only."})

        path = request.url.path
        if path.startswith("/admin/"):
            limit = 5
            bucket = "admin"
        elif path == "/chat":
            limit = 20
            bucket = "chat"
        elif path in {"/demo/validate", "/demo/run"}:
            limit = 12
            bucket = "allocation"
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

    def require_admin_token(request: Request) -> None:
        if len(config.admin_token) < 32:
            raise HTTPException(status_code=503, detail="Admin actions are disabled. Configure a 32-character SAE_ADMIN_TOKEN to enable them.")
        supplied = request.headers.get("x-admin-token", "")
        if not hmac.compare_digest(supplied, config.admin_token):
            raise HTTPException(status_code=401, detail="Admin authentication required.")

    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def frontend():
        return FileResponse(FRONTEND_DIR / "index.html")

    def reload_data() -> ExportData:
        if app.state.demo_directory is not None:
            app.state.demo_directory.cleanup()
            app.state.demo_directory = None
        data = load_exports(Path(config.export_dir))
        app.state.data = data
        app.state.analyzer = SkillAnalyzer(data, Path(config.kb_dir) / "skill_aliases.json")
        app.state.load_error = None
        app.state.kb_index = None
        app.state.retriever = None
        app.state.sessions.clear()
        app.state.dataset_name = "Existing export"
        app.state.dataset_kind = "saved_export"
        return data

    try:
        reload_data()
    except ExportLoadError as exc:
        app.state.load_error = str(exc)

    def current_data() -> ExportData:
        if app.state.data is None:
            raise HTTPException(status_code=503, detail=app.state.load_error or "SAE exports are unavailable")
        return app.state.data

    @app.get("/health")
    def health():
        data = app.state.data
        gemini_enabled = config.llm_provider == "gemini"
        provider_ready = config.llm_provider == "mock" or (
            gemini_enabled and bool(config.llm_api_key and config.llm_model)
        )
        return {
            "status": "ok" if data else "exports_unavailable",
            "exports_loaded": data is not None,
            "candidates": len(data.candidates) if data else 0,
            "companies": len(data.companies) if data else 0,
            "kb_chunks": len(app.state.kb_index.chunks) if app.state.kb_index else 0,
            "llm_provider": config.llm_provider,
            "llm_provider_ready": provider_ready,
            "external_llm_processing": gemini_enabled,
            "privacy_notice": (
                "Gemini is enabled. Minimized candidate result and skill facts, your question, and up to "
                f"{config.max_history_turns} recent chat turns may be sent to Google for a response."
                if gemini_enabled else "The mock provider runs locally; chat data is not sent to an external LLM."
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
    def demo_validate(request: DemoCsvRequest):
        return _validate_csv_pair(config, request.candidates_csv, request.companies_csv)

    @app.post("/demo/run")
    def demo_run(request: DemoRunRequest):
        if not request.synthetic and not config.allow_real_data:
            raise HTTPException(
                status_code=403,
                detail="Real candidate data is disabled. Mark synthetic uploads as synthetic, or explicitly enable SAE_ALLOW_REAL_DATA for an authorized local evaluation.",
            )
        _validate_csv_pair(config, request.candidates_csv, request.companies_csv)
        temp = tempfile.TemporaryDirectory(prefix="sae-demo-run-")
        root = Path(temp.name)
        candidates_path = root / "candidates.csv"
        companies_path = root / "companies.csv"
        output_path = root / "exports"
        candidates_path.write_text(request.candidates_csv, encoding="utf-8")
        companies_path.write_text(request.companies_csv, encoding="utf-8")
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
        app.state.sessions.clear()
        app.state.demo_directory = temp
        app.state.dataset_name = request.dataset_name.strip()
        app.state.dataset_kind = "synthetic" if request.synthetic else "uploaded"
        if old_temp is not None:
            old_temp.cleanup()
        return demo_state_payload(app)

    @app.get("/demo/state")
    def demo_state():
        return demo_state_payload(app)

    @app.get("/demo/scenarios")
    def demo_scenarios():
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
    def summary(candidate_id: str):
        from .guardrails import DISCLAIMER
        data = current_data()
        if candidate_id not in data.candidates:
            raise HTTPException(status_code=404, detail=f"Unknown candidate id: {candidate_id}")
        return {**app.state.analyzer.explain_outcome(candidate_id), "disclaimer": DISCLAIMER}

    @app.get("/candidates/{candidate_id}/skill-gap")
    def skill_gap(candidate_id: str, sector: str | None = None):
        from .guardrails import DISCLAIMER
        data = current_data()
        if candidate_id not in data.candidates:
            raise HTTPException(status_code=404, detail=f"Unknown candidate id: {candidate_id}")
        return {**app.state.analyzer.skill_gap(candidate_id, sector), "disclaimer": DISCLAIMER}

    @app.post("/admin/reload", response_model=ReloadResponse)
    def reload_endpoint(request: Request):
        require_admin_token(request)
        try:
            data = reload_data()
        except ExportLoadError as exc:
            app.state.load_error = str(exc)
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"candidates": len(data.candidates), "companies": len(data.companies), "status": "reloaded"}

    @app.post("/admin/reindex")
    def reindex_endpoint(request: Request):
        require_admin_token(request)
        data = current_data()
        try:
            from .kb_index import KBIndex
            from .retriever import Retriever

            index = KBIndex.build_or_load(
                Path(config.kb_dir), data.companies, Path(config.index_dir),
                model_name=config.embed_model,
            )
            app.state.kb_index = index
            app.state.retriever = Retriever(
                index,
                company_names=[company.name for company in data.companies.values()],
                minimum_similarity=config.min_similarity,
            )
        except (RuntimeError, OSError, ValueError) as exc:
            raise HTTPException(status_code=503, detail=f"Could not build knowledge index: {exc}") from exc
        return {"status": "reindexed", "kb_chunks": len(index.chunks)}

    @app.post("/chat")
    def chat(request: ChatRequest):
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
            "external_llm_processing": config.llm_provider == "gemini",
            "privacy_notice": (
                "This answer used Gemini. Minimized candidate result and skill facts, your question, and limited recent chat history were sent to Google."
                if config.llm_provider == "gemini" else "This answer used the local mock provider."
            ),
        }
        if request.debug:
            response["unverified_numbers"] = numbers
        return response

    return app


app = create_app()
