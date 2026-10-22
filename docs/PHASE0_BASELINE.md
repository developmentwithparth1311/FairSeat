# Phase 0 Baseline — Pre-Phase-1 Repository Snapshot

This is an inspection-based snapshot from before Phase 1 changes. It records
the original behavior for comparison and previously documented validation; it
is intentionally historical after Phase 1 updates the allocator.

## Repository baseline

- Allocation engine: C++17 CLI (`src/main.cpp`) with candidate/company CSV
  loading, score ranking, deferred-acceptance-style queue allocation, result
  printing/CSV export, and explanation JSON export.
- Assistant: Python FastAPI API plus terminal client; deterministic summary
  and skill-gap functions, local Markdown retrieval, mock provider, and
  optional Gemini generateContent API client.
- Interfaces: C++ engine exports `exports/candidates.json` and
  `exports/companies.json` with schema version 1; Python loaders reject
  unsupported versions.
- The root README and service README describe local CLI/API operation. There
  is no browser frontend in the repository.

## Current sample data

- `data/candidates.csv`: header, 60 candidate records, then an instruction
  line (“Replace data/companies.csv with this...”) and a blank line. The
  existing loader warns and skips the malformed instruction row; the 60
  candidate records are loaded. This input artifact should be cleaned or
  rejected clearly in a future data-validation phase.
- `data/companies.csv`: 15 company records with a total capacity of 50 seats.
- The checked-in samples are demonstration data, not an official PM Internship
  Scheme dataset.
- Names in these samples are personal-looking identifiers. Treat them as
  synthetic demo data unless provenance confirms otherwise; do not infer that
  they are real participants.

## Current matching behavior from source inspection

1. Every candidate-company pair is scored; there is no hard eligibility
   filtering.
2. Score is 0–100: required-skill overlap (50%), CGPA normalized against 10
   (30%), exact sector equality (10%), exact location equality (10%).
3. Each candidate's list contains all companies, sorted by descending score;
   equal score is ordered by ascending company ID.
4. Candidates propose through a queue. A company accepts into an open seat;
   when full, the weakest current score is inspected from a min-heap. A
   strictly higher score displaces the weakest holder. A lower or equal score
   candidate advances to its next company.
5. Initial queue order comes from iterating an `unordered_map`; equal-score
   competition can therefore depend on iteration/proposal order. There is no
   explicit tie policy for a company's equal-score candidates.
6. Candidate preference rank describes the generated score order, not a
   candidate-submitted preference order. Company ranking uses the score.
7. Company cutoff is the weakest final holder score when capacity is full;
   it is null when at least one seat remains open.

## Current data-structure baseline

- `unordered_map<int, Candidate>` and `unordered_map<int, Company>` for ID
  lookups and records.
- `unordered_map<long long, double>` for cached pair scores.
- `vector<int>` for each candidate's generated preference list.
- `queue<int>` for proposers and displaced candidates.
- `priority_queue<pair<double,int>, ..., greater<...>>` as a per-company
  min-heap for seat holders.
- `std::sort` for candidate preference ordering and result display ordering.

No allocation trace or operation counter is currently exported. Pair scores
are generated densely across all candidate-company combinations, even when
the candidate has no meaningful skill overlap.

## Existing verification recorded before Phase 0

Repository notes and the preceding implementation work record:

- `make clean && make` completed successfully.
- `make test` completed successfully.
- Python service suite completed with 17 passing tests after the Gemini client
  migration.
- These are prior results, not a fresh Phase 0 rerun. The current Gemini
  integration has mocked-response coverage; no live Gemini call is recorded.
- Native FAISS save/load was not exercised in the previous recorded run; the
  NumPy fallback was used for local coverage.

## Phase 0 scope boundary

This baseline does not decide official PMIS eligibility, qualification
thresholds, affirmative-action rules, treatment of prior participation, or
how candidate preferences should be collected. Those require authoritative
sources or an explicitly labeled prototype assumption before implementation.

