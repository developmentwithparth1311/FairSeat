# SIH25033 Project Improvement Roadmap

## 1. Purpose

This roadmap turns the existing Stable Allocation Engine (SAE) into a strong
college project and a convincing SIH25033 prototype. It aims to demonstrate:

1. A defensible, explainable candidate-to-internship allocation method.
2. The SIH problem's matching inputs: skills, qualifications, location,
   sector interests, affirmative-action considerations, prior participation,
   and company capacity.
3. A usable frontend that demonstrates the engine.
4. Clear data-structures and algorithms work suitable for a Data Structures
   course: design, implementation, invariants, complexity, comparison, and
   measured results.

The public SIH25033 statement calls for a functional prototype with an
AI-based matchmaking engine and a frontend prototype. It names the matching
factors, but does not mandate a particular programming language, ML model,
database, or production architecture. The implementation should therefore
prioritize sound matching and a demonstrable interface over adding ML only for
appearance.

## 2. Current state

The repository already includes:

- A C++17 command-line engine that reads candidate/company CSVs, scores
  candidate-company pairs, creates preference lists, and runs a
  Gale-Shapley-style deferred-acceptance allocator.
- A candidate proposal queue, per-company min-heaps, hash maps, and sorted
  preference lists.
- Score breakdown and JSON export for downstream explanation.
- A Python FastAPI service for export loading, allocation summaries, skill-gap
  analysis, retrieval-augmented chat, and a terminal chat client.
- A local markdown knowledge base and mock/Gemini provider support.
- C++ and Python tests, plus setup and design documentation.

Known gaps to address before claiming full SIH coverage:

- Current sample CSVs have skills, CGPA, sector, location, company seats, and
  required skills. They do not represent the full candidate preference list,
  eligibility rules, prior participation, or affirmative-action policy as
  first-class data.
- Current scoring combines skill overlap, CGPA, sector, and location. A score
  is a ranking mechanism; it is not a learned AI model and does not by itself
  guarantee fairness or maximize total assignments.
- There is no graphical frontend yet.
- There is no verified, authoritative policy source in the scheme FAQ.
- Gemini HTTP behavior has mocked tests, but a live key/model call and a full
  local end-to-end run still need to be demonstrated.
- Admin API routes currently have no authentication and are for local
  prototype use.

## 2.1 Build sequence and phase gates

Use the following sequence as the working implementation plan. Each phase
should end with a reviewable artifact and its exit checks before the next
phase starts. This keeps the allocation policy and data contract stable before
the UI is built around them.

| Build phase | Name | Main outcome | Depends on | Status |
|---|---|---|---|---|
| 0 | Baseline and requirements | Confirm current behavior, map SIH criteria, draft data contract and demo fixtures | Existing repository | Ready to begin |
| 1 | Matching model and correctness | Explicit eligibility, rankings, deterministic ties, allocation explanations, correctness checks | Phase 0 contract | Planned |
| 2 | Data Structures lab | Bipartite graph, trace events, operation counters, complexity and benchmark report | Phase 1 allocation model | Planned |
| 3 | SIH criteria and fairness simulation | Add missing profile fields and policy-driven scenario metrics | Phase 0 policy map; Phase 1 contract | Planned |
| 4 | Frontend prototype | Dashboard, inputs, run flow, results/explanations, algorithm lab | Phases 1–3 APIs and output schema | Planned |
| 5 | Assistant, policy sources, and safeguards | Verified knowledge, advisory chat, access/data handling controls | Phase 4 data flows; verified sources | Planned |
| 6 | Integration, evaluation, and presentation | End-to-end evidence, benchmark comparison, course report and demo rehearsal | Phases 1–5 | Planned |

### How we will work through the phases

- Work on one phase at a time; keep a short checklist and mark it complete
  only when its exit checks are satisfied.
- Make changes in small reviewable increments, preserving the working CLI and
  existing assistant unless a phase explicitly changes their behavior.
