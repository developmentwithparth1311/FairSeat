# SAE Candidate Assistant service

The service provides a local browser demo, role-specific sign-in, persistent
candidate profiles and ranked preferences, deterministic candidate summaries
and skill gaps, plus an advisory RAG chat. Candidate profile and preference
edits are saved in SQLite. Allocation logic remains in C++.

## Setup

From the repository root, start the service:

```bash
cd rag_service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
test -f .env || cp .env.example .env
uvicorn app.main:app --reload --no-access-log --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) for the browser demo. Choose
Candidate or Admin at sign-in. Candidate profiles and opportunities are seeded
from the checked-in CSV files once into `rag_service/.data/sae.sqlite3`; profile
and preference edits persist across service restarts. A fresh database starts
with no published allocation, regardless of older JSON exports in `exports/`.
The existing admin demo can validate and run CSV allocations and inspect the
trace and scenario report. Those legacy demo runs remain session-only until
the persistent allocation workflow is completed. Keep the repository's
`config/allocation_policy_v2.conf` available.

The service accepts direct loopback connections only and limits request sizes
and per-route request rates. Keep it local; do not put it behind a public or
shared reverse proxy, which can make remote requests appear to come from
loopback. Browser allocation is restricted to synthetic/demo data by default.
Mark an uploaded dataset synthetic only if every row is fictional. For an
authorized local evaluation involving real records, an operator must
explicitly set `SAE_ALLOW_REAL_DATA=1`. Candidate and allocator accounts are
stored in a local SQLite file under `rag_service/.data/`. The service supports
candidate password changes, allocator-created candidate accounts, password
resets, and account deactivation. The seeded accounts are fictional and for
presentation only; there is no public registration or production deployment
model.

Three candidate accounts are seeded for the sample allocation:

| Demo profile | Email | Password |
|---|---|---|
| Vivek Reddy | `vivek.reddy@sae.demo` | `DemoPass123!` |
| Swati Chatterjee | `swati.chatterjee@sae.demo` | `DemoPass123!` |
| Rahul Menon | `rahul.menon@sae.demo` | `DemoPass123!` |
| Allocator | `admin@sae.demo` | `AdminPass123!` |

Accounts use salted PBKDF2 password hashes. The service issues one-hour HS256
JWTs for candidate and allocator roles. Candidate result/chat requests resolve
the account to its candidate ID on the server. Password changes, resets, and
deactivation revoke existing tokens. A signing key is generated and saved with
private file permissions on first launch, so tokens remain verifiable across
restarts. You can also supply a 32-byte-or-longer `JWT_SECRET_KEY` in the
untracked `.env`. These local demo accounts are not a production identity
system.

Allocator pages and run-management APIs require the allocator JWT. The initial
allocator account is seeded on first start; change its password after signing
in. Candidate account creation and password resets are available from the
allocator workbench.

For a presentation, use `DemoPass123!` with one of the candidate accounts, or
sign in as the allocator with `admin@sae.demo` / `AdminPass123!`. Change these
initial passwords before using the demo on a shared machine. Accounts and the
generated JWT signing key persist under `.data/` across service restarts.

The service builds an offline local feature-hashing knowledge index on startup.
It can answer from the Markdown knowledge base without downloading a model.
For a semantic index, an allocator can call `/admin/reindex`; the configured
Sentence Transformer model must be available locally or downloaded first.

```bash
curl -X POST http://127.0.0.1:8000/admin/reindex \
  -H 'Authorization: Bearer YOUR_ALLOCATOR_JWT'
```

Offline tests use a deterministic local embedder and mocked provider responses.

The local index is ready automatically. `/admin/reindex` is optional and
switches to the configured semantic embedding model when available.

`LLM_PROVIDER=mock` works without an API key. For Gemini, set
`LLM_PROVIDER=gemini`, `LLM_MODEL` to an available Gemini model, and
`GEMINI_API_KEY` in the untracked `.env` file. For Groq, set
`LLM_PROVIDER=groq`, `LLM_MODEL` to a model enabled for your account, and
`GROQ_API_KEY` there. The provider key remains on the server; do not add it to
the frontend. The candidate portal shows the active provider and requests
consent before the first external chat request in a session. External requests
include minimized result/skill facts, the user's question, and up to two recent
chat turns. The prompt omits candidate name and ID; in-memory session state is
capped at 1,000 sessions, cleared on data reload, and not written to disk.

After setting a provider, restart the service. To make an explicit live test
using a fixed prompt with no candidate data, run `SAE_LIVE_LLM=1 python
smoke_llm.py` from `rag_service/`.
Use synthetic data unless you have authorization to process real records.

## Chat

Candidate IDs in the current sample export are numeric strings. For example:

```bash
python chat_cli.py --candidate 1
```

Ask a question, or enter `/summary`, `/gap`, or `/quit`. The CLI prints source
labels and paths below each answer. The API can also be called directly after
candidate sign-in:

```bash
TOKEN=$(curl -s http://127.0.0.1:8000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"vivek.reddy@sae.demo","password":"DemoPass123!","role":"candidate"}' \
  | python -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
curl -X POST http://127.0.0.1:8000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"candidate_id":"1","message":"Why was I matched here?"}'
```

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Export and index status |
| GET | `/` | Local browser demo |
| GET | `/auth/demo-profiles` | Active fictional candidate profiles for the sign-in screen |
| POST | `/auth/login` | Sign in and receive a short-lived JWT |
| POST | `/auth/password` | Change password and revoke earlier tokens |
| GET | `/auth/me` | Signed-in candidate or allocator profile |
| GET | `/me/profile` | Signed-in candidate profile, preferences, opportunities, and allocation status |
| PUT | `/me/profile` | Save the signed-in candidate's editable profile fields |
| PUT | `/me/preferences` | Save the signed-in candidate's ranked opportunity preferences |
| GET | `/me/result` | Signed-in candidate's current allocation state and result when available |
| POST | `/me/chat` | Signed-in candidate's result-aware assistant chat |
| GET | `/admin/dashboard` | Saved profile counts, current run summary, and recent run history |
| GET | `/admin/candidates` | Candidate records, preferences, and current outcomes |
| GET/PUT | `/admin/opportunities` | Read and update saved opportunity requirements and capacity |
| POST | `/admin/allocations/run` | Run the C++ allocator from saved profiles/preferences and publish atomically |
| POST | `/admin/allocations/reset` | Clear the current run while preserving candidate inputs and run history |
| GET | `/admin/allocations/current` | Read the current persisted allocation snapshot |
| GET | `/admin/allocations/history` | Read recent published runs |
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
| GET | `/admin/accounts` | List local candidate and allocator accounts |
| POST | `/admin/accounts` | Create a candidate account tied to the current allocation |
| POST | `/admin/accounts/{email}/reset-password` | Reset a candidate password |
| POST | `/admin/accounts/{email}/status` | Activate/deactivate a candidate account |

The browser portal starts with no current allocation. Candidate profile and
preference changes are saved immediately to SQLite and mark the existing run
stale. The administrator must run allocation again to publish results based on
the new inputs. Candidate pages poll the service and update allocation status
after a new run or reset. Initial accounts and passwords are for local
demonstration only; change them before presenting on a shared machine.

`kb/scheme_faq.md` now records dated official PIB/MCA source notes. It
distinguishes the April 2026 update from older 2024 pilot information and
points users to the live portal for current application details. The FAQ is a
short source summary, not a complete rulebook; unknown or stale policy facts
must be checked on the official portal.

## Tests

From this directory, run `python -m pytest`. Tests use temporary export files,
local embeddings, and mocked provider responses; they do not need network access
or an API key.
