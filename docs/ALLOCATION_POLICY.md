# Allocation Policy — Prototype Version 2

This document defines the deterministic allocation policy implemented for the
prototype. It is an academic/demo policy, not a claim that it matches
official PM Internship Scheme rules. SIH/PMIS-specific eligibility or
affirmative-action rules must be verified from authoritative sources before
they are introduced.

## Inputs and compatibility

- Legacy candidate CSV header:
  `id,name,skills,cgpa,sector,location`
- Candidate CSV with explicit preferences:
  `id,name,skills,cgpa,sector,location,preferred_company_ids`
- Extended candidate CSV:
  `id,name,skills,cgpa,sector,location,preferred_company_ids,qualifications,preferred_locations,sector_interests,prior_participation`
- `preferred_company_ids` is a semicolon-separated ordered list of company
  IDs, such as `101;104;113`. The list is both the candidate's preference
  order and the set of opportunities they are willing to accept in this demo.
- An empty value in the explicit column means the candidate has no acceptable
  opportunities. A legacy file without the column retains prior behavior and
  ranks every company by computed score.
- Legacy company CSV:
  `id,name,required_skills,seats,sector,location`
- Extended company CSV appends `required_qualifications`.
- The basic CSV parser supports quoted commas and escaped quotes within a
  single line. Multiline quoted fields are not supported.

The explicit list is a prototype representation of candidate preferences. It
is not a substitute for official scheme eligibility. Optional profile fields
are supported, but the checked-in policy does not enable qualification,
location, sector, or past-participation exclusion rules. The prior participation
value is not included in individual JSON exports.

## Versioned policy configuration

The CLI loads `config/allocation_policy_v2.conf`. It records the policy
version, algorithm, supported tie-break and capacity rules, score weights, and
optional hard requirements. Weights must be non-negative and sum to 1.0.
Unknown keys or unsupported rule names fail validation. The shipped values
preserve the previous score weights and leave the optional hard rules off.

The prototype's opt-in qualification rule requires every company label to
appear exactly in a candidate's qualification list. Location and sector rules
require a company label to appear in the corresponding non-empty preference
list; an empty list is treated as unspecified. These simple rules are only
synthetic demonstration controls, not official scheme interpretation.

## Ranking rules

### Candidate order

- With `preferred_company_ids`, use the submitted order exactly.
- Without that column, order all companies by score descending, then company
  ID ascending.

### Company order

Companies rank candidates by the current fit score descending. For equal
scores, lower candidate ID ranks higher. The min-heap stores the weakest
current holder at its top, so a challenger can replace that holder if they
have a higher score or the same score and a lower candidate ID.

## Fit score

The score remains a transparent soft ranking signal on a 0–100 scale:

| Component | Weight |
|---|---:|
| Skill overlap | 50% |
| CGPA normalized to 0–10 | 30% |
| Exact sector match | 10% |
| Exact location match | 10% |

The weights are configuration values rather than constants in scoring code.
When a candidate supplies `preferred_locations` or `sector_interests`, those
lists drive the corresponding soft match; otherwise the legacy single-value
`location` or `sector` is used.

In this prototype, `required_skills` contributes to fit; missing skills do not
make a candidate ineligible. A later policy may distinguish mandatory from
preferred skills after the requirement is verified. CGPA is constrained to
the documented 0–10 range at load time, but no minimum CGPA eligibility cutoff
is imposed.

## Allocation algorithm

Candidate-proposing deferred acceptance:

1. Put candidates into the proposal queue in ascending candidate-ID order.
2. An unmatched candidate proposes to their next acceptable company.
3. A company accepts if a seat is open.
4. If full, the company keeps its higher-ranked candidates up to capacity. A
   displaced candidate returns to the queue and continues at their next
   preference.
5. A candidate with no edges after enabled requirements is unmatched with
   reason `no_eligible_opportunities`; a candidate with an empty acceptable
   list is unmatched with reason `no_acceptable_opportunities`; a candidate
   rejected by all listed opportunities is unmatched with reason
   `all_acceptable_opportunities_rejected`.

The algorithm is stable relative to the strict rankings above: there should be
no candidate-company pair where the candidate prefers that company to their
final assignment and the company prefers that candidate to one of its final
holders (or has an open seat). It does not guarantee maximum total score,
maximum seat utilization, policy fairness, or real-world validity of the
prototype's score weights.

## Validation and audit output

Input loading rejects malformed row lengths, unexpected headers, invalid or
duplicate IDs, invalid preference references, duplicate preferences, CGPA
outside 0–10, and non-positive seat capacity. A successful allocation checks:

- no candidate occupies more than one seat;
- no company's capacity is exceeded;
- each assignment appears in the candidate's acceptable list;
- candidate/company match state agrees;
- no blocking pair exists under the declared rankings.

Schema version 3 exports include policy/algorithm labels, active rules and
weights, the optional qualifications/location/sector preference fields,
reason codes, and a deterministic allocation trace. Prior participation is
never exported per candidate. Schema versions 1 and 2 remain accepted by the
Python service for older saved exports.

