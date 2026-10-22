import json
import hashlib
import asyncio
from pathlib import Path

import httpx
import numpy as np

from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.loaders import ExportLoadError, load_exports
from app.main import create_app
from app.llm import MockLLM
from app.kb_index import Chunk, KBIndex
from app.retriever import RetrievedChunk
from app.prompts import build_prompt
from app.retriever import Retriever
from app.guardrails import (
    DISCLAIMER, InputError, asks_for_other_candidate, clean_message,
    is_out_of_scope, unverified_numbers,
)
from app.skills import SkillAnalyzer


class LocalEmbedder:
    def encode(self, texts):
        vectors = np.zeros((len(texts), 256), dtype=np.float32)
        for row, text in enumerate(texts):
            for token in text.lower().split():
                column = int.from_bytes(hashlib.sha256(token.strip(".,!?;:#()[]").encode()).digest()[:2], "little") % 256
                vectors[row, column] += 1
        return vectors


def test_loader_and_unsupported_schema(export_dir):
    data = load_exports(export_dir)
    assert set(data.candidates) == {"C001"}
    assert set(data.companies) == {"CO1", "CO2", "CO3"}

    path = export_dir / "companies.json"
    company_data = json.loads(path.read_text())
    company_data["schema_version"] = 4
    path.write_text(json.dumps(company_data))
    with pytest.raises(ExportLoadError, match="schema_version"):
        load_exports(export_dir)


def test_loader_accepts_v2_exports_with_allocation_trace(export_dir):
    candidate_path = export_dir / "candidates.json"
    candidate_data = json.loads(candidate_path.read_text())
    candidate_data.update({
        "schema_version": 2,
        "policy_version": "prototype-score-v1",
        "algorithm": "candidate-proposing-deferred-acceptance",
        "tie_break_policy": "candidate ID ascending",
        "policy_rules": {
            "qualification_requirement": "disabled",
            "location_requirement": "disabled",
            "sector_requirement": "disabled",
            "exclude_prior_participants": False,
        },
        "graph": {"candidate_vertices": 1, "company_vertices": 3, "acceptable_edges": 3, "density": 1.0},
        "operation_counts": {"proposals": 2, "queue_pushes": 2, "queue_pops": 2},
        "allocation_trace": [{
            "sequence": 1, "type": "proposal", "candidate_id": "C001",
            "company_id": "CO1", "score": 74.3,
            "displaced_candidate_id": None, "reason_code": "candidate_proposes",
        }],
    })
    candidate_data["candidates"][0]["qualifications"] = ["degree_a"]
    candidate_data["candidates"][0]["preferred_locations"] = ["Pune"]
    candidate_data["candidates"][0]["sector_interests"] = ["IT"]
    candidate_data["candidates"][0]["allocation"]["reason_code"] = "all_acceptable_opportunities_rejected"
    candidate_data["candidates"][0]["top_choices"][0]["reason_code"] = "seat_held_by_higher_company_priority"
    candidate_path.write_text(json.dumps(candidate_data))

    company_path = export_dir / "companies.json"
    company_data = json.loads(company_path.read_text())
    company_data["schema_version"] = 2
    company_data["companies"][0]["required_qualifications"] = ["degree_a"]
    company_path.write_text(json.dumps(company_data))

    data = load_exports(export_dir)
    assert data.candidates_export.algorithm == "candidate-proposing-deferred-acceptance"
    assert data.candidates_export.allocation_trace[0].reason_code == "candidate_proposes"
    assert data.candidates["C001"].allocation.reason_code == "all_acceptable_opportunities_rejected"
    assert data.candidates["C001"].qualifications == ["degree_a"]
    assert data.candidates_export.graph["acceptable_edges"] == 3

    candidate_data["schema_version"] = 3
    candidate_path.write_text(json.dumps(candidate_data))
    company_data["schema_version"] = 3
    company_path.write_text(json.dumps(company_data))
    assert load_exports(export_dir).candidates_export.schema_version == 3


