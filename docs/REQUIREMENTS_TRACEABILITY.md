# SIH25033 Requirements Traceability — Phase 0 Draft

This is a working map between the SIH25033 statement and the repository as it
exists at Phase 0. “Current” describes implemented behavior; “planned” is not
yet a feature claim. No official eligibility, reservation, or past-participation
rule is assumed here.

| SIH criterion | Current coverage | Current source/behavior | Gap and proposed treatment | Verification / evidence |
|---|---|---|---|---|
| Match candidates to internship opportunities | Implemented as prototype | `src/allocator.cpp`; supports explicit ordered acceptable-company lists and legacy score-ranked choices | Keep C++ as authoritative allocator; later add SIH-specific eligibility only from verified rules | Hand-worked allocations; assignments respect capacity and declared acceptable lists |
| Candidate skills | Partial | `Candidate.skills`; company `requiredSkills`; case/space-normalized overlap contributes 50% | Normalize skills consistently during ingestion; separate minimum eligibility from score contribution only when a policy is defined | Exact, case, whitespace, duplicate, empty-skill cases |
| Qualifications | Partial proxy only | `cgpa` contributes 30% of score; no degree/field requirement | Add explicit qualification fields/rules; confirm whether GPA is qualification, ranking signal, or both | Field validation; tests distinguish hard rejection from soft score |
| Location preferences | Partial proxy only | Candidate and company each have one `location`; exact equality adds 10% | Represent candidate acceptable/ranked locations; distinguish preference from mandatory constraint | Same city, multiple cities, remote/relocation cases |
| Sector interests | Partial proxy only | Candidate and company each have one `sector`; exact equality adds 10% | Represent candidate interest/ranking explicitly; decide if company sector is a hard constraint or a score signal | Matching and nonmatching sector scenarios |
| Affirmative action (rural/aspirational districts, social categories) | Not implemented | No such attributes or allocation policy in current schema | Do not add live allocation rule until authoritative policy, purpose, data permission, and safeguards are established; first model aggregate synthetic scenarios | Approved policy source; aggregate-only fairness scenarios and privacy review |
| Past participation | Not implemented | No participation field or rule | Add only after confirming the official rule and how repeat participation is treated | Verified rule and cases for first-time/previous participation |
| Internship capacity | Implemented | `Company.seats`; `Company::heldSeats`; open seats filled up to capacity | Preserve invariant and expose capacity utilization/trace in output | No company exceeds seats; open seat remains open when no eligible proposer |
| AI/ML-based matchmaking engine | Matching algorithm exists; no trained ML model | Deterministic weighted score + deferred-acceptance-style queue/heap allocation | Describe accurately as algorithmic matching; do not train from synthetic labels. Revisit ML only with authorized, meaningful historical labels | Algorithm specification, repeatability, comparative evaluation |
| Functional prototype | Implemented as CLI + API prototype | C++ CLI, FastAPI, terminal chat, JSON exports | Add browser frontend with validation, run, result, and algorithm-trace views | End-to-end browser demonstration |
| Explainability | Partial and useful foundation | Score components, matched/missing skills, rank/outcome/cutoff, reason codes, policy/algorithm label, and allocation trace in schema v2 JSON; RAG summaries/chat | Add richer rule-specific eligibility explanations when official rules are established; keep LLM advisory | Explanations reconcile with exported engine facts and trace |
| Scale and performance | Not measured for representative scale | Dense candidate-company score calculation; caches pair scores | Add fixed-seed generator, operation counts, benchmark; compare sparse/dense representation | Reproducible benchmark table with input sizes and machine notes |
| Official PMIS rules and real data | Not verified/connected | Scheme FAQ remains explicitly unverified; sample data is local demo data | Verify each policy fact from official sources before encoding or presenting as real scheme behavior | Source link, verification date, and documented rule owner |

## Prototype boundaries

- Current sample records are demonstration data, not a verified PM Internship
  Scheme applicant or employer dataset.
- The score is not a probability of success and the weighted score alone is
  not evidence of fairness.
- The current allocator's stability claim must be bounded to the preference
  model actually supplied. Candidate rankings are score-based; the code does
  not load separate company-authored rankings or explicit eligibility lists.
- No SIH criterion should be marked complete merely because a similarly named
  CSV column exists. The rule, effect, explanation, and verification evidence
  must also be clear.

