# SAE + RAG Candidate Assistant — Implementation Spec

> **Audience:** the coding agent (Codex) working inside the `Stable_Allocation_Engine` (SAE) repository.
> **Goal:** add a RAG-based chat assistant that helps candidates understand their skills, why they were (or were not) matched, and what to improve — **without changing how the allocation itself works.**

---

## 0. Read this first (working rules for the agent)

1. **Inspect the repo before writing code.** Read `include/`, `src/`, `data/`, `Makefile` and the existing `README.md`. This spec describes the project from its README; the real code may differ in names. Where this spec names a class or file (`Allocator`, `scoring.cpp`, `scoreCache_`, `Company::heldSeats`), confirm it exists and adapt to the actual names.
2. **Do not break the existing CLI.** The current menu flow (load → build preferences → allocate → view → export) must keep working exactly as before. All new C++ behaviour is **additive**.
3. **C++ stays C++17 with no new third-party dependencies.** Write the JSON export by hand (with correct string escaping) rather than adding a library.
4. **Single source of truth for scoring.** The C++ engine computes all scores. The Python service must **never re-implement the scoring formula**; it only reads what C++ exports.
5. **The assistant is advisory only.** It must never modify allocation results, scores, or seat data.
6. **Never invent facts about the PM Internship Scheme.** Scheme rules (eligibility, stipend, reservations, timelines) must come from the knowledge base files only. Any such file I have not verified is marked `TODO: VERIFY AGAINST OFFICIAL SOURCE`; keep that marker visible.
7. **Work in small, reviewable steps**, one phase at a time (section 10). Commit after each phase with a clear message. After each phase, make sure `make clean && make` still passes and the tests pass.
8. If something in this spec is ambiguous or conflicts with the real code, choose the simplest option that keeps the existing behaviour intact and note the decision in `docs/DECISIONS.md`.

---

## 1. Background

SAE is a C++ CLI tool that allocates candidates to companies (with fixed seat counts) using a Gale–Shapley-style stable matching algorithm, built for the PM Internship Scheme allocation problem (SIH 2025, problem statements SIH25033/34).

Current pipeline (from the README):

1. **Score** every candidate against every company (weighted: skill overlap 50%, CGPA 30%, sector match 10%, location match 10%; weights live in `src/scoring.cpp`).
2. **Rank** each candidate's companies into a preference list.
3. **Allocate** using a queue of unplaced candidates, a min-heap per company holding its current best candidates (weakest on top), and displacement of the weakest holder when a better candidate arrives.
4. **Export** results to `results.csv`.

Data structures in use: `unordered_map` (candidates, companies, score cache), `priority_queue` min-heap per company, `std::queue` for the pool, `std::sort` for preference lists.

Input formats:

```
candidates.csv : id,name,skills(;-separated),cgpa,sector,location
companies.csv  : id,name,required_skills(;-separated),seats,sector,location
```

## 2. What we are building

A **RAG (retrieval-augmented generation) chat assistant** that lets a candidate ask things like:

- "Why wasn't I matched?" / "Why did I get Company X?"
- "Which skills am I missing for internships in my sector?"
- "What should I learn first to improve my chances?"
- "What score would I need to get a seat at Company Y?"
- "How does the allocation work?"

The assistant answers using:

1. **Candidate-specific facts** exported by the C++ engine (skills, matched company, score breakdown, missing skills).
2. **Retrieved knowledge** from a knowledge base (company descriptions, skill glossary, learning roadmaps, scheme FAQ).

### Non-goals

- No changes to the matching algorithm, scoring weights, or results.
- No user accounts, login, or database server (files on disk are enough).
- No fine-tuning of models.
- No production-grade deployment work (Docker is optional, see stretch goals).

---

## 3. Architecture

