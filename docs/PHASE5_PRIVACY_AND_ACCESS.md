# Phase 5: privacy and access boundary

## Network boundary

- The FastAPI app accepts direct connections only when the peer IP is loopback.
- Admin reload and reindex endpoints are disabled unless `SAE_ADMIN_TOKEN` is
  configured with at least 32 characters. Requests use the
  `X-Admin-Token` header and a constant-time comparison.
- Per-process rate limits are 20 chat requests/minute, 12 validation or
  allocation requests/minute, 5 admin requests/minute, and 120/minute for
  other paths. JSON bodies over 2,100,000 bytes are rejected.
- In-memory chat state is capped at 1,000 candidate/session pairs, with a
  maximum of `MAX_HISTORY_TURNS` retained turns for each pair.
- Do not expose this prototype through a public or shared reverse proxy. A
  proxy can make remote clients appear to be a loopback peer; production use
  needs authenticated users, trusted proxy handling, durable rate limits, and
  an explicit deployment security review.

## Candidate data and Gemini

- Candidate name and identifier are omitted from the model prompt. The prompt
  still contains profile skills/sector, allocation status and scores, ranked
  company choices, the question, and up to two previous turns by default.
- Chat history stays in process memory, is bounded by `MAX_HISTORY_TURNS`, and
  is cleared on data reload or a new browser allocation. It is not persisted
  to disk. Request bodies and prompts are not logged.
- In mock mode, chat is local. In Gemini mode, minimized prompt contents are
  sent to Google's Gemini API. The CLI asks the operator before its first chat
  call; direct API users must read `/health` and obtain their own authorization
  before enabling Gemini for real records.
- The live Gemini smoke script only sends a fixed test prompt and requires
  `SAE_LIVE_GEMINI=1`. It does not include candidate data and was not run as
  part of implementation.
- CSV exports and browser datasets can still contain personal data. Use
  synthetic records for demonstrations. Allocation of non-synthetic browser
  uploads is disabled by default; the operator must explicitly set
  `SAE_ALLOW_REAL_DATA=1` for an authorized local evaluation. Uploaded CSVs
  and exports are held in a temporary directory while that run is active and
  removed on the next run, an admin reload, or process shutdown. Do not treat
  a candidate ID as authentication.

## Source and answer boundary

- `kb/scheme_faq.md` contains source titles, dates, direct links, and a check
  date for the verified official facts included in it.
- The FAQ distinguishes the April 2026 MCA update from historical 2024 pilot
  notes. It directs users to the live scheme portal for current round details.
- The assistant is advisory, cannot alter allocations, and receives only one
  selected candidate's result facts. If its output contains a numeric token
  absent from those facts and retrieved passages, the API replaces the answer
  with a verification message.
- Sources are returned as knowledge labels and titles. This grounding reduces
  unsupported answers but does not guarantee semantic correctness; check the
  official source for decisions and current scheme terms.
