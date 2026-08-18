#include "allocator.h"
#include "scoring.h"
#include <algorithm>
#include <queue>
#include <fstream>
#include <iostream>
#include <iomanip>

Allocator::Allocator(std::unordered_map<int, Candidate>& candidates,
                      std::unordered_map<int, Company>& companies)
    : candidates_(candidates), companies_(companies) {}

long long Allocator::cacheKey(int candId, int compId) {
    return (static_cast<long long>(candId) << 32) | static_cast<unsigned int>(compId);
}

double Allocator::getScore(int candId, int compId) {
    long long key = cacheKey(candId, compId);
    auto it = scoreCache_.find(key);
    if (it != scoreCache_.end()) return it->second;

    double s = computeScore(candidates_.at(candId), companies_.at(compId));
    scoreCache_[key] = s;
    return s;
}

void Allocator::buildPreferenceLists() {
    for (auto& [candId, candidate] : candidates_) {
        std::vector<std::pair<double,int>> scored;
        scored.reserve(companies_.size());

        for (auto& [compId, company] : companies_) {
            double s = getScore(candId, compId);
            scored.push_back({s, compId});
        }

        std::sort(scored.begin(), scored.end(), [](const auto& a, const auto& b) {
            if (a.first != b.first) return a.first > b.first;
            return a.second < b.second;
        });

        candidate.preferenceList.clear();
        for (auto& [score, compId] : scored) candidate.preferenceList.push_back(compId);
        candidate.nextPrefIdx = 0;
        candidate.matchedCompany = -1;
    }
}

void Allocator::runAllocation() {
    for (auto& [id, comp] : companies_) {
        while (!comp.heldSeats.empty()) comp.heldSeats.pop();
    }

    std::queue<int> pool;
    for (auto& [id, c] : candidates_) {
        c.matchedCompany = -1;
        c.nextPrefIdx = 0;
        pool.push(id);
    }

    while (!pool.empty()) {
        int candId = pool.front();
        pool.pop();

        Candidate& cand = candidates_.at(candId);

        if (cand.nextPrefIdx >= cand.preferenceList.size()) continue;

        int compId = cand.preferenceList[cand.nextPrefIdx];
        cand.nextPrefIdx++;

        Company& comp = companies_.at(compId);
        double score = getScore(candId, compId);

        if (comp.hasOpenSeat()) {
            comp.heldSeats.push({score, candId});
            cand.matchedCompany = compId;
        } else {
            auto [weakestScore, weakestId] = comp.heldSeats.top();

            if (score > weakestScore) {
                comp.heldSeats.pop();
                comp.heldSeats.push({score, candId});
                cand.matchedCompany = compId;

                Candidate& displaced = candidates_.at(weakestId);
                displaced.matchedCompany = -1;
                pool.push(weakestId); // re-enters the pool
            } else {
                pool.push(candId);
            }
        }
    }
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
