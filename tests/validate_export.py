import json
from pathlib import Path


root = Path("tests/export_fixture")
candidates = json.loads((root / "candidates.json").read_text())
companies = json.loads((root / "companies.json").read_text())
assert candidates["graph"]["candidate_vertices"] == len(candidates["candidates"])
assert candidates["graph"]["acceptable_edges"] > 0
assert candidates["operation_counts"]["proposals"] > 0
assert candidates["operation_counts"]["seat_heap_pushes"] > 0
assert candidates["operation_counts"]["queue_pushes"] == candidates["operation_counts"]["queue_pops"]
assert candidates["schema_version"] == 3
assert companies["schema_version"] == 3
assert candidates["policy_version"] == "prototype-score-v2"
assert candidates["policy_rules"]["qualification_requirement"] == "disabled"
assert "qualifications" in candidates["candidates"][0]
assert "prior_participation" not in candidates["candidates"][0]
assert "required_qualifications" in companies["companies"][0]

assert candidates["schema_version"] == 3
assert candidates["algorithm"] == "candidate-proposing-deferred-acceptance"
candidate = candidates["candidates"][0]
assert candidate["name"] == 'A "Candidate"\\'
assert candidate["allocation"]["status"] == "matched"
assert candidate["top_choices"][0]["outcome"] == "matched"
assert candidate["top_choices"][0]["reason_code"] == "assigned_by_allocator"
assert candidates["allocation_trace"]
assert candidates["allocation_trace"][0]["sequence"] == 1

by_id = {company["id"]: company for company in companies["companies"]}
assert by_id["10"]["cutoff_score"] is not None
assert by_id["20"]["cutoff_score"] is None
print("Explanation export JSON and cutoff checks passed.")
