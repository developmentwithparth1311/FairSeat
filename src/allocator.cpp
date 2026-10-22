#include "allocator.h"
#include "scoring.h"
#include <algorithm>
#include <queue>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <set>
#include <stdexcept>

Allocator::Allocator(std::unordered_map<int, Candidate>& candidates,
                      std::unordered_map<int, Company>& companies,
                      AllocationPolicy policy)
    : candidates_(candidates), companies_(companies), policy_(std::move(policy)) {
    validateAllocationPolicy(policy_);
    if (candidates_.empty()) throw std::invalid_argument("At least one candidate is required");
    if (companies_.empty()) throw std::invalid_argument("At least one company is required");
    for (const auto& [candidateId, candidate] : candidates_) {
        for (const int companyId : candidate.submittedPreferences) {
            if (companies_.find(companyId) == companies_.end()) {
                throw std::invalid_argument("Candidate " + std::to_string(candidateId) +
                                            " prefers unknown company " + std::to_string(companyId));
            }
        }
    }
    for (const auto& [companyId, company] : companies_) {
        if (company.seats <= 0) {
            throw std::invalid_argument("Company " + std::to_string(companyId) +
                                        " must have at least one seat");
        }
    }
}

long long Allocator::cacheKey(int candId, int compId) {
    return (static_cast<long long>(candId) << 32) | static_cast<unsigned int>(compId);
}

double Allocator::getScore(int candId, int compId) {
    long long key = cacheKey(candId, compId);
    auto it = scoreCache_.find(key);
    if (it != scoreCache_.end()) {
        ++metrics_.scoreCacheHits;
        return it->second;
    }

    double s = computeScore(candidates_.at(candId), companies_.at(compId), policy_.weights);
    ++metrics_.scoreEvaluations;
    scoreCache_[key] = s;
    return s;
}

double Allocator::scoreFor(int candidateId, int companyId) const {
    auto it = scoreCache_.find(cacheKey(candidateId, companyId));
    if (it != scoreCache_.end()) return it->second;
    return computeScore(candidates_.at(candidateId), companies_.at(companyId), policy_.weights);
}

bool Allocator::isEligible(const Candidate& candidate, const Company& company) const {
    if (policy_.excludePriorParticipants && candidate.priorParticipation.value_or(false)) return false;
    if (policy_.qualificationRequirement == "all_required") {
        for (const auto& required : company.requiredQualifications)
            if (candidate.qualifications.find(required) == candidate.qualifications.end()) return false;
    }
    if (policy_.locationRequirement == "preferred_locations" && !candidate.preferredLocations.empty() &&
        std::find(candidate.preferredLocations.begin(), candidate.preferredLocations.end(), company.location) == candidate.preferredLocations.end()) return false;
    if (policy_.sectorRequirement == "sector_interests" && !candidate.sectorInterests.empty() &&
        std::find(candidate.sectorInterests.begin(), candidate.sectorInterests.end(), company.sector) == candidate.sectorInterests.end()) return false;
    return true;
}

std::optional<double> Allocator::cutoffFor(int companyId) const {
    const Company& company = companies_.at(companyId);
    if (company.seatsFilled() < company.seats || company.heldSeats.empty()) return std::nullopt;
    return company.heldSeats.top().first;
}

