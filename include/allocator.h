#pragma once
#include <unordered_map>
#include <string>
#include <optional>
#include <vector>
#include "candidate.h"
#include "company.h"

struct AllocationEvent {
    std::size_t sequence;
    std::string type;
    int candidateId;
    int companyId;
    double score;
    int displacedCandidateId;
    std::string reasonCode;
};

class Allocator {
public:
    Allocator(std::unordered_map<int, Candidate>& candidates,
              std::unordered_map<int, Company>& companies);

    void buildPreferenceLists();

    void runAllocation();

    void printResults() const;
    void exportResults(const std::string& path) const;
    const std::unordered_map<int, Candidate>& candidates() const { return candidates_; }
    const std::unordered_map<int, Company>& companies() const { return companies_; }
    double scoreFor(int candidateId, int companyId) const;
    std::optional<double> cutoffFor(int companyId) const;
    const std::vector<AllocationEvent>& allocationTrace() const { return allocationTrace_; }
    std::vector<std::string> validateAllocation() const;
    std::vector<std::pair<int, int>> blockingPairs() const;
    std::string unmatchedReason(int candidateId) const;
    bool companyWouldPrefer(int companyId, double score, int candidateId) const;

private:
    std::unordered_map<int, Candidate>& candidates_;
    std::unordered_map<int, Company>& companies_;

    std::unordered_map<long long, double> scoreCache_;
    std::vector<AllocationEvent> allocationTrace_;

    double getScore(int candId, int compId);
    static long long cacheKey(int candId, int compId);
    void recordEvent(const std::string& type, int candidateId, int companyId,
                     double score, int displacedCandidateId,
                     const std::string& reasonCode);
};
