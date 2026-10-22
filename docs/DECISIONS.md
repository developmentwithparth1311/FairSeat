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
- Runtime package pins are recorded in `rag_service/requirements.txt`.
  `faiss-cpu` is pinned to 1.15.1 and NumPy to 2.2.6 for the declared Python
  3.10+ range; the local environment did not have FAISS installed, so its
  native index save/load branch was not exercised here.
- The cache key hashes Markdown content and generated company documents, and
  records the embedding model name. Company descriptions are generated in
  memory from the loaded `companies.json` export.
- Scheme policy content remains a placeholder marked
  `TODO: VERIFY AGAINST OFFICIAL SOURCE`; no policy numbers or dates were
  added.

## Phase 5: chat flow

- Candidate sessions are keyed by `(candidate_id, session_id)` so a reused
  session identifier cannot carry one candidate's history into another
  candidate's prompt. The prompt contains only the selected candidate's
  exported facts, retrieved knowledge, that candidate's own recent history,
  and the new question.
- The mock provider is the default and uses deterministic templates. The
  optional Gemini client uses the generateContent API through `httpx`, requires
  `GEMINI_API_KEY` and an explicitly configured `LLM_MODEL`, and retries one
  transient request failure. API shape follows Google's
  [Gemini API reference](https://ai.google.dev/api/generate-content).
- Privacy, input length/control checks, scope checks, number tripwire, and the
  guidance-only disclaimer run in the API layer. The real provider has not
  been exercised against an external API; tests mock provider responses.

## Phase 6: polish

- Added root and service setup documentation, a checked-in `.env.example`, and
  the supplied implementation spec under `docs/SAE_RAG_ASSISTANT_SPEC.md` so
  the root README can link to it.
- The six acceptance scenarios are recorded in `docs/DEMO_NOTES.md` and covered
  by offline tests with local fixtures. The official scheme FAQ remains marked
  for verification before a public demo.
- Cutoff access returns `std::optional<double>` so an open seat is represented
  explicitly as absent, including for any unusual negative score input.

## Phase 7: SIH25033 improvement roadmap — Phase 1

- Added an optional seventh candidate CSV column, `preferred_company_ids`.
  When present, it is the explicit ordered set of acceptable companies; an
  empty value means no acceptable options. Six-column legacy files keep the
  original score-ranked candidate order.
- The Phase 1 prototype policy keeps current fit components soft: skill
  overlap 50%, CGPA 30%, sector 10%, location 10%. It adds no minimum CGPA,
  hard skill threshold, affirmative-action rule, or prior-participation rule
  without verified policy. See `docs/ALLOCATION_POLICY.md`.
- Made deferred acceptance repeatable with ascending candidate-ID proposal
  order. Company ranking is score descending, then candidate ID ascending;
  equal-score challengers can displace a higher-ID holder.
- Added CSV header/row/numeric/duplicate-ID/preference-reference validation,
  basic quoted-comma and escaped-quote support, and positive company capacity
  validation. Removed the stray instruction line from the sample candidate
  CSV so the checked-in input passes strict row validation.
- Added allocation trace events, unmatched reason codes, assignment/capacity
  invariant checks, and a blocking-pair validator. The stability claim is
  limited to the documented strict rankings and acceptable lists.
- Explanation exports now use schema version 2 with policy/algorithm/tie
  metadata, reason codes, and trace events. The Python service continues to
  accept schema v1 and v2.