- Run the relevant existing checks plus new phase-specific checks after code
  changes. Keep synthetic fixtures deterministic and separate from any real
  candidate data.
- At a phase gate, summarize changed files, decisions, evidence, known limits,
  and the next phase. Then continue to the next phase unless a real policy,
  privacy, or data dependency needs the user's decision.
- Do not put Gemini or any other LLM in the allocator's decision path.

### Phase 0 — Baseline and requirements (start here)

**Tasks**

1. Capture baseline build/test results and inspect the current CSV/JSON
   examples and scoring/allocation behavior.
2. Create a traceability table for each SIH criterion: current coverage,
   proposed input, proposed rule, explanation, validation case, and any
   official-policy dependency.
3. Draft version 2 candidate/company schemas with explicit preferences and
   optional fields. Keep new policy-dependent fields optional until their use
   is verified.
4. Define a small hand-verifiable fixture set (ties, no eligible options,
   full seat and displacement, open seat, duplicate/invalid input) and a
   deterministic larger synthetic data generator specification.
5. Record unresolved decisions: exact qualification rule, location semantics,
   how sector interest is used, whether prior participation affects eligibility
   or ranking, and what affirmative-action constraints are officially required.

**Deliverables**

- `docs/REQUIREMENTS_TRACEABILITY.md` with SIH criterion-to-evidence mapping.
- `docs/DATA_DICTIONARY.md` with field types, definitions, optionality,
  sensitivity, and current status (confirmed, prototype assumption, or needs
  verification).
- Versioned example input/output fixtures under `tests/fixtures/`.
- Baseline behavior and known limitations noted in the design docs.

**Exit gate**

- Existing input/output behavior is documented; proposed schema fields have
  definitions; unresolved policy items are explicitly marked; fixtures can
  distinguish intended behavior without relying on an LLM.

**Can begin without new user data:** yes. Use the current CSVs and clearly
synthetic edge-case fixtures. No official eligibility, reservation, or past
participation rule will be invented during this phase.

### Phase 1 — Matching model and correctness

**Tasks**

1. Implement input validation and a clear distinction between eligibility and
   preference score.
2. Add explicit preference order and deterministic company ranking/tie
   breaking.
3. Refactor matching logic around documented policy and algorithm interfaces.
4. Add an allocation trace and reason codes to output.
5. Add invariant checks: capacity, one assignment per candidate, eligible
   assignments only, deterministic output, and stability/blocking-pair check
   under the declared preference model.

**Deliverables**

- Updated C++ model/parser/scoring/allocator and versioned explanation export.
- Written algorithm description, tie-break rules, and correctness tests.

**Exit gate**

- Hand-worked fixtures pass; every assigned seat is explainable; stability is
  checked against the exact preference model and claimed only for that model.

### Phase 2 — Data Structures lab

**Tasks**

1. Represent eligible pairs as a bipartite graph, using sparse adjacency lists
   where that is beneficial.
2. Emit structured trace events for queue proposals, heap comparisons,
   displacement, and completion.
3. Add operation counters and a fixed-seed benchmark generator.
4. Compare current heap approach with a linear-scan baseline; compare dense
   and sparse pair storage.
5. Add a greedy baseline and compare it with deferred acceptance. Treat
   max-weight allocation as a stretch comparison with a separately stated
   objective.
6. Document data-structure invariants, costs, measured results, and limitations.

**Deliverables**

- Graph/trace/counter output, reproducible benchmark results, and a short
  Data Structures analysis suitable for the course report.

**Exit gate**

- A demo can show at least one displacement step and explain which queue/heap
  operation caused it; results include operation counts and a complexity
  discussion tied to the actual implementation.

### Phase 3 — SIH criteria and fairness simulation

**Tasks**

1. Add qualifications, preferred locations, sector interests, candidate
   preferences, and past participation to the contract where policy permits.
2. Put rules and weights in a versioned policy configuration, not scattered
   constants.
3. Implement missing criteria only after their semantics are defined.
4. Add aggregate fairness and sensitivity reports using synthetic scenarios
   first; protect sensitive attributes and avoid unsupported policy claims.

