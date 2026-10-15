import json
import hashlib

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
    company_data["schema_version"] = 2
    path.write_text(json.dumps(company_data))
    with pytest.raises(ExportLoadError, match="schema_version"):
        load_exports(export_dir)


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
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb")
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
    assert "Asha Patil" in prompt
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
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb")
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
    config = Settings(export_dir=export_dir, kb_dir=export_dir / "kb")
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