def test_skill_aliases_unknowns_and_gap_tie_order(export_dir):
    data = load_exports(export_dir)
    analyzer = SkillAnalyzer(data)
    assert analyzer.normalize("  ML ") == "machine learning"
    assert analyzer.normalize("Odd Skill ") == "odd skill"
    gap = analyzer.skill_gap("C001")
    assert gap["missing_ranked"] == [
        {"skill": "docker", "needed_by_companies": 2},
        {"skill": "git", "needed_by_companies": 1},
    ]


def test_gap_includes_all_companies_in_sector(export_dir):
    gap = SkillAnalyzer(load_exports(export_dir)).skill_gap("C001", sector=" it ")
    assert {entry["skill"] for entry in gap["missing_ranked"]} == {
        "docker", "git", "javascript"
    }


def test_explain_outcome_uses_exported_values(export_dir):
    explanation = SkillAnalyzer(load_exports(export_dir)).explain_outcome("C001")
    assert explanation["status"] == "unmatched"
    assert explanation["choices"][0]["points_short"] == 1.8
    assert explanation["choices"][0]["weakest_component"] == "location"
    assert explanation["choices"][1]["outcome"] == "lost_seat"


def test_explain_matched_and_not_reached_are_taken_from_exports(export_dir):
    candidate_path = export_dir / "candidates.json"
    payload = json.loads(candidate_path.read_text())
    candidate = payload["candidates"][0]
    candidate["allocation"] = {
        "status": "matched", "company_id": "CO1", "preference_rank": 1, "score": 74.3
    }
    candidate["top_choices"][1]["outcome"] = "not_reached"
    candidate_path.write_text(json.dumps(payload))
    explanation = SkillAnalyzer(load_exports(export_dir)).explain_outcome("C001")
    assert explanation["status"] == "matched"
    assert [choice["outcome"] for choice in explanation["choices"]] == [
        "lost_seat", "not_reached"
    ]