**Deliverables**

- Versioned policy file, expanded data fixtures, aggregate diagnostics, and
  explicit source/assumption notes.

**Exit gate**

- Every SIH factor is implemented from a stated rule or listed as awaiting
  official confirmation. Scenario changes are reproducible and explainable.

### Phase 4 — Frontend prototype

**Tasks**

1. Build a responsive React/Vite client against the FastAPI contract.
2. Add data validation/preview, allocation run, results, unmatched candidates,
   open capacity, and decision explanations.
3. Add the Algorithm Lab step-through view using Phase 2 trace events.
4. Add aggregate fairness/sensitivity views from Phase 3.
5. Clearly label synthetic demo data and show the dataset/policy version.

**Deliverables**

- A browser demo that runs allocation and lets a reviewer inspect a specific
  result and step through at least one displacement.

**Exit gate**

- The core demo path works without terminal interaction; UI does not implement
  or alter matching policy itself.

### Phase 5 — Assistant, policy sources, and safeguards

**Tasks**

1. Verify policy FAQ material against official documents and record source and
   verification dates.
2. Keep chat advisory, candidate-scoped, and grounded in retrieved sources.
3. Protect admin endpoints or bind them strictly to local-only operation.
4. Minimize sensitive data in exports, logs, prompts, and history; disclose
   external Gemini processing when applicable.
5. Add safe provider/error checks and an opt-in live API smoke test.

**Deliverables**

- Source-verified knowledge base, privacy/access notes, and a secure local demo
  configuration.

**Exit gate**

- The service cannot expose admin operations to an unauthenticated network
  user; assistant behavior and citations are validated with mock tests, and a
  live Gemini call is only claimed if actually performed.

### Phase 6 — Integration, evaluation, and presentation

**Tasks**

1. Run the full input-to-frontend scenario and regression checks.
2. Complete algorithm/data-structure benchmarks and fairness scenarios.
3. Prepare architecture, pseudocode, complexity, results, limitations, and
   source references for the course report and presentation.
4. Rehearse a short demo covering a displacement, unmatched candidate, open
   seat, explanation, and algorithm comparison.

**Deliverables**

- Repeatable demo instructions, report/slides outline, benchmark evidence,
  known-limitations list, and final acceptance checklist.

**Exit gate**

- The demo is repeatable from documented setup steps and no claim exceeds the
  available test/data evidence.

## 3. Core recommendation: build a transparent allocator before ML

Do not train a model to decide who receives an internship at this stage. There
is no verified historical dataset of candidate profiles, offers, acceptances,
and outcomes in the repository. Training on synthetic labels could produce
attractive charts but would not establish that placements are accurate or
fair.

Instead, make the engine's decision policy explicit and measurable:

1. Apply documented hard eligibility constraints.
2. Construct candidate preference rankings using disclosed fit criteria.
3. Construct company rankings using disclosed role requirements.
4. Allocate seats with a named matching algorithm and tie-breaking policy.
5. Report stability, unmatched candidates, capacity usage, and fairness
   diagnostics.
6. Compare the algorithm with simple baselines on repeatable datasets.

This gives a stronger academic story: algorithm selection is justified by
requirements and measured trade-offs. ML can be added later as an optional,
separately evaluated score component if appropriate real labels become
available; it should not silently override eligibility or allocation rules.

## 4. Proposed system design

Keep the existing C++ engine as the authoritative allocation component. Keep
the Python service for API, retrieval, and assistant features. Add a frontend
that calls the service and reads allocation results. Define one versioned
input/output contract between the C++ engine and Python service.

```text
Candidate/company data
        |
        v
Validation + eligibility filters
        |
        v
Pair scoring + preference rankings
        |
        v
C++ matching/allocation algorithms
        |
        +----> allocation + score explanations + audit summary (versioned JSON)
                       |                         |
                       v                         v
                 FastAPI endpoints       RAG assistant (advisory only)
                       |
                       v
              Web frontend / demo dashboard
```

