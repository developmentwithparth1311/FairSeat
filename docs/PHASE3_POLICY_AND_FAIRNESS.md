# Phase 3 — Policy Controls and Synthetic Fairness Diagnostics

## Policy configuration

The CLI loads `config/allocation_policy_v2.conf`. The file selects the policy
version, algorithm, tie-break rule, company-capacity rule, four score weights,
and optional qualification, location, sector, and past-participation
requirements. The parser rejects unknown keys, unsupported settings, invalid
weights, and weights that do not sum to 1.0.

The checked-in configuration preserves the Phase 1 weights and disables every
new hard requirement. Profile fields can therefore be present without
changing default allocations. Explicit candidate company preferences still
control order and remain the acceptable set; enabled policy requirements can
filter those edges. Score-ranked legacy candidates are ranked among the
companies that pass the enabled requirements.

The qualification simulation uses exact label inclusion: every qualification
required by an opportunity must appear on the candidate. Location and sector
simulations use exact text labels and only constrain candidates who supplied a
non-empty corresponding preference list. The prior-participation simulation
excludes candidates explicitly marked `true`; missing values are treated as
unknown and are not excluded. These deliberately simple controls are not
official PMIS rules.

Candidate CSV accepts the original six-column format, the Phase 1 seven-column
format, and an extended eleven-column format. Company CSV accepts the original
six-column format and an extended seven-column format. The extended fields are
optional. The prior-participation value is not written to per-candidate JSON,
prompts, or logs.

## Reproducible scenario runner

Run `make phase3-report`. The C++ runner uses `std::mt19937` with default seed
25033 to generate 400 synthetic candidates and 24 synthetic opportunities.
It prints CSV rows for baseline, skill-weight sensitivity, exact-label
qualification filtering, preferred-location filtering, and prior-participation
exclusion. Pass candidate count, company count, and seed to
`./tools/phase3_scenarios N M SEED` for another repeatable workload.

The `synthetic_group_A` and `synthetic_group_B` labels are assigned by
candidate ID parity and held in the report tool only. They are not candidate
attributes, protected groups, or a proxy for real people. They exist to show
how aggregate rates and assignment changes can be reported without putting
demographic fields into live allocator records.

## Recorded default run

| Scenario | Group A allocation | Group B allocation | Assignment changes vs baseline | Eligible rate per group | Seats filled |
|---|---:|---:|---:|---:|---:|
| Baseline | 63.5% | 56.5% | 0 | 100% | 240 / 240 |
| Skills emphasis | 61.5% | 58.5% | 53 | 100% | 240 / 240 |
| Qualification filter | 61.5% | 58.5% | 202 | 100% | 240 / 240 |
| Location filter | 64.0% | 56.0% | 139 | 100% | 240 / 240 |
| Prior-participation exclusion | 62.0% | 58.0% | 126 | 80% | 240 / 240 |

The baseline allocation-rate difference is 7 percentage points in this
synthetic workload. Weight and requirement changes redistribute assignments;
they do not create a generally fairer or better policy. In particular,
qualification and prior-participation filtering are only what-if demonstrations
and must not be used on scheme data without verified rules and authorization.
The generated cohort size is too small and too artificial to establish
statistical or legal fairness. These metrics are diagnostics, not proof of
fairness, causality, or policy compliance.

The runner reports eligible/allocation rates, unmatched counts, average
assigned score, total seats and utilization, location/sector coverage, and the
number of candidate assignments that changed from baseline. Because company
capacities sum to 240 in the default workload, all scenarios fill all seats;
that outcome is a property of this synthetic setup, not a claim about real
allocation demand.

## Policy facts still awaiting official confirmation

- Qualification taxonomies, accepted credentials, and hard qualification
  thresholds.
- Whether candidate locations and sector interests are preferences or hard
  constraints; remote, hybrid, and relocation semantics.
- Whether prior participation affects eligibility or allocation, where that
  status may be obtained, and who may process it.
- Any affirmative-action or geographic representation rules, their source,
  implementation, governance, and data authorization.

Until these are verified, the shipped policy keeps the corresponding rules
disabled and the project makes no claim of full SIH/PMIS policy coverage.