void Allocator::buildPreferenceLists() {
    scoreCache_.clear();
    metrics_ = {};
    preferenceGraph_ = {};
    for (const auto& [id, candidate] : candidates_) { (void)candidate; preferenceGraph_.candidateIds.push_back(id); }
    for (const auto& [id, company] : companies_) { (void)company; preferenceGraph_.companyIds.push_back(id); }
    std::sort(preferenceGraph_.candidateIds.begin(), preferenceGraph_.candidateIds.end());
    std::sort(preferenceGraph_.companyIds.begin(), preferenceGraph_.companyIds.end());
    for (const int id : preferenceGraph_.candidateIds) preferenceGraph_.candidateEdges.emplace(id, std::vector<int>{});
    for (const int id : preferenceGraph_.companyIds) preferenceGraph_.companyEdges.emplace(id, std::vector<int>{});
    for (auto& [candId, candidate] : candidates_) {
        candidate.eligibilityFilteredCount = 0;
        candidate.preferenceList.clear();
        candidate.nextPrefIdx = 0;
        candidate.matchedCompany = -1;
        if (candidate.hasSubmittedPreferences) {
            std::set<int> seen;
            for (const int companyId : candidate.submittedPreferences) {
                if (companies_.find(companyId) == companies_.end()) {
                    throw std::invalid_argument("Candidate " + std::to_string(candId) +
                                                " prefers unknown company " + std::to_string(companyId));
                }
                if (!seen.insert(companyId).second) {
                    throw std::invalid_argument("Candidate " + std::to_string(candId) +
                                                " has a duplicate company preference");
                }
            }
            for (const int companyId : candidate.submittedPreferences) {
                if (isEligible(candidate, companies_.at(companyId))) candidate.preferenceList.push_back(companyId);
                else ++candidate.eligibilityFilteredCount;
            }
            continue;
        }

        std::vector<std::pair<double,int>> scored;
        scored.reserve(companies_.size());

        for (auto& [compId, company] : companies_) {
            if (!isEligible(candidate, company)) {
                ++candidate.eligibilityFilteredCount;
                continue;
            }
            double s = getScore(candId, compId);
            scored.push_back({s, compId});
        }

        std::sort(scored.begin(), scored.end(), [this](const auto& a, const auto& b) {
            ++metrics_.preferenceSortComparisons;
            if (a.first != b.first) return a.first > b.first;
            return a.second < b.second;
        });

        for (auto& [score, compId] : scored) candidate.preferenceList.push_back(compId);
    }
    for (const int candidateId : preferenceGraph_.candidateIds) {
        const auto& edges = candidates_.at(candidateId).preferenceList;
        preferenceGraph_.candidateEdges[candidateId] = edges;
        preferenceGraph_.edgeCount += edges.size();
        for (const int companyId : edges) preferenceGraph_.companyEdges[companyId].push_back(candidateId);
    }
    metrics_.graphEdges = preferenceGraph_.edgeCount;
    const auto possiblePairs = preferenceGraph_.candidateIds.size() * preferenceGraph_.companyIds.size();
    preferenceGraph_.density = possiblePairs == 0 ? 0.0 :
        static_cast<double>(preferenceGraph_.edgeCount) / static_cast<double>(possiblePairs);
}