```
                 ┌────────────────────────────┐
 CSV data ─────► │  C++ SAE (existing + new)  │
 candidates.csv  │  - scoring, allocation     │
 companies.csv   │  - NEW: explain export     │
                 └─────────────┬──────────────┘
                               │ writes
                               ▼
                   exports/candidates.json
                   exports/companies.json
                               │ reads
                               ▼
 ┌────────────────────────────────────────────────────────────┐
 │  Python RAG service  (rag_service/)                        │
 │                                                            │
 │  loaders ─► skill normalizer ─► skill-gap analyzer (no LLM)│
 │                                                            │
 │  kb/ docs ─► chunker ─► embeddings ─► vector index         │
 │                                  │                         │
 │  question ─► retriever ──────────┘                         │
 │        │                                                   │
 │        └─► prompt builder ─► LLM client ─► answer + sources│
 └───────────────────────────┬────────────────────────────────┘
                             │ HTTP (FastAPI)
                             ▼
                  chat_cli.py  (and optional web page)
```

### Repository additions

```
Stable_Allocation_Engine/
├── include/                 (existing; add explain_export.h)
├── src/                     (existing; add explain_export.cpp, edit main.cpp, scoring.*)
├── data/                    (existing)
├── exports/                 NEW  – generated JSON, git-ignored except .gitkeep
├── kb/                      NEW  – knowledge base (committed)
│   ├── scheme_faq.md
│   ├── how_allocation_works.md
│   ├── skill_aliases.json
│   └── skills/
│       ├── python.md
│       ├── sql.md
│       └── ...              (one file per skill)
├── rag_service/             NEW  – Python service
│   ├── app/
│   │   ├── main.py          FastAPI app
│   │   ├── config.py
│   │   ├── loaders.py
│   │   ├── skills.py        normalization + skill-gap analysis
│   │   ├── kb_index.py      chunking + embeddings + vector store
│   │   ├── retriever.py
│   │   ├── prompts.py
│   │   ├── llm.py           provider-agnostic client + mock
│   │   └── guardrails.py
│   ├── tests/
│   ├── chat_cli.py
│   ├── requirements.txt
│   └── README.md
├── tests/                   NEW  – C++ tests (see section 9)
├── docs/DECISIONS.md        NEW
├── Makefile                 (extend with `test` target)
└── README.md                (add a section linking to this spec)
```

---

## 4. Part A — C++ changes (explain export)

### 4.1 Expose the score breakdown

Right now scoring likely returns a single number. Add a function that returns the **components** as well, and make the existing function call it so the total is unchanged.

```cpp
// include/scoring.h  (names are suggestions; adapt to existing code)
struct ScoreBreakdown {
    double skills;    // weighted points contributed by skill overlap
    double cgpa;      // weighted points from CGPA
    double sector;    // weighted points from sector match
    double location;  // weighted points from location match
    double total;     // must equal the existing score for the same pair
    std::vector<std::string> matchedSkills;
    std::vector<std::string> missingSkills; // required by company, not held by candidate
};

ScoreBreakdown scoreBreakdown(const Candidate&, const Company&);
```

Requirements:

- `breakdown.total` must be **exactly equal** to what the current scoring returns for the same pair (add a test).
- Skill comparison should be case-insensitive and trimmed (e.g. `" Python"` equals `"python"`). If the existing code already does this, reuse it; if not, add it and note it in `docs/DECISIONS.md`.

### 4.2 New CLI menu option

Add menu item **7. Export explanation data for RAG assistant** (keep 1–6 unchanged; keep Exit as the last item or renumber consistently and update the README).

It requires that allocation has already run (same ordering rule as the existing menu). If not, print a clear message.

### 4.3 Output files

Write to `exports/candidates.json` and `exports/companies.json` (create the folder if missing).

**`exports/candidates.json`**

