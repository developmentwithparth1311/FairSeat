# How SAE allocates candidates

SAE is a decision-support tool that ranks each candidate's company choices,
then assigns candidates to fixed company seats. It does not change official
PM Internship Scheme rules or replace the official selection process.

## Score components

Each candidate-company pair receives a score from 0 to 100. Skill overlap
contributes 50% of the score, CGPA contributes 30%, and sector and location
matches contribute 10% each. The engine calculates these values; this
assistant reads the exported score and breakdown.

## Preference lists

For each candidate, SAE sorts companies from highest to lowest score. When
scores tie, the company with the lower numeric ID comes first. The candidate
then proposes to companies in that order.

## Seats and displacement

Each company has a fixed seat count. If a seat is open, the candidate is held
there. If the company is full, SAE compares the new candidate's score with the
weakest current holder. A strictly higher score takes the seat and the displaced
candidate tries their next company. A tie does not displace the current holder.

## Why allocation is stable

Candidates only move down their preference lists, and a company keeps its
strongest candidates among those who have proposed to it. When the process
ends, no candidate-company pair that was considered can both improve by
switching: a candidate either already holds a more preferred company, or the
company preferred someone it ranked at least as highly under the engine's
score comparison.

## Cutoff score

When all seats at a company are filled, the cutoff is the score of its weakest
current seat holder in the final allocation. It describes this SAE run; it is
not a guaranteed future threshold or an official scheme rule. An open company
has no cutoff score.
