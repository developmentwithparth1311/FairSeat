import json
from pathlib import Path


root = Path("tests/export_fixture")
candidates = json.loads((root / "candidates.json").read_text())
companies = json.loads((root / "companies.json").read_text())

assert candidates["schema_version"] == 1
candidate = candidates["candidates"][0]
assert candidate["name"] == 'A "Candidate"\\'
assert candidate["allocation"]["status"] == "matched"
assert candidate["top_choices"][0]["outcome"] == "matched"

by_id = {company["id"]: company for company in companies["companies"]}
assert by_id["10"]["cutoff_score"] is not None
assert by_id["20"]["cutoff_score"] is None
print("Explanation export JSON and cutoff checks passed.")