```json
{
  "schema_version": 1,
  "generated_at": "2026-10-15T10:30:00Z",
  "scoring_weights": { "skills": 0.5, "cgpa": 0.3, "sector": 0.1, "location": 0.1 },
  "candidates": [
    {
      "id": "C001",
      "name": "Asha Patil",
      "skills": ["python", "sql", "excel"],
      "cgpa": 8.1,
      "sector": "IT",
      "location": "Pune",
      "allocation": {
        "status": "matched",
        "company_id": "CO12",
        "preference_rank": 2,
        "score": 78.4
      },
      "top_choices": [
        {
          "company_id": "CO03",
          "company_name": "Example Tech Pvt Ltd",
          "preference_rank": 1,
          "breakdown": { "skills": 40.0, "cgpa": 24.3, "sector": 10.0, "location": 0.0, "total": 74.3 },
          "matched_skills": ["python", "sql"],
          "missing_skills": ["docker"],
          "outcome": "lost_seat",
          "company_cutoff_score": 76.1
        }
      ]
    }
  ]
}
```

Rules:

- `allocation.status` is `"matched"` or `"unmatched"`. For unmatched candidates omit the other `allocation` fields.
- `top_choices` contains the candidate's **top K companies** by preference (default `K = 5`, configurable via a constant or CLI argument). Include the matched company even if it is outside the top K.
- `outcome` for each choice is one of:
  - `"matched"` – this is where the candidate was placed
  - `"lost_seat"` – company was full and the candidate's score was below the company's cutoff
  - `"not_reached"` – candidate was placed with a more preferred company before this one was tried
- `company_cutoff_score` is the score of the **weakest candidate currently holding a seat** at that company when the company is full (the top of its min-heap), otherwise `null` (seats still open). Read it from the final heap state; do not pop the real heap — copy it or expose a read-only peek.
- Numbers use `.` as the decimal separator and are written with fixed precision (e.g. 1 decimal).

**`exports/companies.json`**

```json
{
  "schema_version": 1,
  "companies": [
    {
      "id": "CO12",
      "name": "Example Co",
      "required_skills": ["python", "sql"],
      "seats": 3,
      "seats_filled": 3,
      "sector": "IT",
      "location": "Mumbai",
      "cutoff_score": 71.2
    }
  ]
}
```

### 4.4 JSON writing

- Write a tiny helper `jsonEscape(const std::string&)` that handles `"`, `\`, control characters, and newlines.
- Keep all export code in `explain_export.h/.cpp`, separate from `Allocator`, so the allocation logic stays untouched. The exporter takes read-only references to the allocator results.

---

## 5. Part B — Python RAG service

**Stack:** Python 3.10+, FastAPI + Uvicorn, `sentence-transformers` for embeddings, FAISS (`faiss-cpu`) or Chroma for the vector store, `pydantic` for models, `pytest` for tests.

`requirements.txt` (pin versions after you install and test them):

```
fastapi
uvicorn[standard]
pydantic
sentence-transformers
faiss-cpu
numpy
python-dotenv
httpx
pytest
```

### 5.1 Configuration (`config.py`, loaded from `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SAE_EXPORT_DIR` | `../exports` | where the C++ JSON files are |
| `KB_DIR` | `../kb` | knowledge base folder |
| `INDEX_DIR` | `./.index` | cached vector index |
| `EMBED_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | embedding model (see note on multilingual below) |
| `LLM_PROVIDER` | `mock` | `mock`, `anthropic`, or `openai` |
| `LLM_MODEL` | (provider-specific) | model name |
| `LLM_API_KEY` | (empty) | API key, never committed |
| `TOP_K_CHUNKS` | `4` | retrieved chunks per question |
| `MAX_HISTORY_TURNS` | `6` | chat history kept per session |

**Never commit `.env` or API keys.** Add `.env`, `.index/`, and `exports/*.json` to `.gitignore`. Provide `.env.example`.

Note on languages: the default model is English-focused. For Hindi/Marathi support, switch `EMBED_MODEL` to a multilingual model (for example `intfloat/multilingual-e5-small`) and tell the LLM to answer in the user's language. Keep this as a config switch, not hard-coded.

