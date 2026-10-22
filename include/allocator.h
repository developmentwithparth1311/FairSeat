#pragma once
#include <unordered_map>
#include <string>
#include <optional>
#include <vector>
#include <cstdint>
#include "candidate.h"
#include "company.h"
#include "allocation_policy.h"

struct AllocationEvent {
    std::size_t sequence;
    std::string type;
    int candidateId;
    int companyId;
    double score;
    int displacedCandidateId;
    std::string reasonCode;
};

// The graph contains acceptable candidate-to-company edges. It does not imply
// any external eligibility rule beyond the Phase 1 input contract.
struct PreferenceGraph {
    std::vector<int> candidateIds;
    std::vector<int> companyIds;
    std::unordered_map<int, std::vector<int>> candidateEdges;
    std::unordered_map<int, std::vector<int>> companyEdges;
    std::size_t edgeCount = 0;
    double density = 0.0;
};

struct AllocationMetrics {
    std::size_t scoreEvaluations = 0;
    std::size_t scoreCacheHits = 0;
    std::size_t preferenceSortComparisons = 0;
    std::size_t graphEdges = 0;
    std::size_t queuePushes = 0;
    std::size_t queuePops = 0;
    std::size_t proposals = 0;
    std::size_t companyRankComparisons = 0;
    std::size_t seatHeapPushes = 0;
    std::size_t seatHeapPops = 0;
    std::size_t displacements = 0;
    std::size_t rejections = 0;
};

class Allocator {
public:
    Allocator(std::unordered_map<int, Candidate>& candidates,
              std::unordered_map<int, Company>& companies,
              AllocationPolicy policy = {});

    void buildPreferenceLists();

    void runAllocation();

    void printResults() const;
    void exportResults(const std::string& path) const;
    const std::unordered_map<int, Candidate>& candidates() const { return candidates_; }
    const std::unordered_map<int, Company>& companies() const { return companies_; }
    double scoreFor(int candidateId, int companyId) const;
    std::optional<double> cutoffFor(int companyId) const;
    const std::vector<AllocationEvent>& allocationTrace() const { return allocationTrace_; }
    const PreferenceGraph& preferenceGraph() const { return preferenceGraph_; }
    const AllocationMetrics& operationCounts() const { return metrics_; }
    const AllocationPolicy& policy() const { return policy_; }
    std::vector<std::string> validateAllocation() const;
    std::vector<std::pair<int, int>> blockingPairs() const;
    std::string unmatchedReason(int candidateId) const;
    bool companyWouldPrefer(int companyId, double score, int candidateId) const;

private:
    std::unordered_map<int, Candidate>& candidates_;
    std::unordered_map<int, Company>& companies_;
    AllocationPolicy policy_;

    std::unordered_map<long long, double> scoreCache_;
    std::vector<AllocationEvent> allocationTrace_;
    PreferenceGraph preferenceGraph_;
    AllocationMetrics metrics_;

    double getScore(int candId, int compId);
    static long long cacheKey(int candId, int compId);
    void recordEvent(const std::string& type, int candidateId, int companyId,
                     double score, int displacedCandidateId,
                     const std::string& reasonCode);
    bool isEligible(const Candidate& candidate, const Company& company) const;
};