void Allocator::runAllocation() {
    for (auto& [id, comp] : companies_) {
        while (!comp.heldSeats.empty()) comp.heldSeats.pop();
    }

    allocationTrace_.clear();
    std::queue<int> pool;
    std::vector<int> orderedCandidateIds;
    orderedCandidateIds.reserve(candidates_.size());
    for (const auto& [id, candidate] : candidates_) {
        (void)candidate;
        orderedCandidateIds.push_back(id);
    }
    std::sort(orderedCandidateIds.begin(), orderedCandidateIds.end());
    for (const int id : orderedCandidateIds) {
        Candidate& c = candidates_.at(id);
        c.matchedCompany = -1;
        c.nextPrefIdx = 0;
        pool.push(id);
        ++metrics_.queuePushes;
    }

    while (!pool.empty()) {
        int candId = pool.front();
        pool.pop();
        ++metrics_.queuePops;

        Candidate& cand = candidates_.at(candId);

        const auto& edges = preferenceGraph_.candidateEdges.at(candId);
        if (cand.nextPrefIdx >= edges.size()) {
            const std::string reason = unmatchedReason(candId);
            recordEvent("unmatched", candId, -1, 0.0, -1, reason);
            continue;
        }

        int compId = edges[cand.nextPrefIdx];
        cand.nextPrefIdx++;
        ++metrics_.proposals;

        Company& comp = companies_.at(compId);
        double score = getScore(candId, compId);
        recordEvent("proposal", candId, compId, score, -1, "candidate_proposes");

        if (comp.hasOpenSeat()) {
            comp.heldSeats.push({score, candId});
            ++metrics_.seatHeapPushes;
            cand.matchedCompany = compId;
            recordEvent("accepted", candId, compId, score, -1, "accepted_open_seat");
        } else {
            ++metrics_.companyRankComparisons;
            auto [weakestScore, weakestId] = comp.heldSeats.top();
            recordEvent("competition", candId, compId, score, weakestId,
                        "compare_with_weakest_heap_holder");

            const bool outranksWeakest = score > weakestScore ||
                (score == weakestScore && candId < weakestId);
            if (outranksWeakest) {
                comp.heldSeats.pop();
                ++metrics_.seatHeapPops;
                comp.heldSeats.push({score, candId});
                ++metrics_.seatHeapPushes;
                ++metrics_.displacements;
                cand.matchedCompany = compId;
                recordEvent("accepted", candId, compId, score, weakestId,
                            score == weakestScore ? "higher_priority_equal_score" : "outscored_weakest_holder");

                Candidate& displaced = candidates_.at(weakestId);
                displaced.matchedCompany = -1;
                recordEvent("displaced", weakestId, compId, weakestScore, candId,
                            "replaced_by_higher_company_priority");
                pool.push(weakestId); // re-enters the pool
                ++metrics_.queuePushes;
            } else {
                recordEvent("rejected", candId, compId, score, weakestId,
                            score == weakestScore ? "lost_equal_score_tiebreak" : "score_below_cutoff");
                pool.push(candId);
                ++metrics_.rejections;
                ++metrics_.queuePushes;
            }
        }
    }

    for (const int id : orderedCandidateIds) {
        const Candidate& candidate = candidates_.at(id);
        recordEvent("completion", id, candidate.matchedCompany, 0.0, -1,
                    candidate.matchedCompany == -1 ? unmatchedReason(id) : "final_assignment");
    }

    const auto violations = validateAllocation();
    if (!violations.empty()) {
        throw std::logic_error("Allocation invariant failed: " + violations.front());
    }
    const auto blockers = blockingPairs();
    if (!blockers.empty()) {
        throw std::logic_error("Allocation is not stable under its declared preference rankings");
    }
}

void Allocator::recordEvent(const std::string& type, int candidateId, int companyId,
                            double score, int displacedCandidateId,
                            const std::string& reasonCode) {
    allocationTrace_.push_back({allocationTrace_.size() + 1, type, candidateId,
                                companyId, score, displacedCandidateId, reasonCode});
}

bool Allocator::companyWouldPrefer(int companyId, double score, int candidateId) const {
    const Company& company = companies_.at(companyId);
    if (company.hasOpenSeat()) return true;
    if (company.heldSeats.empty()) return false;
    const auto [weakestScore, weakestId] = company.heldSeats.top();
    return score > weakestScore || (score == weakestScore && candidateId < weakestId);
}

std::string Allocator::unmatchedReason(int candidateId) const {
    const Candidate& candidate = candidates_.at(candidateId);
    if (candidate.matchedCompany != -1) return {};
    return candidate.preferenceList.empty()
        ? (candidate.eligibilityFilteredCount > 0 ? "no_eligible_opportunities" : "no_acceptable_opportunities")
        : "all_acceptable_opportunities_rejected";
}

