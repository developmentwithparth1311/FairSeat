"""Persistent candidate, preference, opportunity, and allocation-state storage."""

import csv
import io
import json
import os
from pathlib import Path
import sqlite3
import uuid


def _items(value: str | None) -> list[str]:
    values = []
    seen = set()
    for raw in (value or "").split(";"):
        item = raw.strip()
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            values.append(item)
    return values


class CandidateDataStore:
    """SQLite-backed canonical input data. Seed files are imported only once."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS candidates (
                    candidate_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    skills_json TEXT NOT NULL DEFAULT '[]',
                    cgpa REAL NOT NULL DEFAULT 0,
                    sector TEXT NOT NULL DEFAULT '',
                    location TEXT NOT NULL DEFAULT '',
                    qualifications_json TEXT NOT NULL DEFAULT '[]',
                    preferred_locations_json TEXT NOT NULL DEFAULT '[]',
                    sector_interests_json TEXT NOT NULL DEFAULT '[]',
                    prior_participation INTEGER,
                    preferences_submitted INTEGER NOT NULL DEFAULT 0,
                    profile_version INTEGER NOT NULL DEFAULT 1,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS opportunities (
                    opportunity_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    required_skills_json TEXT NOT NULL DEFAULT '[]',
                    seats INTEGER NOT NULL CHECK(seats >= 0),
                    required_qualifications_json TEXT NOT NULL DEFAULT '[]',
                    sector TEXT NOT NULL DEFAULT '',
                    location TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS candidate_preferences (
                    candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
                    rank INTEGER NOT NULL CHECK(rank > 0),
                    opportunity_id TEXT NOT NULL REFERENCES opportunities(opportunity_id),
                    PRIMARY KEY(candidate_id, rank),
                    UNIQUE(candidate_id, opportunity_id)
                );
                CREATE TABLE IF NOT EXISTS allocation_runs (
                    run_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    created_by TEXT NOT NULL,
                    policy_version TEXT NOT NULL,
                    profile_versions_json TEXT NOT NULL,
                    summary_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS allocation_results (
                    run_id TEXT NOT NULL REFERENCES allocation_runs(run_id) ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
                    status TEXT NOT NULL CHECK(status IN ('matched', 'unmatched')),
                    opportunity_id TEXT,
                    score REAL,
                    preference_rank INTEGER,
                    detail_json TEXT NOT NULL DEFAULT '{}',
                    PRIMARY KEY(run_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS app_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                    active_run_id TEXT,
                    status TEXT NOT NULL DEFAULT 'not_allocated',
                    version INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT OR IGNORE INTO app_state(singleton, active_run_id, status, version)
                    VALUES(1, NULL, 'not_allocated', 0);
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(candidates)")}
            if "prior_participation" not in columns:
                db.execute("ALTER TABLE candidates ADD COLUMN prior_participation INTEGER")
            if "preferences_submitted" not in columns:
                db.execute("ALTER TABLE candidates ADD COLUMN preferences_submitted INTEGER NOT NULL DEFAULT 0")
        os.chmod(self.path, 0o600)

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA busy_timeout = 10000")
        return db

    def initialize_from_csv(self, candidates_path: Path, opportunities_path: Path) -> None:
        with self._connect() as db:
            if db.execute("SELECT 1 FROM candidates LIMIT 1").fetchone():
                return
            with Path(candidates_path).open(encoding="utf-8-sig", newline="") as stream:
                reader = csv.DictReader(stream)
                has_preferences = "preferred_company_ids" in (reader.fieldnames or [])
                candidates = list(reader)
            with Path(opportunities_path).open(encoding="utf-8-sig", newline="") as stream:
                opportunities = list(csv.DictReader(stream))
            if not candidates or not opportunities:
                raise ValueError("Initial candidate and opportunity CSV files must contain records.")
            for row in opportunities:
                company_id = row.get("id", "").strip()
                if not company_id:
                    raise ValueError("An initial opportunity row is missing its id.")
                db.execute("""INSERT INTO opportunities(
                    opportunity_id,name,required_skills_json,seats,required_qualifications_json,sector,location
                ) VALUES(?,?,?,?,?,?,?)""", (
                    company_id, row.get("name", "").strip(),
                    json.dumps(_items(row.get("required_skills"))), int(row.get("seats", "0")),
                    json.dumps(_items(row.get("required_qualifications"))),
                    row.get("sector", "").strip(), row.get("location", "").strip(),
                ))
            for row in candidates:
                candidate_id = row.get("id", "").strip()
                if not candidate_id:
                    raise ValueError("An initial candidate row is missing its id.")
                db.execute("""INSERT INTO candidates(
                    candidate_id,name,skills_json,cgpa,sector,location,qualifications_json,
                    preferred_locations_json,sector_interests_json,prior_participation,preferences_submitted
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (
                    candidate_id, row.get("name", "").strip(),
                    json.dumps(_items(row.get("skills"))), float(row.get("cgpa", "0") or 0),
                    row.get("sector", "").strip(), row.get("location", "").strip(),
                    json.dumps(_items(row.get("qualifications"))),
                    json.dumps(_items(row.get("preferred_locations"))),
                    json.dumps(_items(row.get("sector_interests"))),
                    (1 if row.get("prior_participation", "").strip().lower() in {"1", "true", "yes"}
                     else 0 if row.get("prior_participation", "").strip().lower() in {"0", "false", "no"}
                     else None),
                    int(has_preferences),
                ))
                pref_ids = _items(row.get("preferred_company_ids"))
                for rank, opportunity_id in enumerate(pref_ids, start=1):
                    if db.execute("SELECT 1 FROM opportunities WHERE opportunity_id=?", (opportunity_id,)).fetchone():
                        db.execute("INSERT INTO candidate_preferences(candidate_id,rank,opportunity_id) VALUES(?,?,?)",
                                   (candidate_id, rank, opportunity_id))

    def import_missing_export_records(self, data) -> None:
        """Add records from a configured legacy export without overwriting database edits."""
        with self._connect() as db:
            for company in data.companies_export.companies:
                db.execute("""INSERT OR IGNORE INTO opportunities(
                    opportunity_id,name,required_skills_json,seats,required_qualifications_json,sector,location
                ) VALUES(?,?,?,?,?,?,?)""", (
                    company.id, company.name, json.dumps(company.required_skills), company.seats,
                    json.dumps(company.required_qualifications), company.sector, company.location,
                ))
            for candidate in data.candidates_export.candidates:
                db.execute("""INSERT OR IGNORE INTO candidates(
                    candidate_id,name,skills_json,cgpa,sector,location,qualifications_json,
                    preferred_locations_json,sector_interests_json
                ) VALUES(?,?,?,?,?,?,?,?,?)""", (
                    candidate.id, candidate.name, json.dumps(candidate.skills), candidate.cgpa,
                    candidate.sector, candidate.location, json.dumps(candidate.qualifications),
                    json.dumps(candidate.preferred_locations), json.dumps(candidate.sector_interests),
                ))

    @staticmethod
    def _candidate(row):
        if row is None:
            return None
        return {
            "candidate_id": row["candidate_id"], "name": row["name"],
            "skills": json.loads(row["skills_json"]), "cgpa": row["cgpa"],
            "sector": row["sector"], "location": row["location"],
            "qualifications": json.loads(row["qualifications_json"]),
            "preferred_locations": json.loads(row["preferred_locations_json"]),
            "sector_interests": json.loads(row["sector_interests_json"]),
            "prior_participation": bool(row["prior_participation"]) if row["prior_participation"] is not None else None,
            "preferences_submitted": bool(row["preferences_submitted"]),
            "profile_version": row["profile_version"], "updated_at": row["updated_at"],
        }

    @staticmethod
    def _opportunity(row):
        return {
            "id": row["opportunity_id"], "name": row["name"],
            "required_skills": json.loads(row["required_skills_json"]),
            "seats": row["seats"],
            "required_qualifications": json.loads(row["required_qualifications_json"]),
            "sector": row["sector"], "location": row["location"],
        }

    def get_candidate(self, candidate_id: str):
        with self._connect() as db:
            return self._candidate(db.execute(
                "SELECT * FROM candidates WHERE candidate_id=?", (candidate_id,)
            ).fetchone())

    def list_candidates(self) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM candidates ORDER BY candidate_id").fetchall()
        return [self._candidate(row) for row in rows]

    def list_opportunities(self) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM opportunities ORDER BY opportunity_id").fetchall()
        return [self._opportunity(row) for row in rows]

    def get_preferences(self, candidate_id: str) -> list[str]:
        with self._connect() as db:
            rows = db.execute("""SELECT opportunity_id FROM candidate_preferences
                WHERE candidate_id=? ORDER BY rank""", (candidate_id,)).fetchall()
        return [row["opportunity_id"] for row in rows]

    def candidate_view(self, candidate_id: str, policy_path: Path | None = None) -> dict | None:
        profile = self.get_candidate(candidate_id)
        if profile is None:
            return None
        ordered_ids = self.get_preferences(candidate_id)
        if not profile["preferences_submitted"] and policy_path is not None:
            try:
                policy = self._policy_values(policy_path)
                ordered_ids = self._automatic_preferences(profile, self.list_opportunities(), policy)
            except (OSError, ValueError):
                ordered_ids = []
        opportunities = {row["id"]: row for row in self.list_opportunities()}
        profile["preferences"] = [
            {"rank": rank, **opportunities[opportunity_id]}
            for rank, opportunity_id in enumerate(ordered_ids, start=1)
            if opportunity_id in opportunities
        ]
        profile["all_opportunities"] = list(opportunities.values())
        profile["allocation_state"] = self.allocation_state()
        profile["preferences_are_automatic"] = not profile["preferences_submitted"]
        return profile

    def update_candidate(self, candidate_id: str, values: dict, expected_version: int | None = None) -> dict | None:
        with self._connect() as db:
            current = db.execute("SELECT profile_version FROM candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
            if current is None:
                return None
            if expected_version is not None and current["profile_version"] != expected_version:
                raise ValueError("Your profile changed in another session. Reload it before saving again.")
            changed = db.execute("""UPDATE candidates SET name=?,skills_json=?,cgpa=?,sector=?,location=?,
                qualifications_json=?,preferred_locations_json=?,sector_interests_json=?,
                profile_version=profile_version+1,updated_at=CURRENT_TIMESTAMP WHERE candidate_id=?""", (
                values["name"], json.dumps(values["skills"]), values["cgpa"], values["sector"],
                values["location"], json.dumps(values["qualifications"]),
                json.dumps(values["preferred_locations"]), json.dumps(values["sector_interests"]),
                candidate_id,
            )).rowcount
            if not changed:
                return None
            self._invalidate_current_allocation(db)
        return self.get_candidate(candidate_id)

    def update_preferences(self, candidate_id: str, opportunity_ids: list[str],
                           expected_version: int | None = None) -> list[str] | None:
        with self._connect() as db:
            current = db.execute("SELECT profile_version FROM candidates WHERE candidate_id=?", (candidate_id,)).fetchone()
            if current is None:
                return None
            if expected_version is not None and current["profile_version"] != expected_version:
                raise ValueError("Your profile changed in another session. Reload it before saving again.")
            known = {row[0] for row in db.execute("SELECT opportunity_id FROM opportunities")}
            unknown = [value for value in opportunity_ids if value not in known]
            if unknown:
                raise ValueError(f"Unknown opportunity id: {unknown[0]}")
            if len(set(opportunity_ids)) != len(opportunity_ids):
                raise ValueError("An opportunity can appear only once in your preferences.")
            db.execute("DELETE FROM candidate_preferences WHERE candidate_id=?", (candidate_id,))
            db.executemany("INSERT INTO candidate_preferences(candidate_id,rank,opportunity_id) VALUES(?,?,?)",
                           [(candidate_id, rank, opportunity_id)
                            for rank, opportunity_id in enumerate(opportunity_ids, start=1)])
            db.execute("UPDATE candidates SET profile_version=profile_version+1,updated_at=CURRENT_TIMESTAMP WHERE candidate_id=?",
                       (candidate_id,))
            db.execute("UPDATE candidates SET preferences_submitted=1 WHERE candidate_id=?", (candidate_id,))
            self._invalidate_current_allocation(db)
        return opportunity_ids

    def allocation_snapshot(self) -> dict:
        with self._connect() as db:
            state = db.execute("SELECT version FROM app_state WHERE singleton=1").fetchone()
            candidates = [self._candidate(row) for row in db.execute("SELECT * FROM candidates ORDER BY candidate_id")]
            opportunities = [self._opportunity(row) for row in db.execute("SELECT * FROM opportunities ORDER BY opportunity_id")]
            preferences = {}
            for row in db.execute("SELECT candidate_id,opportunity_id FROM candidate_preferences ORDER BY candidate_id,rank"):
                preferences.setdefault(row["candidate_id"], []).append(row["opportunity_id"])
        for candidate in candidates:
            candidate["preferences"] = preferences.get(candidate["candidate_id"], [])
        return {"version": state["version"], "candidates": candidates, "opportunities": opportunities}

    @staticmethod
    def _policy_values(policy_path: Path) -> dict[str, str]:
        values = {}
        for line in Path(policy_path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
        return values

    @classmethod
    def _automatic_preferences(cls, candidate: dict, opportunities: list[dict], policy: dict[str, str]) -> list[str]:
        weights = {
            "skills": float(policy.get("weight.skills", "0.5")),
            "cgpa": float(policy.get("weight.cgpa", "0.3")),
            "sector": float(policy.get("weight.sector", "0.1")),
            "location": float(policy.get("weight.location", "0.1")),
        }
        skills = {value.casefold() for value in candidate["skills"]}
        ranked = []
        for company in opportunities:
            if policy.get("exclude_prior_participants", "false") == "true" and candidate.get("prior_participation"):
                continue
            required_qualifications = set(company["required_qualifications"])
            if (policy.get("requirement.qualifications") == "all_required"
                    and not required_qualifications.issubset(set(candidate["qualifications"]))):
                continue
            if (policy.get("requirement.location") == "preferred_locations" and candidate["preferred_locations"]
                    and company["location"] not in candidate["preferred_locations"]):
                continue
            if (policy.get("requirement.sector") == "sector_interests" and candidate["sector_interests"]
                    and company["sector"] not in candidate["sector_interests"]):
                continue
            requirements = company["required_skills"]
            overlap = sum(skill.casefold() in skills for skill in requirements)
            skill_score = overlap / len(requirements) if requirements else 1.0
            cgpa_score = min(float(candidate["cgpa"]) / 10.0, 1.0)
            sector_match = (company["sector"] in candidate["sector_interests"]
                            if candidate["sector_interests"] else candidate["sector"] == company["sector"])
            location_match = (company["location"] in candidate["preferred_locations"]
                              if candidate["preferred_locations"] else candidate["location"] == company["location"])
            score = 100.0 * (weights["skills"] * skill_score + weights["cgpa"] * cgpa_score
                             + weights["sector"] * sector_match + weights["location"] * location_match)
            try:
                tie_key = (0, int(company["id"]))
            except (TypeError, ValueError):
                tie_key = (1, str(company["id"]).casefold())
            ranked.append((-score, tie_key, company["id"]))
        return [item[2] for item in sorted(ranked)]

    def allocator_csv(self, policy_path: Path,
                      preference_overrides: dict[str, list[str]] | None = None) -> tuple[str, str, dict]:
        snapshot = self.allocation_snapshot()
        policy = self._policy_values(policy_path)
        candidate_io = io.StringIO(newline="")
        writer = csv.writer(candidate_io)
        writer.writerow(["id", "name", "skills", "cgpa", "sector", "location", "preferred_company_ids",
                         "qualifications", "preferred_locations", "sector_interests", "prior_participation"])
        engine_ids = {str(item["id"]): str(index)
                      for index, item in enumerate(snapshot["opportunities"], start=1)}
        opportunity_ids = set(engine_ids)
        preference_overrides = preference_overrides or {}
        engine_candidate_ids = {str(item["candidate_id"]): str(index)
                                for index, item in enumerate(snapshot["candidates"], start=1)}
        for candidate in snapshot["candidates"]:
            candidate_id = str(candidate["candidate_id"])
            if candidate_id in preference_overrides:
                choices = [str(item) for item in preference_overrides[candidate_id] if str(item) in opportunity_ids]
            else:
                choices = ([str(item) for item in candidate["preferences"] if str(item) in opportunity_ids]
                           if candidate["preferences_submitted"] else [])
            if candidate_id not in preference_overrides and not candidate["preferences_submitted"]:
                choices = self._automatic_preferences(candidate, snapshot["opportunities"], policy)
            writer.writerow([
                engine_candidate_ids[str(candidate["candidate_id"])], candidate["name"],
                ";".join(candidate["skills"]), candidate["cgpa"],
                candidate["sector"], candidate["location"], ";".join(engine_ids[item] for item in choices),
                ";".join(candidate["qualifications"]), ";".join(candidate["preferred_locations"]),
                ";".join(candidate["sector_interests"]),
                "" if candidate["prior_participation"] is None else str(candidate["prior_participation"]).lower(),
            ])
        company_io = io.StringIO(newline="")
        writer = csv.writer(company_io)
        writer.writerow(["id", "name", "required_skills", "seats", "sector", "location", "required_qualifications"])
        for opportunity in snapshot["opportunities"]:
            writer.writerow([
                engine_ids[str(opportunity["id"])], opportunity["name"], ";".join(opportunity["required_skills"]),
                opportunity["seats"], opportunity["sector"], opportunity["location"],
                ";".join(opportunity["required_qualifications"]),
            ])
        snapshot["engine_company_id_map"] = engine_ids
        snapshot["engine_candidate_id_map"] = engine_candidate_ids
        return candidate_io.getvalue(), company_io.getvalue(), snapshot

    def publish_allocation(self, expected_version: int, admin_email: str, data: dict) -> str:
        run_id = str(uuid.uuid4())
        candidates_export = data["candidates_export"]
        candidate_by_id = {item["id"]: item for item in candidates_export["candidates"]}
        profile_versions = {item["candidate_id"]: item["profile_version"] for item in data["profile_snapshot"]}
        with self._connect() as db:
            state = db.execute("SELECT version FROM app_state WHERE singleton=1").fetchone()
            if state["version"] != expected_version:
                raise RuntimeError("Candidate or opportunity data changed while the allocation was running. Run it again.")
            db.execute("""INSERT INTO allocation_runs(run_id,created_by,policy_version,profile_versions_json,summary_json)
                VALUES(?,?,?,?,?)""", (
                run_id, admin_email, candidates_export.get("policy_version") or "prototype policy",
                json.dumps(profile_versions, sort_keys=True), json.dumps(data, separators=(",", ":")),
            ))
            for candidate_id, candidate in candidate_by_id.items():
                allocation = candidate["allocation"]
                db.execute("""INSERT INTO allocation_results(
                    run_id,candidate_id,status,opportunity_id,score,preference_rank,detail_json
                ) VALUES(?,?,?,?,?,?,?)""", (
                    run_id, candidate_id, allocation["status"], allocation.get("company_id"),
                    allocation.get("score"), allocation.get("preference_rank"),
                    json.dumps(candidate, separators=(",", ":")),
                ))
            db.execute("""UPDATE app_state SET active_run_id=?,status='current',version=version+1,
                updated_at=CURRENT_TIMESTAMP WHERE singleton=1""", (run_id,))
        return run_id

    def active_run(self) -> dict | None:
        with self._connect() as db:
            row = db.execute("""SELECT r.* FROM app_state s JOIN allocation_runs r ON r.run_id=s.active_run_id
                WHERE s.singleton=1 AND s.status='current'""").fetchone()
        if row is None:
            return None
        return {**dict(row), "profile_versions": json.loads(row["profile_versions_json"]),
                "snapshot": json.loads(row["summary_json"])}

    def active_candidate_result(self, candidate_id: str) -> dict | None:
        run = self.active_run()
        if run is None:
            return None
        if run["profile_versions"].get(candidate_id) != (self.get_candidate(candidate_id) or {}).get("profile_version"):
            return None
        with self._connect() as db:
            row = db.execute("SELECT detail_json FROM allocation_results WHERE run_id=? AND candidate_id=?",
                             (run["run_id"], candidate_id)).fetchone()
        if row is None:
            return None
        return json.loads(row["detail_json"])

    def allocation_history(self) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("""SELECT run_id,created_at,created_by,policy_version,summary_json
                FROM allocation_runs ORDER BY created_at DESC,rowid DESC LIMIT 50""").fetchall()
        return [{"run_id": row["run_id"], "created_at": row["created_at"],
                 "created_by": row["created_by"], "policy_version": row["policy_version"],
                 "summary": json.loads(row["summary_json"])["summary"]} for row in rows]

    def reset_allocation(self) -> dict:
        with self._connect() as db:
            db.execute("""UPDATE app_state SET active_run_id=NULL,status='reset',version=version+1,
                updated_at=CURRENT_TIMESTAMP WHERE singleton=1""")
        return self.allocation_state()

    def save_opportunities(self, opportunities: list[dict], expected_version: int | None = None) -> None:
        with self._connect() as db:
            state = db.execute("SELECT version FROM app_state WHERE singleton=1").fetchone()
            if expected_version is not None and state["version"] != expected_version:
                raise ValueError("Candidate or opportunity data changed in another session. Reload before saving.")
            referenced = {row[0] for row in db.execute("SELECT DISTINCT opportunity_id FROM candidate_preferences")}
            incoming = {item["id"] for item in opportunities}
            missing_references = referenced - incoming
            if missing_references:
                raise ValueError(f"Cannot remove opportunity {sorted(missing_references)[0]} while a candidate has it in preferences.")
            for item in opportunities:
                db.execute("""INSERT INTO opportunities(
                    opportunity_id,name,required_skills_json,seats,required_qualifications_json,sector,location
                ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(opportunity_id) DO UPDATE SET
                    name=excluded.name,required_skills_json=excluded.required_skills_json,seats=excluded.seats,
                    required_qualifications_json=excluded.required_qualifications_json,
                    sector=excluded.sector,location=excluded.location""", (
                    item["id"], item["name"], json.dumps(item["required_skills"]), item["seats"],
                    json.dumps(item["required_qualifications"]), item["sector"], item["location"],
                ))
            self._invalidate_current_allocation(db, "opportunities_updated")

    @staticmethod
    def _invalidate_current_allocation(db, stale_status: str = "profile_updated") -> None:
        db.execute("""UPDATE app_state SET status=?,active_run_id=NULL,version=version+1,
            updated_at=CURRENT_TIMESTAMP WHERE singleton=1""", (stale_status,))

    def allocation_state(self) -> dict:
        with self._connect() as db:
            row = db.execute("SELECT active_run_id,status,version,updated_at FROM app_state WHERE singleton=1").fetchone()
        return dict(row)

