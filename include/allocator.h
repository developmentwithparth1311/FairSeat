#pragma once
#include <unordered_map>
#include <string>
#include "candidate.h"
#include "company.h"

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
    double cutoffFor(int companyId) const;

private:
    std::unordered_map<int, Candidate>& candidates_;
    std::unordered_map<int, Company>& companies_;

    std::unordered_map<long long, double> scoreCache_;

    double getScore(int candId, int compId);
    static long long cacheKey(int candId, int compId);
};
