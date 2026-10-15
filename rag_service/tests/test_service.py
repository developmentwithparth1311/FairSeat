import json

from fastapi.testclient import TestClient
import pytest

from app.config import Settings
from app.loaders import ExportLoadError, load_exports
from app.main import create_app
from app.skills import SkillAnalyzer


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