The LLM must remain outside the allocation decision path. It may explain
exported results and answer questions from verified documents; it must never
change scores, eligibility, rankings, or assignments.

## 5. Detailed implementation phases

### Phase 0 — Freeze requirements, data contract, and demo scope

**Work**

- Record SIH25033 criteria in a traceability table: criterion, input field,
  rule/algorithm, output explanation, test/demo evidence.
- Choose a prototype policy for each criterion. Mark any policy requiring
  official PM Internship Scheme confirmation as unresolved until verified.
- Define CSV schemas and JSON `schema_version` updates before changing code.
- Decide which fields are required, optional, sensitive, or synthetic.
- Create a small hand-verifiable dataset with edge cases and a larger seeded
  synthetic dataset for performance experiments. Clearly label synthetic
  records.

**Candidate fields to consider**

- ID; skills; qualification/education data used by the chosen policy.
- Candidate-ranked internship/company preferences.
- Acceptable locations and sector interests.
- Prior participation status, if the official policy makes it relevant.
- Optional district/category attributes only if there is a documented,
  approved allocation rule and a safe way to handle sensitive data.

**Company/opportunity fields to consider**

- ID; required/preferred skills; qualification requirements.
- Location; sector; capacity; candidate preference/ranking rule.
- Any verified eligibility or reservation constraints, represented explicitly
  rather than hidden in score weights.

**Deliverable / exit condition**

- A reviewed data dictionary, sample fixtures, and requirement-to-demo matrix.
- Every added field has a clear use; no sensitive attribute is collected just
  because it appears in the problem statement.

### Phase 1 — Make the allocation policy correct and explainable

**Work**

- Separate **hard eligibility** from **soft fit scoring**. A candidate who is
  ineligible for an opportunity must not become eligible because of a high
  score.
- Make candidate preferences explicit. A preference list may combine a
  candidate's submitted order with fit, but the policy and tie-breakers must be
  stated.
- Define company ranking over candidates for each opportunity. Include
  qualification and required skills as specified by the policy; use a stable,
  deterministic tie-break (for example, score then candidate ID) so runs are
  reproducible.
- Decide whether seats are homogeneous and whether category-specific seats or
  quotas exist. Encode only verified rules; do not approximate a quota with an
  undocumented score bonus.
- Make score weights/configuration visible and versioned. Include component
  scores, hard-rule results, rank, tie-break explanation, and final outcome in
  the export.
- Add validation for duplicate IDs, malformed skills, invalid capacities,
  impossible preference references, and missing required fields.

**Important algorithm note**

Deferred acceptance is stable relative to the preference lists supplied to
it, assuming the algorithm's matching model and tie handling are consistent.
It does not automatically maximize the sum of scores, fill every seat, or
prove that an external fairness policy is satisfied. Document the exact
stability definition and the side that proposes (candidates or companies).

**Deliverable / exit condition**

- A written allocation policy; deterministic output on repeated runs; a
  validator that detects blocking pairs for the stated two-sided preference
  model; hand-worked examples for matches, rejections, ties, empty lists, and
  unfilled seats.

### Phase 2 — Turn Data Structures into a first-class course contribution

This is the recommended centerpiece for the Data Structures subject.

**Data structures to present and justify**

| Structure | Project use | Expected operation | Complexity to discuss |
|---|---|---|---|
| `unordered_map<ID, record>` | Candidate/company lookup | Find by ID | Average O(1), worst O(n) |
| `vector` / adjacency lists | Preference lists and eligible bipartite graph | Iterate candidates and edges | O(V + E) traversal/storage |
| `queue` | Deferred acceptance proposal pool | Push/pop next proposer | O(1) amortized |
| `priority_queue` / min-heap | Keep weakest current seat-holder at top | Inspect weakest / replace | O(1) peek, O(log k) update |
| `sort` | Build deterministic preference orders | Rank alternatives | O(d log d) per candidate |
| score matrix or sparse edge list | Store candidate-opportunity scores | Read score / traverse eligible edges | O(nm) dense; O(E) sparse |
| bitsets or sets (optional) | Skill membership/intersection | Membership and overlap | Explain representation-dependent costs |