### 5.2 Loaders (`loaders.py`)

- Load and validate `candidates.json` and `companies.json` with pydantic models.
- Fail with a clear error if `schema_version` is not supported.
- Cache in memory; add `POST /admin/reload` to re-read them.

### 5.3 Skill normalization and skill-gap analysis (`skills.py`) — **no LLM here**

This part must be **deterministic** so the numbers in answers are always correct.

- `normalize(skill) -> canonical`: lowercase, trim, then map through `kb/skill_aliases.json` (e.g. `"ml" -> "machine learning"`, `"js" -> "javascript"`, `"ms excel" -> "excel"`).
- `skill_gap(candidate_id, sector=None) -> SkillGap`:
  - Gather the required skills of companies in the candidate's top choices (and, if `sector` is given, of all companies in that sector).
  - Count how often each missing skill appears. Return skills sorted by **frequency across relevant companies**, then alphabetically.
  - Output example:

```json
{
  "candidate_id": "C001",
  "have": ["python", "sql", "excel"],
  "missing_ranked": [
    { "skill": "docker", "needed_by_companies": 3 },
    { "skill": "git", "needed_by_companies": 2 }
  ]
}
```

- `explain_outcome(candidate_id) -> OutcomeExplanation`: turn `allocation` + `top_choices` into structured facts (placed or not, which components were weakest, gap to `company_cutoff_score`). Example fact: `"Score 74.3 vs cutoff 76.1 at Example Tech: short by 1.8 points; biggest lever: skills (missing docker)."`

Compute "points short" and "lever" from exported numbers only. **Do not recompute scoring.** If an estimate is needed (e.g. "adding docker would add about X points"), derive it only from exported `scoring_weights` and the company's `required_skills` count, label it clearly as an estimate, and unit test it.

### 5.4 Knowledge base index (`kb_index.py`)

Sources to index:

1. `kb/**/*.md` files.
2. **Auto-generated company documents** built from `companies.json` (one short document per company: name, sector, location, seats, required skills). Generate these in memory at index time; do not write them into `kb/`.

Chunking:

- Split Markdown by headings first, then by ~300–500 tokens with ~50 token overlap.
- Every chunk stores metadata: `source_path`, `title`, `section`, `type` (`faq`, `skill`, `company`, `process`), and `chunk_id`.

Index build:

- Embed with `EMBED_MODEL`, normalize vectors, store in FAISS (inner product) or Chroma.
- Persist to `INDEX_DIR` together with a hash of the KB and company data; rebuild only if the hash changed.
- Expose `POST /admin/reindex`.

### 5.5 Retriever (`retriever.py`)

- `retrieve(query, k, filters=None) -> list[Chunk with score]`.
- Add a simple **intent hint** that boosts chunk types: questions about skills/learning boost `skill` chunks; "how does allocation work" boosts `process`/`faq`; questions mentioning a company name boost that `company` chunk.
- Drop chunks below a minimum similarity threshold (config, default `0.25`). If nothing passes, tell the prompt builder that **no relevant knowledge was found**.

### 5.6 Prompt builder (`prompts.py`)

The final prompt has four parts, in this order:

1. **System rules** (below).
2. **Candidate facts** block (from loaders + `skill_gap` + `explain_outcome`), as plain structured text.
3. **Retrieved knowledge** block, each chunk labelled with an id like `[KB-3: skills/docker.md]`.
4. **Chat history** (last `MAX_HISTORY_TURNS`) and the new question.

System rules (use this text as the starting point):

