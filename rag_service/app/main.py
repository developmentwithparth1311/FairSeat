from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .config import Settings, settings
from .loaders import ExportData, ExportLoadError, load_exports
from .skills import SkillAnalyzer


class ReloadResponse(BaseModel):
    candidates: int
    companies: int
    status: str


def create_app(config: Settings = settings) -> FastAPI:
    app = FastAPI(title="SAE Candidate Assistant", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "http://127.0.0.1", "http://localhost:3000"],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    app.state.config = config
    app.state.data = None
    app.state.load_error = None
    app.state.analyzer = None

    def reload_data() -> ExportData:
        data = load_exports(Path(config.export_dir))
        app.state.data = data
        app.state.analyzer = SkillAnalyzer(data, Path(config.kb_dir) / "skill_aliases.json")
        app.state.load_error = None
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
        return {
            "status": "ok" if data else "exports_unavailable",
            "exports_loaded": data is not None,
            "candidates": len(data.candidates) if data else 0,
            "companies": len(data.companies) if data else 0,
            "kb_chunks": 0,
            "llm_provider": config.llm_provider,
            "error": app.state.load_error,
        }

    @app.get("/candidates/{candidate_id}/summary")
    def summary(candidate_id: str):
        data = current_data()
        if candidate_id not in data.candidates:
            raise HTTPException(status_code=404, detail=f"Unknown candidate id: {candidate_id}")
        return app.state.analyzer.explain_outcome(candidate_id)

    @app.get("/candidates/{candidate_id}/skill-gap")
    def skill_gap(candidate_id: str, sector: str | None = None):
        data = current_data()
        if candidate_id not in data.candidates:
            raise HTTPException(status_code=404, detail=f"Unknown candidate id: {candidate_id}")
        return app.state.analyzer.skill_gap(candidate_id, sector)

    @app.post("/admin/reload", response_model=ReloadResponse)
    def reload_endpoint():
        try:
            data = reload_data()
        except ExportLoadError as exc:
            app.state.load_error = str(exc)
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"candidates": len(data.candidates), "companies": len(data.companies), "status": "reloaded"}

    return app


app = create_app()