**Improvements to implement**

- Add a bipartite eligibility graph: candidate vertices on one side,
  opportunities on the other, and an edge for each eligible pair. This makes
  the allocation model visual and allows sparse datasets to avoid storing
  impossible pairs.
- Record an allocation trace: proposal, vacancy/competition, incumbent
  displacement, next proposal, and final state. Reuse the trace in the UI and
  in the report.
- Instrument operation counts (score evaluations, proposals, heap pushes/pops,
  comparisons) in addition to wall-clock time. Explain that wall-clock results
  vary by machine.
- Add a complexity section with symbols defined: `n` candidates, `m`
  opportunities, `E` eligible candidate-opportunity pairs, `k_j` capacity of
  opportunity `j`, and `d_i` candidate `i`'s acceptable choices.
- Analyze the current dense scoring path as roughly O(nm) score calculations
  plus preference sorting; allocation examines proposals and uses heap updates
  for seat competition. State exact bounds only after auditing implementation
  details and whether proposals can repeat.
- Add a benchmark generator with fixed seeds and sizes, e.g. 100, 1,000,
  5,000, and 10,000 candidates where feasible. Report input density and
  capacity distribution.
- Demonstrate data-structure trade-offs: linear scan of held candidates vs
  min-heap; dense score table vs sparse eligible-edge list; sorted vector vs
  repeatedly selecting the next preference.
- Add a “Run trace” or “Algorithm lab” view with step-through, pause/resume,
  current queue, company heaps, assignments, and highlighted data changes.

**Optional algorithms comparison (strong course/demo value)**

Implement at least one baseline and one alternative behind a common interface:

1. **Greedy baseline:** process candidates in a fixed order and assign the
   highest-ranked remaining seat. Simple, fast, and may be order-sensitive or
   unstable.
2. **Deferred acceptance:** the current stable-matching approach. Explain its
   stability guarantee and proposer-side trade-off.
3. **Maximum-weight allocation (stretch):** use min-cost max-flow or a known
   assignment/optimization library to maximize total fit under capacity. This
   optimizes a different objective and is not inherently stable or fair.

Compare assignment count, total/average fit, unmatched count, capacity
utilization, blocking pairs (where applicable), runtime, and operation counts.
Never label one algorithm “best” without stating the objective and constraints.

**Deliverable / exit condition**

- A demonstrable data-structure trace, complexity write-up, reproducible
  benchmark chart/table, and algorithm comparison using seeded data.

### Phase 3 — Implement missing SIH criteria and fairness evaluation

**Work**

- Add qualifications, preferred locations, sector interests, explicit
  preferences, and past participation only after the policy for each field is
  specified.
- Introduce a policy configuration layer for hard requirements, weights,
  tie-breaking, seat rules, and policy version. Keep policy separate from
  algorithm code.
- For affirmative action, begin with a **simulation and reporting module**:
  show representation and allocation outcomes under documented scenarios.
  Do not use protected attributes in live allocation until official rules,
  governance, and data authorization are established.
- Add aggregate metrics: eligible rate, allocation rate, seats filled,
  unmatched count, average score by relevant cohort, location/sector coverage,
  and differences between groups where lawful and statistically meaningful.
- Add a counterfactual “what changed?” report when a policy parameter changes.
- Add sensitivity analysis: vary one weight or policy constraint at a time and
  display how many assignments change.
- Document that fairness metrics are diagnostics, not proof of fairness; note
  sample-size limits and trade-offs.

**Deliverable / exit condition**

- Every SIH criterion maps to an implemented field/logic/report or is visibly
  marked as not implementable until policy/data is verified.
- Fairness scenarios are reproducible and do not silently alter allocation.

### Phase 4 — Build the frontend prototype