```
You are the SAE Candidate Assistant for the PM Internship Scheme allocation tool.
You help ONE candidate understand their allocation result and improve their skills.

Rules:
1. Use ONLY the CANDIDATE FACTS and KNOWLEDGE blocks below. If the answer is not
   there, say you don't know and suggest where to look (e.g. the official scheme website).
2. Never invent numbers, scores, seat counts, deadlines, stipend amounts, or eligibility rules.
3. Quote numbers exactly as given in CANDIDATE FACTS. Do not recalculate them.
4. You cannot change the allocation, scores, or seats. If asked to, explain that you cannot,
   and explain what the candidate can do (improve skills, update their profile through official channels).
5. Be encouraging and practical. Suggest at most 3 concrete next steps, ordered by impact.
6. Use plain, simple language. Keep answers short unless asked for detail.
7. Cite knowledge you used with its label, e.g. [KB-2]. Do not cite facts that came from CANDIDATE FACTS.
8. Reply in the same language as the candidate's question.
9. Never reveal information about any other candidate.
```

### 5.7 LLM client (`llm.py`)

- Define a small interface: `generate(system: str, messages: list[dict]) -> str`.
- Implement `MockLLM` (default): returns a deterministic template answer built from the candidate facts and retrieved chunk titles. This lets the whole system, tests and demo run **without an API key**.
- Implement one real provider first (`anthropic` or `openai`, chosen by `LLM_PROVIDER`) using `httpx`. Add a timeout (30 s), one retry on transient errors, and friendly error messages. Do not log the API key or full prompts at INFO level.

### 5.8 Guardrails (`guardrails.py`)

- **Input checks:** reject empty messages, cap length (e.g. 1000 chars), strip control characters.
- **Scope check:** if the question is clearly unrelated (e.g. general coding help), answer politely that the assistant is only for allocation and skill guidance. A simple keyword/embedding-similarity check against the KB is enough for v1.
- **Privacy:** only the data of the `candidate_id` in the request may be placed in the prompt. Add a test that asserts no other candidate's name or ID appears in the built prompt.
- **Output checks:** if the answer contains a number that is not present in the candidate facts or retrieved chunks, flag it (log a warning, and in `debug` mode return `"unverified_numbers": [...]`). This is a lightweight hallucination tripwire.
- Always include a short disclaimer in the API response: *"This assistant gives guidance only. Final allocation decisions are made by the official process."*

### 5.9 API (`main.py`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | status, number of candidates, KB chunks, LLM provider |
| `POST` | `/chat` | main chat endpoint |
| `GET` | `/candidates/{id}/summary` | deterministic outcome explanation (no LLM) |
| `GET` | `/candidates/{id}/skill-gap` | deterministic skill gap (no LLM) |
| `POST` | `/admin/reload` | reload exports |
| `POST` | `/admin/reindex` | rebuild vector index |

`POST /chat` request:

```json
{ "candidate_id": "C001", "session_id": "optional-string", "message": "Why wasn't I matched with my first choice?" }
```

Response:

```json
{
  "answer": "…",
  "sources": [ { "label": "KB-2", "path": "kb/skills/docker.md", "title": "Docker basics" } ],
  "facts_used": { "outcome": "lost_seat", "points_short": 1.8 },
  "disclaimer": "This assistant gives guidance only. Final allocation decisions are made by the official process."
}
```

- Sessions are held **in memory** (dict keyed by `session_id`, trimmed to `MAX_HISTORY_TURNS`).
- Unknown `candidate_id` returns HTTP 404 with a clear message.
- Enable CORS for `localhost` so a simple web page can call the API.

### 5.10 CLI client (`chat_cli.py`)

- `python chat_cli.py --candidate C001` starts an interactive loop that calls `/chat`.
- Commands: `/summary`, `/gap`, `/quit`.
- Print sources under each answer.

---

## 6. Knowledge base content

Create these files with real, useful content. **Anything about official scheme rules must carry the `TODO: VERIFY AGAINST OFFICIAL SOURCE` marker at the top** so a human checks it before the final demo.

### 6.1 `kb/how_allocation_works.md`

Plain-language explanation of SAE (this is *our* system, so it can be written from the README): scoring components and weights, preference lists, seats, displacement, why the result is stable, what a "cutoff score" means. Use short headings so the chunker splits well.

