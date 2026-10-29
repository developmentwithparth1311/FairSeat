# Privacy and access boundary

## Local access and request limits

- The FastAPI service accepts direct connections from loopback addresses only.
- CORS permits local `localhost` and `127.0.0.1` origins. Do not expose the
  service through a public or shared reverse proxy.
- Request bodies larger than 2,100,000 bytes are rejected, including chunked
  bodies.
- In-process rate limits are 20 chat requests/minute, 12 CSV validation or
  allocation requests/minute, 5 admin requests/minute, and 120 other
  requests/minute. These are prototype safeguards, not distributed controls.
- Browser allocation is restricted to synthetic data unless an authorized
  local operator explicitly enables `SAE_ALLOW_REAL_DATA=1`.

## Authentication and account data

- Candidate and allocator sign-in use one-hour HS256 JWTs. Candidate routes
  map the token to a server-side candidate ID, so the browser cannot choose a
  different candidate record. Allocator routes require the separate `admin`
  role.
- Accounts and salted PBKDF2 password hashes are stored in the local SQLite
  database at `rag_service/.data/accounts.sqlite3` by default. The signing key
  is generated with private file permissions and stored at
  `rag_service/.data/jwt_signing.key`. Both paths are configurable, and the
  `.data` directory is ignored by Git.
- Demo candidate accounts and an allocator account are seeded once for the
  checked-in sample data. Their initial credentials are listed in
  `rag_service/README.md`; change them before a presentation on a shared
  machine. Allocators can add candidate accounts, reset passwords, and disable
  accounts. Candidates and allocators can change their own passwords.
- Password changes, resets, and deactivation increment an account token
  version, invalidating earlier JWTs. Accounts are local demo identities;
  there is no public registration, email verification, self-service recovery,
  or production identity management.

## Candidate data and assistant processing

- Candidate result and chat routes only return the signed-in candidate's data;
  an allocator role is required to inspect other candidate records.
- Chat history remains in process memory, is capped at 1,000 candidate/session
  pairs, and retains at most `MAX_HISTORY_TURNS` (2 by default). It clears
  when the active allocation reloads and is not written to disk.
- The offline feature-hashing index is built locally at startup. Optional
  Sentence Transformer reindexing uses the configured model and may require a
  cached model or network access.
- In mock mode, chat runs locally. Gemini mode sends minimized allocation and
  skill facts, the question, retrieved passages, and a limited chat history to
  Google's API. The candidate page asks for consent before the first external
  chat request in that browser session. Obtain authorization before processing
  real records with Gemini.
- The assistant is advisory, cannot change allocations, and filters unverified
  numeric claims. Retrieved sources improve traceability but do not guarantee
  correctness; check the official source for current scheme decisions.
- Demo uploads and their generated exports live in temporary directories and
  are removed after a later run, an admin reload, or service shutdown. They do
  not replace the checked-in exports.

`rag_service/.env` may contain a Gemini key or configured JWT secret and is
ignored by Git. Never include secrets in reports or shared project material.
