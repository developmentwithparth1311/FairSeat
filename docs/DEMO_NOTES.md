# SAE Candidate Assistant demo notes

Acceptance scenarios were walked through with the local fixture exports and
the deterministic mock provider. These checks do not call a hosted LLM.

## A. Unmatched candidate

Fixture candidate `C001` is unmatched. The first lost-seat example contains
score `74.3`, final cutoff `76.1`, and exported-data gap `1.8`. The mock answer
uses those values and suggests a skill-gap follow-up. Covered by
`test_chat_advisory_privacy_scope_and_debug`.

## B. Matched below the first choice

The matched fixture is placed at preference rank 2. The rank 1 company is
marked `lost_seat`; the mock explains its score, final cutoff, and points short
from the exported outcome facts. Covered by
`test_mock_explains_matched_candidate_missing_first_choice`.

## C. Skill guidance

The deterministic skill-gap endpoint ranks missing skills by company frequency
and alphabetically breaks ties. Retrieval tests find the Docker guide in an
isolated fixture, and the mock answer includes its beginner steps and `[KB-1]`
citation. Docker is only a test fixture skill; the committed skill guides are
limited to skills found in `data/companies.csv`. The API-level guide test
verifies missing-skill hints are added to retrieval and the guide source path
is returned.

## D. Verified policy fact and unknown policy detail

When an official FAQ chunk is retrieved, the mock cites its `[KB-N]` label and
uses only the dated 2026 notice facts. When no verified passage is available,
the mock says it does not know and points to the official portal. The current
FAQ and source metadata are in `kb/scheme_faq.md`; the source-backed behavior
is covered by `test_mock_cites_verified_policy_fact`.

## E. Request to change allocation

The mock refuses to change the allocation and directs the candidate to improve
their profile or use official profile-update channels. Covered by
`test_chat_advisory_privacy_scope_and_debug`.

## F. Request for another candidate's data

The API refuses a request naming another candidate before prompt creation. A
separate prompt test adds a second candidate to the fixture and verifies that
their ID and name are absent from the selected candidate's prompt. Covered by
`test_prompt_contains_only_selected_candidate` and
`test_chat_advisory_privacy_scope_and_debug`.

Admin routes reject missing/incorrect tokens, remote peers are blocked, and
non-synthetic browser allocations are disabled by default. These safeguards
are covered by `test_admin_routes_require_a_long_token`,
`test_non_loopback_peer_is_blocked`, and
`test_real_candidate_allocation_is_off_by_default`.

## Current limit

The mock provider is deterministic and intentionally simple. The optional
Gemini provider is covered with mocked HTTP responses, not a live account.
The official source summary was checked on 2026-10-22, but it is not a complete
rulebook and current round details must be checked on the live portal. The live
Gemini smoke check is opt-in and was not run.
