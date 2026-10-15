from pathlib import Path
import re
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import Settings, settings
from .loaders import ExportData, ExportLoadError, load_exports
from .skills import SkillAnalyzer


class ChatRequest(BaseModel):
    candidate_id: str
    session_id: str | None = None
    message: str
    debug: bool = False


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
    app.state.kb_index = None
    app.state.retriever = None
    app.state.sessions = {}
    app.state.llm = None

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
            "kb_chunks": len(app.state.kb_index.chunks) if app.state.kb_index else 0,
            "llm_provider": config.llm_provider,
            "error": app.state.load_error,
        }

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
    def reload_endpoint():
        try:
            data = reload_data()
        except ExportLoadError as exc:
            app.state.load_error = str(exc)
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"candidates": len(data.candidates), "companies": len(data.companies), "status": "reloaded"}

    @app.post("/admin/reindex")
    def reindex_endpoint():
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

        retrieved = []
        if app.state.retriever is not None:
            retrieved = app.state.retriever.retrieve(message, k=config.top_k_chunks)

        session_id = request.session_id or str(uuid.uuid4())
        session_key = (candidate.id, session_id)
        history = app.state.sessions.get(session_key, [])
        from .prompts import build_prompt
        sectors = {company.sector for company in data.companies.values() if company.sector}
        requested_sector = next((
            sector for sector in sorted(sectors, key=len, reverse=True)
            if re.search(rf"\b{re.escape(sector)}\b", message, re.I)
        ), None)
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
        }
        if request.debug:
            response["unverified_numbers"] = numbers
        return response

    return app


app = create_app()
