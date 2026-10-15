from collections import Counter
from dataclasses import dataclass
import json
from pathlib import Path

from .loaders import Candidate, ExportData


DEFAULT_ALIASES = {
    "ml": "machine learning",
    "js": "javascript",
    "ms excel": "excel",
    "c plus plus": "c++",
    "py": "python",
}


class SkillAnalyzer:
    def __init__(self, data: ExportData, alias_path: Path | None = None):
        self.data = data
        self.aliases = DEFAULT_ALIASES.copy()
        if alias_path and alias_path.exists():
            self.aliases.update(json.loads(alias_path.read_text(encoding="utf-8")))
        self.aliases = {self._key(k): self._key(v) for k, v in self.aliases.items()}

    @staticmethod
    def _key(skill: str) -> str:
        return " ".join(skill.strip().lower().split())

    def normalize(self, skill: str) -> str:
        key = self._key(skill)
        return self.aliases.get(key, key)

    def skill_gap(self, candidate_id: str, sector: str | None = None) -> dict:
        candidate = self._candidate(candidate_id)
        have = {self.normalize(skill) for skill in candidate.skills}
        relevant = {choice.company_id for choice in candidate.top_choices}
        if sector:
            relevant.update(
                company.id for company in self.data.companies.values()
                if self._key(company.sector) == self._key(sector)
            )

        needed_by = Counter()
        for company_id in relevant:
            company = self.data.companies.get(company_id)
            if company is None:
                continue
            company_skills = {self.normalize(skill) for skill in company.required_skills}
            needed_by.update(company_skills - have)

        ranked = sorted(needed_by.items(), key=lambda item: (-item[1], item[0]))
        return {
            "candidate_id": candidate.id,
            "have": sorted(have),
            "missing_ranked": [
                {"skill": skill, "needed_by_companies": count}
                for skill, count in ranked
            ],
        }

    def explain_outcome(self, candidate_id: str) -> dict:
        candidate = self._candidate(candidate_id)
        choices = []
        for choice in candidate.top_choices:
            components = {
                "skills": choice.breakdown.skills,
                "cgpa": choice.breakdown.cgpa,
                "sector": choice.breakdown.sector,
                "location": choice.breakdown.location,
            }
            weakest = min(components, key=components.get)
            points_short = None
            if choice.company_cutoff_score is not None and choice.outcome == "lost_seat":
                points_short = round(choice.company_cutoff_score - choice.breakdown.total, 1)
            choices.append({
                "company_id": choice.company_id,
                "company_name": choice.company_name,
                "preference_rank": choice.preference_rank,
                "outcome": choice.outcome,
                "score": choice.breakdown.total,
                "company_cutoff_score": choice.company_cutoff_score,
                "points_short": points_short,
                "weakest_component": weakest,
                "missing_skills": choice.missing_skills,
            })
        allocation = candidate.allocation
        return {
            "candidate_id": candidate.id,
            "status": allocation.status,
            "company_id": allocation.company_id,
            "preference_rank": allocation.preference_rank,
            "score": allocation.score,
            "choices": choices,
        }

    def _candidate(self, candidate_id: str) -> Candidate:
        try:
            return self.data.candidates[candidate_id]
        except KeyError as exc:
            raise KeyError(candidate_id) from exc
