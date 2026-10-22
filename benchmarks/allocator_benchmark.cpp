#include "allocator.h"
#include "scoring.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <random>
#include <set>
#include <unordered_map>

namespace {
using Clock = std::chrono::steady_clock;
using Assignment = std::unordered_map<int, int>;

struct RunResult {
    Assignment assignment;
    std::size_t comparisons = 0;
    std::size_t proposals = 0;
};

RunResult runLinearScan(const std::unordered_map<int, Candidate>& candidates,
                        const std::unordered_map<int, Company>& companies) {
    RunResult result;
    std::unordered_map<int, std::vector<std::pair<double, int>>> held;
    std::vector<int> ids;
    for (const auto& [id, candidate] : candidates) { (void)candidate; ids.push_back(id); }
    std::sort(ids.begin(), ids.end());
    std::unordered_map<int, std::size_t> next;
    std::vector<int> queue = ids;
    std::size_t head = 0;
    while (head < queue.size()) {
        const int candidateId = queue[head++];
        const auto& choices = candidates.at(candidateId).preferenceList;
        auto& rank = next[candidateId];
        if (rank >= choices.size()) { result.assignment[candidateId] = -1; continue; }
        const int companyId = choices[rank++];
        ++result.proposals;
        const double score = computeScore(candidates.at(candidateId), companies.at(companyId));
        auto& seats = held[companyId];
        const int capacity = companies.at(companyId).seats;
        if (static_cast<int>(seats.size()) < capacity) {
            seats.emplace_back(score, candidateId);
            result.assignment[candidateId] = companyId;
            continue;
        }
        auto weakest = seats.begin();
        for (auto it = seats.begin() + 1; it != seats.end(); ++it) {
            ++result.comparisons;
            if (it->first < weakest->first || (it->first == weakest->first && it->second > weakest->second)) weakest = it;
        }
        ++result.comparisons; // challenger compared with the weakest holder
        if (score > weakest->first || (score == weakest->first && candidateId < weakest->second)) {
            const int displaced = weakest->second;
            *weakest = {score, candidateId};
            result.assignment[candidateId] = companyId;
            queue.push_back(displaced);
            result.assignment[displaced] = -1;
        } else {
            result.assignment[candidateId] = -1;
            queue.push_back(candidateId);
        }
    }
    return result;
}

RunResult runGreedy(const std::unordered_map<int, Candidate>& candidates,
                    const std::unordered_map<int, Company>& companies) {
    RunResult result;
    std::unordered_map<int, int> filled;
    std::vector<int> ids;
    for (const auto& [id, candidate] : candidates) { (void)candidate; ids.push_back(id); }
    std::sort(ids.begin(), ids.end());
    for (const int id : ids) {
        result.assignment[id] = -1;
        for (const int companyId : candidates.at(id).preferenceList) {
            if (filled[companyId] < companies.at(companyId).seats) {
                ++filled[companyId];
                result.assignment[id] = companyId;
                break;
            }
        }
    }
    return result;
}

double totalScore(const Assignment& assignment, const std::unordered_map<int, Candidate>& candidates,
                  const std::unordered_map<int, Company>& companies) {
    double total = 0.0;
    for (const auto& [id, companyId] : assignment)
        if (companyId >= 0) total += computeScore(candidates.at(id), companies.at(companyId));
    return total;
}

std::size_t matchedCount(const Assignment& assignment) {
    return std::count_if(assignment.begin(), assignment.end(), [](const auto& entry) { return entry.second >= 0; });
}
}

