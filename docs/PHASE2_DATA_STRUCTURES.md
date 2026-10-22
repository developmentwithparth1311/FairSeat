# Phase 2 — Data Structures Lab

## Implemented model

The allocator now materializes a `PreferenceGraph`. Candidate and company
vertices have sorted ID lists; candidate adjacency stores each candidate's
acceptable companies in proposal order, and reverse company adjacency lists
the candidates connected to each company. An edge means “acceptable to this
candidate under the supplied Phase 1 preference contract.” It is not a claim
that SIH or an official scheme has a verified hard-eligibility rule.

Deferred acceptance traverses candidate adjacency directly. Existing trace
events record proposals, accepted proposals, rejections, displacements,
unmatched outcomes, and a final completion event per candidate. Export schema
2 now includes graph counts/density and counters for score work, preference
sorting, queue operations, proposals, company-rank comparisons, seat-heap
pushes/pops, displacements, and rejections.

## Data-structure invariants and costs

Let `n` be candidates, `m` companies, `E` acceptable candidate-company edges,
`d_i` candidate `i`'s degree, and `k_j` company `j`'s capacity.

| Structure | Invariant / use | Cost in this implementation |
|---|---|---|
| ID hash maps | IDs resolve to one candidate/company record | Average O(1) lookup; worst O(n) or O(m) |
| Bipartite adjacency lists | Every listed edge is an acceptable pair; adjacency order is candidate proposal order | O(n + m + E) stored graph data and O(E) graph construction/traversal |
| Candidate proposal queue | Each queued candidate is currently unmatched and has another edge to try, except initial entries | O(1) amortized push/pop; at most O(E + n) queue operations |
| Per-company min-heap | Contains exactly the current holders; root is weakest by score, then largest candidate ID | O(1) weakest lookup; O(log k_j) insert/remove |
| Preference vectors | Strictly ordered by submitted rank, or by score descending then company ID | O(d_i log d_i) when generated from scores; explicit lists avoid sorting |
| Score cache | Reuses scores already computed by ranking/allocation | Average O(1) lookup; memory up to O(E) for sparse explicit lists or O(nm) for legacy full rankings |

Each acceptable edge can receive at most one proposal, so there are at most
`E` proposals. Heap-based allocation therefore has O(E log K) worst-case
seat-update work, where `K = max(k_j)`, plus queue work and score lookups.
Legacy score-ranked input computes all `nm` scores and sorts each candidate's
`m` companies, giving O(nm + n m log m) ranking work. Explicit acceptable
lists avoid scores for unlisted pairs and use O(E) graph storage. Validation
and blocking-pair checks add O(E) traversal plus the implementation's
candidate-rank searches (up to O(E) total).

## Reproducible comparison

Run `make benchmark` for the default synthetic workload, or
`./benchmarks/allocator_benchmark CANDIDATES COMPANIES DENSITY SEED` after
building the target. The generator uses `std::mt19937` and the provided seed;
it emits CSV to stdout. Dense and sparse score-storage construction are timed
separately. The dense representation stores a score for every pair; the sparse
representation stores candidate ID, company ID, and score only for acceptable
edges. The benchmark also runs heap deferred acceptance, a linear scan of
current company holders, and a fixed candidate-ID greedy assignment. It exits
with an error if the heap and linear deferred-acceptance assignments differ.

### Recorded run

Environment: macOS arm64, Apple Clang 21 `g++`, C++17, `-O2`; one run of the
default workload (1000 candidates, 50 companies, nominal edge probability
0.25, seed 42), recorded during Phase 6 on 2026-10-22. Wall-clock measurements
are illustrative and will vary by machine.

| Measurement | Result |
|---|---:|
| Actual acceptable edges / density | 12,315 / 24.63% |
| Dense score payload / build time | 400,000 bytes / 15.60 ms |
| Sparse edge payload / build time | 197,040 bytes / 4.20 ms |
| Heap deferred acceptance | 5,418 proposals; 1,182 heap pushes; 532 heap pops; 650 matches; 3.17 ms |
| Linear-scan deferred acceptance | 61,984 holder comparisons; 650 matches; 1.94 ms |
| Greedy baseline | 650 matches; total score 45,733.98 |
| Deferred acceptance total score | 51,792.22 |

The heap and linear implementations returned identical assignments. At this
small capacity distribution, the linear version was faster in this single run
despite doing many more holder comparisons; this is why the report retains
operation counts and treats time as machine-dependent. Dense and sparse payload
figures are representation payload estimates, not process RSS. The sparse
record includes two integer indices and a score, so sparse storage has more
bytes per stored edge and becomes beneficial when edge density is low enough.
Greedy happened to fill the same number of seats here but achieved a lower
total score; that score comparison is descriptive and does not establish
fairness, optimality, or a universal outcome.

## Limits

The benchmark's greedy method processes candidates by ascending ID and gives
each the first available acceptable choice. It is a teaching baseline, not a
policy recommendation. The “dense vs sparse” comparison measures payload
construction, not a production allocator with a switchable backing store.
The existing allocator uses sparse adjacency and an on-demand score cache;
there is no max-weight solver in Phase 2. The counters count allocator-level
operations, including challenger-versus-weakest company comparisons; they do
not attempt to expose each internal comparator invocation performed by the
standard library priority queue.