std::vector<std::string> Allocator::validateAllocation() const {
    std::vector<std::string> errors;
    std::unordered_map<int, int> holderCount;
    for (const auto& [companyId, company] : companies_) {
        if (company.seats < 0) errors.push_back("negative capacity for company " + std::to_string(companyId));
        if (company.seatsFilled() > company.seats) {
            errors.push_back("capacity exceeded for company " + std::to_string(companyId));
        }
        auto heap = company.heldSeats;
        while (!heap.empty()) {
            const int candidateId = heap.top().second;
            heap.pop();
            const auto candidateIt = candidates_.find(candidateId);
            if (candidateIt == candidates_.end()) {
                errors.push_back("unknown candidate held by company " + std::to_string(companyId));
                continue;
            }
            ++holderCount[candidateId];
            if (candidateIt->second.matchedCompany != companyId) {
                errors.push_back("candidate/company match state disagrees for candidate " + std::to_string(candidateId));
            }
        }
    }
    for (const auto& [candidateId, candidate] : candidates_) {
        const int held = holderCount[candidateId];
        if (held > 1) errors.push_back("candidate assigned more than once: " + std::to_string(candidateId));
        if (candidate.matchedCompany == -1 && held != 0) {
            errors.push_back("unmatched candidate occupies a seat: " + std::to_string(candidateId));
        }
        if (candidate.matchedCompany != -1) {
            if (companies_.find(candidate.matchedCompany) == companies_.end()) {
                errors.push_back("candidate matched to unknown company: " + std::to_string(candidateId));
                continue;
            }
            if (held != 1) errors.push_back("matched candidate does not occupy exactly one seat: " + std::to_string(candidateId));
            if (std::find(candidate.preferenceList.begin(), candidate.preferenceList.end(),
                          candidate.matchedCompany) == candidate.preferenceList.end()) {
                errors.push_back("assignment is outside candidate's acceptable list: " + std::to_string(candidateId));
            }
        }
    }
    return errors;
}

std::vector<std::pair<int, int>> Allocator::blockingPairs() const {
    std::vector<std::pair<int, int>> blockers;
    for (const auto& [candidateId, candidate] : candidates_) {
        std::size_t currentRank = candidate.preferenceList.size();
        if (candidate.matchedCompany != -1) {
            const auto current = std::find(candidate.preferenceList.begin(), candidate.preferenceList.end(),
                                            candidate.matchedCompany);
            if (current == candidate.preferenceList.end()) continue;
            currentRank = static_cast<std::size_t>(current - candidate.preferenceList.begin());
        }
        for (std::size_t rank = 0; rank < currentRank; ++rank) {
            const int companyId = candidate.preferenceList[rank];
            if (companyWouldPrefer(companyId, scoreFor(candidateId, companyId), candidateId)) {
                blockers.emplace_back(candidateId, companyId);
            }
        }
    }
    return blockers;
}

void Allocator::printResults() const {
    std::cout << "\n================ ALLOCATION RESULTS ================\n";
    for (auto& [compId, comp] : companies_) {
        std::cout << "\nCompany: " << comp.name << " (ID " << comp.id << ") "
                   << "[" << comp.heldSeats.size() << "/" << comp.seats << " seats filled]\n";

        auto heapCopy = comp.heldSeats;
        std::vector<std::pair<double,int>> holders;
        while (!heapCopy.empty()) {
            holders.push_back(heapCopy.top());
            heapCopy.pop();
        }
        std::sort(holders.begin(), holders.end(), std::greater<>());

        for (auto& [score, candId] : holders) {
            const Candidate& c = candidates_.at(candId);
            std::cout << "   - " << c.name << " (ID " << c.id << ") "
                       << "score=" << std::fixed << std::setprecision(2) << score << "\n";
        }
    }

    std::cout << "\n--- Unmatched Candidates ---\n";
    bool anyUnmatched = false;
    for (auto& [id, c] : candidates_) {
        if (c.matchedCompany == -1) {
            anyUnmatched = true;
            std::cout << "   - " << c.name << " (ID " << c.id << ")\n";
        }
    }
    if (!anyUnmatched) std::cout << "   None - everyone was placed.\n";
    std::cout << "=====================================================\n";
}

void Allocator::exportResults(const std::string& path) const {
    std::ofstream out(path);
    out << "candidate_id,candidate_name,company_id,company_name,score\n";
    for (auto& [id, c] : candidates_) {
        if (c.matchedCompany == -1) {
            out << c.id << "," << c.name << ",,UNMATCHED,\n";
        } else {
            const Company& comp = companies_.at(c.matchedCompany);
            double score = 0.0;
            auto key = cacheKey(c.id, c.matchedCompany);
            auto it = scoreCache_.find(key);
            if (it != scoreCache_.end()) score = it->second;
            out << c.id << "," << c.name << "," << comp.id << "," << comp.name
                << "," << std::fixed << std::setprecision(2) << score << "\n";
        }
    }
    std::cout << "Results exported to " << path << "\n";
}