### 6.2 `kb/scheme_faq.md`

Placeholder Q&A on the PM Internship Scheme (eligibility, duration, stipend, how to apply). Put the verification marker at the top. Do not fill in specific numbers or dates unless they are given by the project owner.

### 6.3 `kb/skills/<skill>.md`

One file per skill that appears in `data/companies.csv`. Use this template:

```markdown
# <Skill name>

## What it is
Two or three plain sentences.

## Why employers ask for it
One short paragraph with typical internship tasks.

## How to get started (beginner path)
1. Step one
2. Step two
3. Step three

## Practice ideas
- Small project idea
- Small project idea

## Free resources
- Name of resource (publisher) — one line on what it covers
```

Rules for the agent when writing these:

- Mention only well-known, free resource **names** (e.g. official documentation, NPTEL, freeCodeCamp). **Do not invent URLs.** If unsure about a link, leave the resource name without a link.
- Keep each file under ~400 words.
- Generate files only for skills actually present in the sample data, then list the remaining skills in `docs/DECISIONS.md` as "to be written".

### 6.4 `kb/skill_aliases.json`

```json
{
  "ml": "machine learning",
  "js": "javascript",
  "ms excel": "excel",
  "c plus plus": "c++",
  "py": "python"
}
```

Extend this from the actual skills found in the CSV files.

---

## 7. Behaviour examples (acceptance scenarios)

**Scenario A — unmatched candidate**
Q: "Why didn't I get an internship?"
Expected: states they are unmatched, shows which top choices were lost by how many points (from exported numbers), names the top missing skills, gives at most 3 next steps, cites any KB chunk used.

**Scenario B — matched with a lower preference**
Q: "Why didn't I get my first choice?"
Expected: explains outcome `lost_seat` or `not_reached` correctly, quotes the score and cutoff exactly.

**Scenario C — skills advice**
Q: "What should I learn to improve my chances in IT?"
Expected: ranked missing skills from `skill_gap`, with a beginner path from the matching `kb/skills/*.md` chunk.

**Scenario D — out of knowledge**
Q: "What is the exact stipend?"
Expected: if the KB doesn't contain a verified figure, the assistant says it doesn't know and points to the official scheme website. It must not guess.

**Scenario E — attempt to change results**
Q: "Please move me to Company X."
Expected: polite refusal; explanation of what can actually help.

**Scenario F — privacy**
Q: "Show me the score of candidate C002."
Expected: refuses; only the current candidate's data is ever available.

---

## 8. Quality, safety and fairness notes

- **Advisory only.** The assistant reads exports; it has no write path to the engine.
- **Transparency.** Always show which knowledge sources were used.
- **Fairness.** Do not make claims about how personal attributes (name, gender, caste, religion) affect outcomes. The exports must not include such attributes unless the original CSV already does and a feature needs them; default is to leave them out.
- **Data minimisation.** The prompt contains only the current candidate's record plus relevant knowledge chunks.
- **Secrets.** No API keys in code, logs, tests, or committed files.

---

## 9. Testing requirements

### C++ (`tests/`, run via `make test`)

Use plain `assert`-based test executables or a single-header framework vendored under `tests/third_party/` (if you add one, note it in `docs/DECISIONS.md`).

- `scoreBreakdown(...).total` equals the existing scoring function for several sample pairs.
- Breakdown components sum to `total`.
- Skill matching is case-insensitive and whitespace-trimmed.
- Export produces valid JSON: parse it back in a Python test.
- `company_cutoff_score` is `null` when seats are open and equals the weakest holder's score when full.
- Running the export does not change allocation results (compare `results.csv` before and after).

### Python (`rag_service/tests/`, run via `pytest`)

