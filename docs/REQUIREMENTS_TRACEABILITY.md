# SIH25033 Requirements Traceability — Current Prototype

This map records current behavior and evidence. It does not claim official
eligibility, reservation, or past-participation rules unless supported by the
dated sources in `kb/scheme_faq.md`.

| SIH criterion | Current coverage | Current source/behavior | Gap and proposed treatment | Verification / evidence |
|---|---|---|---|---|
| Match candidates to internship opportunities | Implemented as prototype | `src/allocator.cpp`; supports explicit ordered acceptable-company lists and legacy score-ranked choices | Keep C++ as authoritative allocator; later add SIH-specific eligibility only from verified rules | Hand-worked allocations; assignments respect capacity and declared acceptable lists |
| Candidate skills | Partial | `Candidate.skills`; company `requiredSkills`; case/space-normalized overlap contributes the configured default 50% | Keep required skill as soft fit unless a verified rule defines a hard requirement | Exact, case, whitespace, duplicate, empty-skill cases |
| Qualifications | Prototype field and opt-in exact-label filter | Candidate `qualifications`; opportunity `required_qualifications`; policy `all_required` is disabled by default; CGPA remains a ranking signal | Verify credential taxonomy and official eligibility semantics before enabling for scheme data | Synthetic exact-label filter test and policy-config validation |
| Location preferences | Prototype field and opt-in filter | `preferred_locations` contributes to the existing location score; policy `preferred_locations` hard filter is disabled by default | Define remote, multiple locations, and mandatory versus preferred semantics from authoritative requirements | Synthetic multiple-location scoring/filter scenario |
| Sector interests | Prototype field and opt-in filter | `sector_interests` contributes to the existing sector score; policy `sector_interests` hard filter is disabled by default | Confirm taxonomy and whether interest may be a hard constraint | Synthetic sector score/filter scenario |
| Affirmative action (rural/aspirational districts, social categories) | Not implemented for live allocation | No protected attributes are stored in candidate records; fairness tool uses synthetic A/B cohort labels held outside allocation records | Do not add live rules until authoritative policy, purpose, data permission, and safeguards are established | Seeded aggregate scenario report; not evidence of real-world fairness |
| Past participation | Optional input field; rule configurable but disabled | `prior_participation` accepts true/false/unknown; is not exported per candidate; synthetic exclusion scenario available | Verify official rule, authoritative data source, and privacy basis before use | CSV validation and seeded synthetic counterfactual scenario |
| Internship capacity | Implemented | `Company.seats`; `Company::heldSeats`; open seats filled up to capacity | Preserve invariant and expose capacity utilization/trace in output | No company exceeds seats; open seat remains open when no eligible proposer |
| AI/ML-based matchmaking engine | Matching algorithm exists; no trained ML model | Deterministic weighted score + deferred-acceptance-style queue/heap allocation | Describe accurately as algorithmic matching; do not train from synthetic labels. Revisit ML only with authorized, meaningful historical labels | Algorithm specification, repeatability, comparative evaluation |
| Functional prototype | Implemented as CLI + local browser prototype | C++ CLI/runner, FastAPI, terminal chat, JSON exports, CSV input, result and trace views | Keep the API/UI contract stable and expand only against verified requirements | Phase 6 fixture passes CSV validation, C++ allocation, JSON loading, API explanation, and frontend asset checks |
| Explainability | Partial and useful foundation | Score components, matched/missing skills, rank/outcome/cutoff, reason codes, policy/algorithm label, active rules, graph/counters, and allocation trace in schema v3 JSON; RAG summaries/chat | Add richer rule-specific eligibility explanations when official rules are established; keep LLM advisory | Explanations reconcile with exported engine facts and trace |
| Scale and performance | Prototype benchmarked on synthetic data | Phase 2 fixed-seed heap/linear and dense/sparse benchmark; Phase 3 seeded policy sensitivity runner | Measure representative authorized datasets before making deployment claims | `make benchmark` and `make phase3-report`; results are machine- and data-dependent |
| Official PMIS rules and real data | Partial source verification; no live portal connection | `kb/scheme_faq.md` summarizes dated official MCA/PIB notices and distinguishes historical pilot facts; sample data remains synthetic | Verify current-round requirements and full eligibility from the live portal before encoding policy or presenting this allocator as scheme behavior | Dated source links, focused mock citation test, and current portal review before any policy update |

## Prototype boundaries

- Current sample records are demonstration data, not a verified PM Internship
  Scheme applicant or employer dataset.
- Current browser runs reject non-synthetic records unless the local operator
  explicitly enables `SAE_ALLOW_REAL_DATA`; the service has no individual
  candidate login, consent workflow, or public deployment security model.
- The score is not a probability of success and the weighted score alone is
  not evidence of fairness.
- The current allocator's stability claim must be bounded to the preference
  model actually supplied. Candidate rankings use submitted company order or
  configured score ranking; company rankings use fit score and the documented
  tie-break. The extended policy filters are exact-label prototype rules and
  remain disabled by default.
- No SIH criterion should be marked complete merely because a similarly named
  CSV column exists. The rule, effect, explanation, and verification evidence
  must also be clear.

