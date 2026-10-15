from pathlib import Path
from typing import Any, Literal
import json

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class ScoreBreakdown(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skills: float
    cgpa: float
    sector: float
    location: float
    total: float


class Allocation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["matched", "unmatched"]
    company_id: str | None = None
    preference_rank: int | None = None
    score: float | None = None


class TopChoice(BaseModel):
    model_config = ConfigDict(extra="forbid")
    company_id: str
    company_name: str
    preference_rank: int
    breakdown: ScoreBreakdown
    matched_skills: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    outcome: Literal["matched", "lost_seat", "not_reached"]
    company_cutoff_score: float | None = None


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    skills: list[str]
    cgpa: float
    sector: str
    location: str
    allocation: Allocation
    top_choices: list[TopChoice] = Field(default_factory=list)


class CandidateExport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: int
    generated_at: str
    scoring_weights: dict[str, float]
    candidates: list[Candidate]


class Company(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    required_skills: list[str]
    seats: int
    seats_filled: int
    sector: str
    location: str
    cutoff_score: float | None = None


class CompanyExport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: int
    companies: list[Company]


class ExportData(BaseModel):
    candidates_export: CandidateExport
    companies_export: CompanyExport

    @property
    def candidates(self) -> dict[str, Candidate]:
        return {candidate.id: candidate for candidate in self.candidates_export.candidates}

    @property
    def companies(self) -> dict[str, Company]:
        return {company.id: company for company in self.companies_export.companies}


class ExportLoadError(ValueError):
    """Raised when generated SAE exports are missing or invalid."""


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ExportLoadError(f"Required SAE export not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ExportLoadError(f"Invalid JSON in {path}: {exc.msg}") from exc


def load_exports(export_dir: Path) -> ExportData:
    candidate_path = export_dir / "candidates.json"
    company_path = export_dir / "companies.json"
    try:
        candidates = CandidateExport.model_validate(_read_json(candidate_path))
        companies = CompanyExport.model_validate(_read_json(company_path))
    except ValidationError as exc:
        raise ExportLoadError(f"Invalid SAE export data: {exc}") from exc

    if candidates.schema_version != 1 or companies.schema_version != 1:
        raise ExportLoadError(
            "Unsupported SAE export schema_version; this service supports version 1"
        )
    return ExportData(candidates_export=candidates, companies_export=companies)