int main(int argc, char** argv) {
    const int n = argc > 1 ? std::max(1, std::stoi(argv[1])) : 1000;
    const int m = argc > 2 ? std::max(1, std::stoi(argv[2])) : 50;
    const double density = argc > 3 ? std::clamp(std::stod(argv[3]), 0.0, 1.0) : 0.25;
    const unsigned seed = argc > 4 ? static_cast<unsigned>(std::stoul(argv[4])) : 42U;
    std::mt19937 rng(seed);
    std::uniform_real_distribution<double> unit(0.0, 1.0);
    const std::vector<std::string> skillPool = {"C++", "Python", "SQL", "Linux", "Git", "ML", "Cloud", "Java"};

    std::unordered_map<int, Candidate> candidates;
    std::unordered_map<int, Company> companies;
    for (int j = 0; j < m; ++j) {
        Company company{};
        company.id = j + 1;
        company.name = "Opportunity " + std::to_string(j + 1);
        company.seats = std::max(1, (n * 65) / (100 * m));
        company.sector = (j % 2) ? "IT" : "Research";
        company.location = (j % 3) ? "Pune" : "Delhi";
        for (std::size_t k = 0; k < skillPool.size(); ++k)
            if (unit(rng) < 0.35) company.requiredSkills.insert(skillPool[k]);
        companies.emplace(company.id, std::move(company));
    }
    for (int i = 0; i < n; ++i) {
        Candidate candidate{};
        candidate.id = i + 1;
        candidate.name = "Candidate " + std::to_string(i + 1);
        candidate.cgpa = 5.0 + unit(rng) * 5.0;
        candidate.sector = (i % 2) ? "IT" : "Research";
        candidate.location = (i % 3) ? "Pune" : "Delhi";
        for (std::size_t k = 0; k < skillPool.size(); ++k)
            if (unit(rng) < 0.35) candidate.skills.insert(skillPool[k]);
        candidate.hasSubmittedPreferences = true;
        std::vector<std::pair<double, int>> choices;
        for (int j = 0; j < m; ++j) {
            if (unit(rng) <= density) choices.emplace_back(computeScore(candidate, companies.at(j + 1)), j + 1);
        }
        std::sort(choices.begin(), choices.end(), [](const auto& a, const auto& b) {
            return a.first != b.first ? a.first > b.first : a.second < b.second;
        });
        for (const auto& choice : choices) candidate.submittedPreferences.push_back(choice.second);
        candidates.emplace(candidate.id, std::move(candidate));
    }

    // Compare dense all-pair scores with sparse acceptable-edge payload storage.
    const auto storageStart = Clock::now();
    std::vector<double> dense(static_cast<std::size_t>(n) * m);
    for (int i = 0; i < n; ++i) for (int j = 0; j < m; ++j)
        dense[static_cast<std::size_t>(i) * m + j] = computeScore(candidates.at(i + 1), companies.at(j + 1));
    const double denseMs = std::chrono::duration<double, std::milli>(Clock::now() - storageStart).count();
    const auto sparseStart = Clock::now();
    struct EdgeScore { int candidate; int company; double score; };
    std::vector<EdgeScore> sparse;
    std::size_t expectedEdges = 0;
    for (const auto& [id, candidate] : candidates) { (void)id; expectedEdges += candidate.submittedPreferences.size(); }
    sparse.reserve(expectedEdges);
    for (int i = 0; i < n; ++i) for (const int j : candidates.at(i + 1).submittedPreferences)
        sparse.push_back({i, j - 1, computeScore(candidates.at(i + 1), companies.at(j))});
    const double sparseMs = std::chrono::duration<double, std::milli>(Clock::now() - sparseStart).count();

    Allocator allocator(candidates, companies);
    allocator.buildPreferenceLists();
    const auto heapStart = Clock::now();
    allocator.runAllocation();
    const double heapMs = std::chrono::duration<double, std::milli>(Clock::now() - heapStart).count();
    RunResult heapResult;
    for (const auto& [id, candidate] : candidates) heapResult.assignment[id] = candidate.matchedCompany;
    const auto linearStart = Clock::now();
    const RunResult linear = runLinearScan(candidates, companies);
    const double linearMs = std::chrono::duration<double, std::milli>(Clock::now() - linearStart).count();
    const auto greedyStart = Clock::now();
    const RunResult greedy = runGreedy(candidates, companies);
    const double greedyMs = std::chrono::duration<double, std::milli>(Clock::now() - greedyStart).count();
    if (heapResult.assignment != linear.assignment) {
        std::cerr << "Heap and linear deferred-acceptance assignments differ.\n";
        return 2;
    }

    const auto& ops = allocator.operationCounts();
    std::cout << "seed,candidates,companies,edges,density,dense_ms,dense_payload_bytes,sparse_ms,sparse_payload_bytes,heap_da_ms,heap_proposals,heap_pushes,heap_pops,linear_da_ms,linear_scans,greedy_ms,da_matches,greedy_matches,da_score,greedy_score\n";
    std::cout << seed << ',' << n << ',' << m << ',' << sparse.size() << ',' << std::fixed << std::setprecision(4)
              << density << ',' << denseMs << ',' << dense.size() * sizeof(double) << ',' << sparseMs << ','
              << sparse.capacity() * sizeof(EdgeScore) << ',' << heapMs << ',' << ops.proposals << ','
              << ops.seatHeapPushes << ',' << ops.seatHeapPops << ',' << linearMs << ',' << linear.comparisons << ','
              << greedyMs << ',' << matchedCount(heapResult.assignment) << ',' << matchedCount(greedy.assignment) << ','
              << totalScore(heapResult.assignment, candidates, companies) << ','
              << totalScore(greedy.assignment, candidates, companies) << '\n';
    (void)totalScore;
    return 0;
}