**Recommended approach**

- Add a React + Vite web frontend (or a lightweight server-rendered UI if
  minimizing dependencies is more important). Keep allocation rules in C++;
  the frontend must not duplicate matching logic.
- Add a small API adapter so the UI talks to FastAPI. If the frontend must
  trigger a fresh allocation, expose a narrow, local-demo endpoint or wrapper
  that safely invokes the engine and returns a versioned result.

**Screens for a compelling demo**

1. **Overview:** candidates, opportunities, seats, assigned/unassigned,
   capacity utilization, and run status.
2. **Input/data validation:** upload or choose sample CSVs; preview rows and
   report validation issues before allocation.
3. **Opportunity/candidate browser:** search and filter by sector, location,
   skills, and eligibility; respect role-based visibility if authentication
   is added.
4. **Run allocation:** select a policy/algorithm version and run on clearly
   marked demo data.
5. **Results:** assignments, unmatched candidates, open seats, fit score,
   rank, and concise reason codes.
6. **Explain this result:** score breakdown, eligibility checks, alternatives,
   seat competition/cutoff, and allocation trace.
7. **Algorithm lab:** animate queue, proposals, heaps, and changes step by
   step; show operation counts and complexity note.
8. **Fairness and sensitivity:** aggregate charts and scenario comparisons;
   never expose another candidate's personal record on a candidate-facing
   page.
9. **Candidate assistant:** optional advisory chat with citations; keep it
   clearly separate from official allocation results.

**UI quality goals**

- Responsive layout, keyboard access, readable contrast, clear empty/error
  states, and plain-language labels.
- Avoid using color as the only signal. Label synthetic/demo data prominently.
- Show which policy version and dataset produced a result.

**Deliverable / exit condition**

- A user can load demo data, run an allocation, inspect results, and step
  through at least one displacement without using a terminal.

### Phase 5 — Make assistant answers safer and more useful

**Work**

- Replace the scheme FAQ placeholder with dated, linked official documents;
  track the source and last-verified date for every policy fact.
- Keep the assistant advisory only. It should state when it lacks verified
  information, cite retrieved source titles, and never infer policy from
  unverified knowledge-base notes.
- Keep candidate-specific prompts scoped to that candidate. Add authorization
  before supporting real candidate records; an ID in a URL or request body is
  not authentication.
- Add rate limits, input limits, safe error messages, and restricted access
  for `/admin/reload` and `/admin/reindex` before network exposure.
- Minimize personal data in exports, logs, prompts, and stored chat history.
  Use synthetic data for public demos. State when candidate text is sent to an
  external Gemini API.
- Add a provider health/config check that does not reveal secrets. Make live
  Gemini testing an explicit opt-in and avoid printing API keys or full
  prompts.

**Deliverable / exit condition**

- Verified policy sources and a documented privacy boundary; admin endpoints
  are protected or bound to local-only use; assistant citations and refusal
  cases are demonstrated.

### Phase 6 — Evaluation, quality, and presentation

**Testing/evaluation plan**

- Unit tests for parsing, eligibility, score components, rankings, tie-breaks,
  each data structure's behavior, and export schema.
- Algorithm properties: capacity never exceeded; candidate matched at most
  once; only eligible edges assigned; deterministic ties; no blocking pair
  under the declared preference model.
- Property/randomized tests on small generated cases, compared with a simple
  reference implementation.
- End-to-end test: input CSV -> validate -> allocate -> export -> API -> UI
  result explanation.
- Benchmark reproducibility: fixed random seeds, documented hardware/runtime,
  several data sizes/densities, and measured operation counts.
- Fairness scenario test cases with known outcomes and clear caveats.
- Security/privacy checks: unauthorized admin calls fail; candidate scope is
  enforced; no secret appears in logs or exports.
- Live Gemini test only with a user-provided valid key; mock-mode tests must
  remain fully offline.

**Final presentation/report**

