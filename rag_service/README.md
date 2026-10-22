# SAE Candidate Assistant service

The service provides a local browser demo, deterministic candidate summaries
and skill gaps, plus an advisory RAG chat. The browser submits CSV data to the
C++ engine through the local API; allocation logic remains in C++.

## Setup

From the repository root, start the service:

```bash
cd rag_service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --no-access-log --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) for the browser demo. It
loads the checked-in synthetic CSV sample, lets you validate and preview CSVs,
run an allocation, inspect outcomes and the event trace, and load the seeded
Phase 3 scenario report. You can choose your own candidate and company CSV
files from the page. These runs use a temporary export directory and do not
overwrite the saved `exports/` data. The first browser allocation compiles the
C++ runner with `make`; keep the repository's `config/allocation_policy_v2.conf`
available. The service rejects direct non-loopback connections, limits request
sizes and per-route request rates, and is intended for local use. Do not put it
behind a public or shared reverse proxy: proxying can make remote requests
appear to come from loopback. Browser allocation is restricted to synthetic/demo
data by default. Mark an uploaded dataset synthetic only if every row is
fictional. For an authorized local evaluation involving real records, an
operator must explicitly set `SAE_ALLOW_REAL_DATA=1`; this prototype has no
individual candidate login or consent workflow and must not be used as a public
multi-user service.

Admin actions are disabled unless `SAE_ADMIN_TOKEN` contains at least 32
characters. Generate a token with `python -c 'import secrets; print(secrets.token_urlsafe(32))'`
and place it in the untracked `.env` file. The token is checked with a
constant-time comparison and is never returned by `/health`.

The first `/admin/reindex` call loads the configured sentence-transformer
model. If it is not cached locally, model setup needs network access. Use the
token from `.env` in the request header:

```bash
curl -X POST http://127.0.0.1:8000/admin/reindex \
  -H 'X-Admin-Token: YOUR_CONFIGURED_TOKEN'
```

Offline tests use a deterministic local embedder and mocked provider responses.

Build the knowledge index after the service starts using the authenticated
`/admin/reindex` request above.

`LLM_PROVIDER=mock` works without an API key. To use Gemini, set
`LLM_PROVIDER=gemini`, `LLM_MODEL` to an available Gemini model, and
`GEMINI_API_KEY` in the untracked `.env` file. Gemini API usage and free-tier
availability depend on Google's current quota and account terms. The CLI
shows a privacy notice and asks before its first chat request. With Gemini,
the service sends minimized result/skill facts, the user's question, and up to
two recent chat turns to Google's API. The prompt omits candidate name and ID;
in-memory session state is capped at 1,000 sessions, cleared on data reload,
and not written to disk.
Use synthetic data unless you have authorization to process real records.

## Chat

Candidate IDs in the current sample export are numeric strings. For example:

```bash
python chat_cli.py --candidate 1
```

Ask a question, or enter `/summary`, `/gap`, or `/quit`. The CLI prints source
labels and paths below each answer. The API can also be called directly:

```bash
curl -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"candidate_id":"1","message":"Why was I matched here?"}'
```

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Export and index status |
| GET | `/` | Local browser demo |
| GET | `/demo/sample` | Checked-in synthetic CSV sample |
| POST | `/demo/validate` | Validate CSVs with the C++ loader and return previews |
| POST | `/demo/run` | Run the allocator and return results plus trace |
| GET | `/demo/state` | Current allocation result |
| GET | `/demo/scenarios` | Fixed-seed synthetic fairness/sensitivity report |
| POST | `/chat` | Candidate-specific assistant response |
| GET | `/candidates/{id}/summary` | Deterministic allocation explanation |
| GET | `/candidates/{id}/skill-gap?sector=IT` | Deterministic ranked skill gaps |
| POST | `/admin/reload` | Reload C++ exports |
| POST | `/admin/reindex` | Rebuild or load the knowledge index |

`kb/scheme_faq.md` now records dated official PIB/MCA source notes. It
distinguishes the April 2026 update from older 2024 pilot information and
points users to the live portal for current application details. The FAQ is a
short source summary, not a complete rulebook; unknown or stale policy facts
must be checked on the official portal.

## Tests

From this directory, run `python -m pytest`. Tests use temporary export files,
local embeddings, and mocked provider responses; they do not need network access
or an API key.