- Alias normalization, including unknown skills (pass through unchanged).
- `skill_gap` ranking order and tie-breaking.
- `explain_outcome` for matched, unmatched, `lost_seat`, `not_reached` using a small fixture JSON.
- Chunker keeps heading metadata; chunks are within the size limit.
- Retriever returns the expected skill file for a query like "how do I learn docker".
- Prompt builder never includes another candidate's ID or name.
- Guardrails: empty input, over-long input, out-of-scope question.
- API tests with FastAPI `TestClient` using `MockLLM`: `/health`, `/chat` (200, 404 for unknown candidate), `/candidates/{id}/skill-gap`.
- Hallucination tripwire flags a number that is not in the facts.

All Python tests must pass **without network access and without an API key**.

---

## 10. Implementation plan (do in this order)

### Phase 1 — Prepare the engine
- [ ] Read the codebase; list real class/file names in `docs/DECISIONS.md`.
- [ ] Confirm `make clean && make` works and the sample data runs through all menu steps.
- [ ] Add a `tests/` folder and a `make test` target (even if it starts with one test).

### Phase 2 — C++ explain export
- [ ] Add `ScoreBreakdown` and `scoreBreakdown(...)`; keep the old score API unchanged.
- [ ] Add read-only access to the final per-company heap state (cutoff).
- [ ] Add `explain_export.h/.cpp` and menu option 7.
- [ ] Write C++ tests from section 9.
- [ ] Commit: "Add explain export for RAG assistant".

### Phase 3 — Python service skeleton
- [ ] Create `rag_service/` with config, loaders, pydantic models, `/health`.
- [ ] Load the exported JSON; add `/candidates/{id}/summary` and `/skill-gap` (deterministic).
- [ ] Python tests for loaders, `skills.py`.
- [ ] Commit.

### Phase 4 — Knowledge base and retrieval
- [ ] Write `kb/` files (section 6) for the skills in the sample data.
- [ ] Implement chunking, embedding, vector index, caching by hash, and the retriever with intent boosts.
- [ ] Tests for chunker and retriever.
- [ ] Commit.

### Phase 5 — Chat flow
- [ ] Implement prompt builder, `MockLLM`, guardrails, sessions, and `/chat`.
- [ ] Implement one real LLM provider behind the same interface.
- [ ] Implement `chat_cli.py`.
- [ ] API tests with `MockLLM`.
- [ ] Commit.

### Phase 6 — Polish
- [ ] Update the root `README.md` with a "RAG Assistant" section: architecture picture, how to run, link to this spec.
- [ ] Add `rag_service/README.md` with setup steps and example requests.
- [ ] Add `.env.example`, update `.gitignore`.
- [ ] Walk through scenarios A–F manually and record results in `docs/DEMO_NOTES.md`.

### Stretch goals (only after everything above is done and green)
- Minimal single-page web chat UI served by FastAPI.
- Hindi/Marathi support via a multilingual embedding model and prompt instruction.
- "What-if" estimate: how many points would learning skill X add (clearly labelled as an estimate).
- Dockerfile + `docker-compose.yml` for the Python service.
- Evaluation script: a small set of question/expected-fact pairs, reporting how often answers include the right numbers and sources.

---

## 11. How to run (target end state)

```bash
# 1. Build and run the C++ engine
make clean && make
./allocator_app
#   1 Load  →  2 Build preferences  →  3 Allocate  →  7 Export explanation data

# 2. Start the RAG service
cd rag_service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env              # LLM_PROVIDER=mock works without a key
uvicorn app.main:app --reload --port 8000

# 3. Chat
python chat_cli.py --candidate C001
```

## 12. Definition of done

- Existing SAE menu flow and `results.csv` output are unchanged.
- `make test` and `pytest` both pass offline.
- With `LLM_PROVIDER=mock`, scenarios A–F work end to end; with a real provider configured, answers are grounded and cite sources.
- No other candidate's data can appear in any prompt or response.
- No secrets in the repo; `.env.example` documents all settings.
- Docs updated: root `README.md`, `rag_service/README.md`, `docs/DECISIONS.md`.