- Problem statement and requirement traceability.
- System architecture and data flow.
- Data model and policy assumptions.
- Algorithm explanation and pseudocode.
- Data-structure table, invariants, complexity, and benchmark evidence.
- Comparison of greedy/deferred-acceptance/optimization approaches.
- Allocation quality and fairness diagnostics.
- Frontend walkthrough and candidate explanation example.
- Limitations: synthetic data, unverified policy, no claim of production use.
- Demo script with one displacement, one unmatched applicant, one open seat,
  and one policy/sensitivity comparison.

## 6. Is ML worthwhile?

### Recommendation for the current project

**Do not train an allocation model yet.** The repository has no trustworthy
historical ground-truth dataset. A model trained on made-up outcomes would
learn the generator's assumptions and could create false confidence.

### When ML becomes justified

If authorized historical data later exists, define a narrow prediction task,
such as estimating candidate interest/acceptance or predicting skill
similarity—not replacing eligibility rules or the allocator. Then:

1. Define the label and decision use before collecting data.
2. Use a time-based or organization-separated holdout to avoid leakage.
3. Compare against simple baselines (majority rate, logistic regression,
   deterministic score).
4. Evaluate calibration, precision/recall as appropriate, subgroup error,
   and drift; do not report only accuracy.
5. Keep predictions advisory or expose their contribution in the score
   breakdown; run a shadow evaluation before allowing influence.
6. Obtain appropriate permission, minimize personal data, and document the
   risks of using protected attributes or proxies.

For a college “AI” demonstration without real labels, use explainable
rule-based scoring plus a clearly labeled **synthetic simulation** to study
algorithm behavior. Do not present synthetic training accuracy as evidence of
real-world validity.

## 7. Suggested schedule

An example 6-week sequence; adjust for course deadlines and team size.

| Week | Focus | Demo evidence |
|---|---|---|
| 1 | Requirements matrix, schema, policy assumptions, hand-verifiable data | Inputs/outputs and SIH traceability reviewed |
| 2 | Eligibility, preference/ranking model, deterministic allocation, blocking-pair validator | Correctness cases and explanation output |
| 3 | Graph representation, operation tracing, benchmarks, baseline comparison | Data-structure lab and first charts |
| 4 | Frontend dashboard, results, explanation, algorithm step-through | End-to-end browser demo |
| 5 | SIH criteria fields, fairness/sensitivity simulation, verified policy sources | Scenario comparison and caveats |
| 6 | Security/privacy polish, integration checks, report, slides, rehearsal | Repeatable final demonstration |

If time is short, prioritize Weeks 1–4. Treat fairness policy integration and
ML as conditional on verified rules/data, not as dependencies for the demo.

## 8. Definition of a strong final result

The project is ready to present when:

- It covers all SIH factors in the schema and either implements or explicitly
  documents the verified policy for each one.
- The allocator's guarantee and limitations are stated accurately.
- A frontend can demonstrate data validation, allocation, results, and an
  algorithm trace.
- Data structures are visible in code and in a step-through view, with
  measured operation counts and an honest complexity analysis.
- At least two algorithms are compared against declared objectives.
- Tests show assignments respect eligibility and capacity, are reproducible,
  and have the expected stability property where applicable.
- Fairness and sensitivity results are presented as diagnostics, not as
  unsupported claims.
- No ML claim relies on fabricated ground truth.
- Demo data is labeled synthetic, scheme rules are sourced, and candidate
  information is not exposed without authorization.

## 9. References

- SIH 2025 problem list PDF (identifies SIH25033, Ministry of Corporate
  Affairs, Software, Smart Automation):
  <https://www.driems.ac.in/wp-content/uploads/2025/09/Smart-India-Hackathon_PROBLEM-STATEMENTS.pdf>
- Public transcription of the SIH25033 description and expected solution:
  <https://gist.github.com/theprtsh/2dbccc7eb68340d35e4b187180fe5eda>
- Existing implementation specification:
  [SAE + RAG Candidate Assistant spec](SAE_RAG_ASSISTANT_SPEC.md)

