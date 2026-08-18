# Stable Allocation Engine (SAE)

![C++](https://img.shields.io/badge/C%2B%2B-17-00599C?style=for-the-badge&logo=cplusplus&logoColor=white)
![Make](https://img.shields.io/badge/Build-Make-427819?style=for-the-badge&logo=gnu&logoColor=white)
![CSV](https://img.shields.io/badge/Data-CSV-217346?style=for-the-badge&logo=microsoftexcel&logoColor=white)
![CLI](https://img.shields.io/badge/Interface-CLI-4D4D4D?style=for-the-badge&logo=gnubash&logoColor=white)
![Algorithm](https://img.shields.io/badge/Algorithm-Gale--Shapley-8A2BE2?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-CLI%20Complete-brightgreen?style=for-the-badge)

A C++ CLI tool that matches candidates to companies with fixed seat counts
using a Gale–Shapley-style stable matching algorithm — built for the PM
Internship Scheme allocation problem (SIH25033/34).

## Problem

Match N candidates to M companies, each with a fixed number of seats, such
that the final assignment is **stable**: no candidate-company pair exists
where both would rather switch away from their current match to be with
each other.

## How It Works

1. **Score** — every candidate is scored against every company using skill
   overlap, CGPA, and sector/location preference alignment.
2. **Rank** — each candidate's scores are sorted into a preference list
   (most-preferred company first).
3. **Allocate** — candidates are processed one at a time from a queue:
   - If their top remaining choice has an open seat, they're placed.
   - If the seat is full, they're compared against the *weakest* candidate
     currently holding a seat there. Higher score → they take the seat and
     displace the weaker candidate (who re-enters the queue). Lower score →
     they move on to their next preference.
4. **Terminate** — the loop ends when every candidate is placed or has
   exhausted their preference list.

This guarantees the result is stable — the same mathematical guarantee
Gale-Shapley provides.

## Data Structures Used

| Structure | Where | Purpose |
|---|---|---|
| **Hash Map** (`unordered_map`) | `candidates_`, `companies_`, `scoreCache_` | O(1) lookup by ID; caches every pairwise score so it's never recomputed |
| **Min-Heap** (`priority_queue`, size = seat count) | `Company::heldSeats` | Top of heap = weakest currently-held candidate → O(1) peek, O(log seats) displacement instead of scanning all seat-holders |
| **Queue** (`std::queue`) | `pool` in `Allocator::runAllocation` | Drives the main loop: holds not-yet-placed candidates, re-enqueues anyone displaced |
| **Sorting** (`std::sort`) | `Allocator::buildPreferenceLists` | Run once per candidate to turn raw scores into a ranked preference list |

## Project Structure

```
pm_allocation_engine/
├── include/          Header files (candidate.h, company.h, scoring.h, csv_utils.h, allocator.h)
├── src/               Implementation files + main.cpp (CLI menu)
├── data/              candidates.csv, companies.csv (sample/input data)
├── Makefile
└── README.md
```

## Build & Run

```bash
make clean && make
./allocator_app
```

Menu flow (must be done in order):

1. **Load candidates & companies from CSV** — press Enter twice to accept
   the default paths (`data/candidates.csv`, `data/companies.csv`)
2. **Build preference lists** — scores + sorts every candidate
3. **Run stable allocation** — runs the queue/heap matching process
4. **View results** — prints final matches per company + any unmatched candidates
5. **Export results to CSV** — saves to `results.csv`
6. **Exit**

## CSV Formats

**`candidates.csv`**
```
id,name,skills(;-separated),cgpa,sector,location
```

**`companies.csv`**
```
id,name,required_skills(;-separated),seats,sector,location
```

## Scoring

Each candidate-company score (0–100) is a weighted sum of:

- Skill overlap — 50%
- CGPA (normalized out of 10) — 30%
- Sector match — 10%
- Location match — 10%

Weights are adjustable in `src/scoring.cpp`.

## Extending

- Change scoring weights or logic in `scoring.cpp`.
- Add a hard skill-requirement filter before building preference lists if
  partial matches shouldn't be considered at all.
- The `Allocator` class is decoupled from CLI I/O, so a future UI (web or
  desktop) can reuse it directly without changes to the core algorithm.

## Status

CLI version — functional and tested. UI layer planned as a later phase.