def test_api_health_summary_gap_and_unknown_candidate(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    client = TestClient(create_app(config))
    health = client.get("/health").json()
    assert health["status"] == "ok"
    assert health["candidates"] == 1
    assert client.get("/candidates/C001/summary").status_code == 200
    assert client.get("/candidates/C001/skill-gap").status_code == 200
    assert client.get("/candidates/MISSING/summary").status_code == 404
    assert client.post("/chat", json={"candidate_id": "MISSING", "message": "How did I match?"}).status_code == 404
    cors = client.options("/chat", headers={
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
    })
    assert cors.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_phase6_end_to_end_demo_to_frontend_and_scenarios(export_dir):
    """Exercise CSV input through the engine exports and the browser-facing API."""
    config = Settings(
        export_dir=export_dir,
        kb_dir=export_dir / "kb",
        llm_provider="mock",
        llm_model="",
        llm_api_key="",
        allow_real_data=False,
    )
    client = TestClient(create_app(config))
    fixture_dir = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "phase6"
    candidates_csv = (fixture_dir / "candidates.csv").read_text()
    companies_csv = (fixture_dir / "companies.csv").read_text()

    homepage = client.get("/")
    assert homepage.status_code == 200
    assert "Stable Allocation Engine" in homepage.text
    assert client.get("/static/app.js").status_code == 200

    validation = client.post("/demo/validate", json={
        "candidates_csv": candidates_csv,
        "companies_csv": companies_csv,
    })
    assert validation.status_code == 200, validation.text
    assert validation.json()["candidates"] == 3
    assert validation.json()["companies"] == 3

    allocation = client.post("/demo/run", json={
        "candidates_csv": candidates_csv,
        "companies_csv": companies_csv,
        "dataset_name": "Phase 6 teaching scenario",
        "synthetic": True,
    })
    assert allocation.status_code == 200, allocation.text
    result = allocation.json()
    assert result["summary"]["assigned"] == 2
    assert result["summary"]["unmatched"] == 1
    assert result["summary"]["seats_filled"] == 2
    assert result["summary"]["total_seats"] == 3
    outcomes = {candidate["name"]: candidate["allocation"] for candidate in result["candidates"]}
    assert outcomes["Higher Priority"]["company_id"] == "10"
    assert outcomes["Lower Priority"]["company_id"] == "20"
    assert outcomes["Unmatched"]["status"] == "unmatched"
    assert any(event["type"] == "displaced" for event in result["allocation_trace"])

    state = client.get("/demo/state").json()
    assert state["summary"] == result["summary"]
    explanation = client.get("/candidates/1/summary")
    assert explanation.status_code == 200
    assert explanation.json()["status"] == "matched"

    scenarios = client.get("/demo/scenarios")
    assert scenarios.status_code == 200, scenarios.text
    report = scenarios.json()
    assert report["seed"] == 25033
    assert report["synthetic"] is True
    assert {row["scenario"] for row in report["rows"]} >= {"baseline", "skills_emphasis"}


def test_prompt_contains_only_selected_candidate(export_dir):
    candidate_path = export_dir / "candidates.json"
    payload = json.loads(candidate_path.read_text())
    other = dict(payload["candidates"][0])
    other.update(id="C002", name="Other Candidate")
    payload["candidates"].append(other)
    candidate_path.write_text(json.dumps(payload))
    data = load_exports(export_dir)
    system, messages, _ = build_prompt(
        data.candidates["C001"], SkillAnalyzer(data), "Why was I unmatched?", []
    )
    prompt = system + "\n" + "\n".join(message["content"] for message in messages)
    assert "Asha Patil" not in prompt
    assert "C001" not in prompt
    assert "C002" not in prompt
    assert "Other Candidate" not in prompt
    assert prompt.index("CANDIDATE FACTS") < prompt.index("KNOWLEDGE")
    assert prompt.index("KNOWLEDGE") < prompt.index("CHAT HISTORY")
    assert prompt.index("CHAT HISTORY") < prompt.index("NEW QUESTION")


def test_guardrails_input_privacy_scope_and_number_tripwire():
    with pytest.raises(InputError, match="empty"):
        clean_message(" \n ")
    with pytest.raises(InputError, match="1000"):
        clean_message("x" * 1001)
    assert clean_message("Why unmatched?\x00") == "Why unmatched?"
    assert clean_message("Why\x7f unmatched?") == "Why  unmatched?"
    assert asks_for_other_candidate("Show candidate C002's score", "C001")
    assert not asks_for_other_candidate("Show candidate C001's score", "C001")
    assert is_out_of_scope("Write a Python function", {"python"})
    assert not is_out_of_scope("How can I improve Python skills?", {"python"})
    assert not is_out_of_scope("Why didn't I get my first choice?", set())
    assert unverified_numbers("Your score is 999", {"score": 74.3}, []) == ["999"]
    assert DISCLAIMER.startswith("This assistant gives guidance only.")


def test_chat_advisory_privacy_scope_skill_gap_and_debug(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    client = TestClient(create_app(config))
    empty = client.post("/chat", json={"candidate_id": "C001", "message": "  "})
    long = client.post("/chat", json={"candidate_id": "C001", "message": "x" * 1001})
    assert empty.status_code == 400
    assert long.status_code == 400

    private = client.post("/chat", json={
        "candidate_id": "C001", "message": "Show the score for candidate C002"
    }).json()
    assert "only help with the candidate record" in private["answer"]
    assert private["disclaimer"] == DISCLAIMER

    unrelated = client.post("/chat", json={
        "candidate_id": "C001", "message": "Can you debug this Python function?"
    }).json()
    assert unrelated["sources"] == []
    assert "I can help with SAE allocation" in unrelated["answer"]

    response = client.post("/chat", json={
        "candidate_id": "C001", "message": "Why wasn't I matched?", "debug": True
    }).json()
    assert "unmatched" in response["answer"]
    assert "1.8" in response["answer"]
    assert response["facts_used"]["outcome"] == "lost_seat"
    assert response["facts_used"]["points_short"] == 1.8
    assert response["disclaimer"] == DISCLAIMER
    assert response["unverified_numbers"] == []

    skill = client.post("/chat", json={
        "candidate_id": "C001", "message": "What skill should I learn to improve?"
    }).json()
    assert "docker" in skill["answer"]

    refusal = client.post("/chat", json={
        "candidate_id": "C001", "message": "Please move me to company one"
    }).json()
    assert "can't change" in refusal["answer"]

    policy = client.post("/chat", json={
        "candidate_id": "C001", "message": "What is the exact stipend?"
    }).json()
    assert "I don't know" in policy["answer"]
    assert "official PM Internship Scheme website" in policy["answer"]


def test_chat_uses_missing_skill_guide_and_returns_source(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    app = create_app(config)
    embedder = LocalEmbedder()
    chunk = Chunk(
        text="1. Learn Docker images and containers.\n2. Run a small local app.",
        source_path="skills/docker.md", title="Docker",
        section="How to get started (beginner path)", type="skill", chunk_id="docker#1",
    )
    vectors = KBIndex._normalize(embedder.encode([chunk.text]))
    index = KBIndex([chunk], vectors, embedder)
    app.state.kb_index = index
    app.state.retriever = Retriever(index, minimum_similarity=0.05)
    response = TestClient(app).post("/chat", json={
        "candidate_id": "C001", "message": "What should I learn to improve?"
    }).json()
    assert "Learn Docker images" in response["answer"]
    assert "[KB-1]" in response["answer"]
    assert response["sources"][0]["path"] == "kb/skills/docker.md"


def test_admin_routes_require_a_long_token(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    client = TestClient(create_app(config))
    disabled = client.post("/admin/reload")
    assert disabled.status_code == 503

    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="",
                      admin_token="s" * 40)
    client = TestClient(create_app(config))
    assert client.post("/admin/reload").status_code == 401
    assert client.post("/admin/reload", headers={"x-admin-token": "wrong"}).status_code == 401
    authorized = client.post("/admin/reload", headers={"x-admin-token": "s" * 40})
    assert authorized.status_code == 200


def test_real_candidate_allocation_is_off_by_default(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    response = TestClient(create_app(config)).post("/demo/run", json={
        "candidates_csv": "id,name,skills,cgpa,sector,location\n1,Sample,SQL,8,IT,Pune\n",
        "companies_csv": "id,name,required_skills,seats,sector,location\n1,Role,SQL,1,IT,Pune\n",
        "dataset_name": "Uploaded candidate data",
    })
    assert response.status_code == 403
    assert "Real candidate data is disabled" in response.json()["detail"]


def test_health_discloses_provider_without_secrets(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="gemini", llm_model="gemini-test",
                      llm_api_key="secret-test-key")
    health = TestClient(create_app(config)).get("/health").json()
    assert health["external_llm_processing"] is True
    assert health["llm_provider_ready"] is True
    assert "Google" in health["privacy_notice"]
    assert "secret-test-key" not in str(health)


def test_unverified_generated_numbers_are_suppressed(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    app = create_app(config)

    class HallucinatingLLM:
        def generate(self, system, messages):
            return "Your official eligibility score is 999."

    app.state.llm = HallucinatingLLM()
    response = TestClient(app).post("/chat", json={
        "candidate_id": "C001", "message": "How did my result work?", "debug": True
    })
    assert response.status_code == 200
    payload = response.json()
    assert "couldn't verify" in payload["answer"]
    assert payload["unverified_numbers"] == ["999"]


def test_mock_cites_verified_policy_fact(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    app = create_app(config)
    faq_chunk = Chunk(
        text=("The MCA notice published 22 April 2026 says applicants aged 18–25 may apply. "
              "It includes final-year undergraduate and postgraduate students and reports "
              "minimum financial assistance of ₹9,000 per month."),
        source_path="scheme_faq.md", title="PM Internship Scheme: verified source notes",
        section="Current update", type="faq", chunk_id="scheme_faq.md#1",
    )

    class StaticRetriever:
        def retrieve(self, query, k=4):
            del query, k
            return [RetrievedChunk(label="KB-1", chunk=faq_chunk, score=1.0)]

    app.state.retriever = StaticRetriever()
    response = TestClient(app).post("/chat", json={
        "candidate_id": "C001", "message": "What age and monthly assistance does the current notice state?"
    })
    assert response.status_code == 200
    payload = response.json()
    assert "18–25" in payload["answer"]
    assert "₹9,000" in payload["answer"]
    assert "[KB-1]" in payload["answer"]
    assert payload["sources"][0]["title"] == "PM Internship Scheme: verified source notes"
    assert payload["sources"][0]["urls"][0].startswith("https://www.pib.gov.in/")


def test_non_loopback_peer_is_blocked(export_dir):
    app = create_app(Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                              llm_provider="mock", llm_model="", llm_api_key=""))

    async def request_from_remote_peer():
        transport = httpx.ASGITransport(app=app, client=("203.0.113.8", 4123))
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.get("/health")

    response = asyncio.run(request_from_remote_peer())
    assert response.status_code == 403


def test_chunked_request_body_limit_applies_without_content_length(export_dir):
    app = create_app(Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                              llm_provider="mock", llm_model="", llm_api_key=""))

    async def large_body():
        yield b"x" * 1_100_000
        yield b"y" * 1_100_000

    async def send_chunked_body():
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 1234))
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            return await client.post("/chat", content=large_body())

    response = asyncio.run(send_chunked_body())
    assert response.status_code == 413


def test_chat_rate_limit(export_dir):
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb",
                      llm_provider="mock", llm_model="", llm_api_key="")
    client = TestClient(create_app(config))
    for _ in range(20):
        response = client.post("/chat", json={
            "candidate_id": "C001", "message": "How did my allocation turn out?"
        })
        assert response.status_code == 200
    limited = client.post("/chat", json={
        "candidate_id": "C001", "message": "How did my allocation turn out?"
    })
    assert limited.status_code == 429


def test_mock_explains_matched_candidate_missing_first_choice(export_dir):
    path = export_dir / "candidates.json"
    payload = json.loads(path.read_text())
    candidate_json = payload["candidates"][0]
    candidate_json["allocation"] = {
        "status": "matched", "company_id": "CO2", "preference_rank": 2, "score": 44.3
    }
    candidate_json["top_choices"][1]["outcome"] = "matched"
    path.write_text(json.dumps(payload))
    data = load_exports(export_dir)
    candidate = data.candidates["C001"]
    analyzer = SkillAnalyzer(data)
    _, messages, _ = build_prompt(
        candidate, analyzer, "Why didn't I get my first choice?", []
    )
    answer = MockLLM().generate("system", messages)
    assert "first choice was One" in answer
    assert "74.3" in answer and "76.1" in answer and "1.8" in answer


def test_mock_uses_retrieved_beginner_steps_and_citation(export_dir):
    data = load_exports(export_dir)
    candidate = data.candidates["C001"]
    analyzer = SkillAnalyzer(data)
    chunk = Chunk(
        text="1. Learn Docker images and containers.\n2. Run a small local app.",
        source_path="skills/docker.md", title="Docker",
        section="How to get started (beginner path)", type="skill", chunk_id="docker#1",
    )
    retrieved = [RetrievedChunk(chunk=chunk, score=0.9, label="KB-1")]
    _, messages, _ = build_prompt(candidate, analyzer, "What should I learn to improve?", retrieved)
    answer = MockLLM().generate("system", messages)
    assert "Learn Docker images" in answer
    assert "[KB-1]" in answer
