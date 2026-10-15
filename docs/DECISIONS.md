# Implementation decisions

## Phase 1: repository inspection

- The implementation uses `Candidate` and `Company` structs in
  `include/candidate.h` and `include/company.h`, with allocation in
  `Allocator` (`include/allocator.h`, `src/allocator.cpp`). Scoring lives in
  `include/scoring.h` and `src/scoring.cpp`; the CLI is `src/main.cpp`.
- Candidate and company IDs are `int`, not strings. Exported JSON should
  serialize them consistently as strings if following the proposed schema.
- The existing `computeScore` returns a 0–100 score. The README's weights
  match the implementation: skills 50%, CGPA 30%, sector 10%, location 10%.
- `Company::heldSeats` is a public min-heap of `(score, candidate ID)` pairs;
  its top is the weakest current holder. An exporter can inspect a copy without
  changing allocation state.
- Skill matching currently uses exact, case-sensitive set membership. The
  explain-score change should make comparison trimmed and case-insensitive
  while ensuring the score API uses the same breakdown calculation.
- Menu item 7 is the explanation export. Exit moves from item 6 to item 8 to
  keep Exit last while preserving the requested export number; item 6 is left
  unused rather than changing the existing numbered actions 1–5.
- The initial build exposed a pre-existing syntax error: `Candidate` lacked
  its closing brace. Added that brace so the repository can build; no runtime
  behavior is changed by the repair.

## Sample data skill topics

Skill documentation should be generated only for skills present in
`data/companies.csv`. All company skills are currently “to be written” for the
knowledge-base phase:

AWS, Accounting, Analytics, Auditing, Branding, Cloud, Communication,
Employee Relations, Excel, Figma, Finance, Financial Modeling, Git,
Illustrator, Inventory Management, Labor Law, Linux, Logistics, ML, Marketing,
Payroll, Photoshop, Prototyping, React, Recruitment, SEO, SQL, Sketch,
Social Media, Statistics, Supply Chain.

## Baseline run observations

- After repairing the missing `Candidate` brace, `make clean && make` and
  `make test` pass. The sample menu flow (load, preferences, allocation, view,
  CSV export, exit) completes.
- `data/candidates.csv` ends with an explanatory prose line rather than a CSV
  record. The existing loader warns that it skips this malformed row and loads
  the 60 valid candidates. The input data was left unchanged.

## Phase 2: explain export

- `scoreBreakdown` returns weighted points on the existing 0–100 scale, and
  `computeScore` returns its `total`. Skill comparisons now trim whitespace and
  fold ASCII case; matched and missing skill labels are canonical lowercase.
- Exported IDs are JSON strings to match the proposed export schema even though
  the C++ maps use integer IDs.
- A choice is marked `lost_seat` when its final cutoff exists and its score is
  less than or equal to that cutoff. Equality is included because the allocator
  rejects a challenger unless its score is strictly greater than the weakest
  holder.

## Phase 3: Python service skeleton

- The service validates schema version 1 exports with Pydantic and keeps the
  parsed data in memory. If exports are absent, the service still starts and
  reports `exports_unavailable` at `/health`; candidate routes return a clear
  503 until exports are created or reloaded.
- Skill-gap ranking and outcome summaries are deterministic and use exported
  values. Sector filtering adds every company in that sector to the candidate's
  exported top choices.
- Embeddings, retrieval, chat, and `/admin/reindex` are deferred to their
  specified later phases.

## Phase 4: knowledge base and retrieval

- Created one guide for each distinct required skill in the sample company
  data. The source value `ML` is represented by the canonical guide
  `kb/skills/machine-learning.md`, according to `skill_aliases.json`.
- `/admin/reindex` builds or loads the persisted vector index. It uses the
  configured sentence-transformer model and FAISS inner-product search when
  FAISS is installed; a normalized NumPy exact-search fallback keeps local
  tests and offline development deterministic.
- The cache key hashes Markdown content and generated company documents, and
  records the embedding model name. Company descriptions are generated in
  memory from the loaded `companies.json` export.
- Scheme policy content remains a placeholder marked
  `TODO: VERIFY AGAINST OFFICIAL SOURCE`; no policy numbers or dates were
  added.
