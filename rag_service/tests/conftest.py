import json
from pathlib import Path
import pytest


@pytest.fixture
def export_dir(tmp_path: Path) -> Path:
    candidates = {
        "schema_version": 1,
        "generated_at": "2026-10-15T10:30:00Z",
        "scoring_weights": {"skills": 0.5, "cgpa": 0.3, "sector": 0.1, "location": 0.1},
        "candidates": [{
            "id": "C001", "name": "Asha Patil", "skills": ["Python", "SQL"],
            "cgpa": 8.1, "sector": "IT", "location": "Pune",
            "allocation": {"status": "unmatched"},
            "top_choices": [
                {"company_id": "CO1", "company_name": "One", "preference_rank": 1,
                 "breakdown": {"skills": 40.0, "cgpa": 24.3, "sector": 10.0,
                               "location": 0.0, "total": 74.3},
                 "matched_skills": ["python", "sql"], "missing_skills": ["docker"],
                 "outcome": "lost_seat", "company_cutoff_score": 76.1},
                {"company_id": "CO2", "company_name": "Two", "preference_rank": 2,
                 "breakdown": {"skills": 0.0, "cgpa": 24.3, "sector": 10.0,
                               "location": 10.0, "total": 44.3},
                 "matched_skills": [], "missing_skills": ["docker", "git"],
                 "outcome": "lost_seat", "company_cutoff_score": 50.0},
            ],
        }],
    }
    companies = {
        "schema_version": 1,
        "companies": [
            {"id": "CO1", "name": "One", "required_skills": ["Docker", "Git"],
             "seats": 1, "seats_filled": 1, "sector": "IT", "location": "Pune", "cutoff_score": 76.1},
            {"id": "CO2", "name": "Two", "required_skills": ["docker", "SQL"],
             "seats": 1, "seats_filled": 1, "sector": "IT", "location": "Mumbai", "cutoff_score": 50.0},
            {"id": "CO3", "name": "Three", "required_skills": ["JS"],
             "seats": 1, "seats_filled": 0, "sector": "IT", "location": "Delhi", "cutoff_score": None},
        ],
    }
    (tmp_path / "candidates.json").write_text(json.dumps(candidates))
    (tmp_path / "companies.json").write_text(json.dumps(companies))
    return tmp_path
