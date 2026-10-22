#include "allocator.h"
#include "scoring.h"

#include <algorithm>
#include <iomanip>
#include <iostream>
#include <random>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
using CandidateMap = std::unordered_map<int, Candidate>;
using CompanyMap = std::unordered_map<int, Company>;

struct ScenarioResult {
    CandidateMap candidates;
    CompanyMap companies;
    std::unordered_map<int, std::string> cohort;
    std::unordered_map<int, int> assignments;
    std::size_t eligible = 0;
    std::size_t allocated = 0;
    std::size_t seats = 0;
    std::size_t totalSeats = 0;
    ScoreWeights weights;
    std::set<std::string> matchedLocations;
    std::set<std::string> matchedSectors;
};

void addRandomMembers(std::set<std::string>& target,
                      const std::vector<std::string>& values,
                      std::mt19937& rng, double probability) {
    std::bernoulli_distribution include(probability);
    for (const auto& value : values) if (include(rng)) target.insert(value);
}

ScenarioResult runScenario(const CandidateMap& sourceCandidates,
                           const CompanyMap& sourceCompanies,
                           const std::unordered_map<int, std::string>& cohort,
                           AllocationPolicy policy) {
    ScenarioResult result;
    result.candidates = sourceCandidates;
    result.companies = sourceCompanies;
    result.cohort = cohort;
    result.weights = policy.weights;
    Allocator allocator(result.candidates, result.companies, std::move(policy));
    allocator.buildPreferenceLists();
    for (const auto& [id, edges] : allocator.preferenceGraph().candidateEdges) {
        (void)id;
        if (!edges.empty()) ++result.eligible;
    }
    for (const auto& [id, company] : result.companies) {
        (void)id;
        result.totalSeats += static_cast<std::size_t>(company.seats);
    }
    allocator.runAllocation();
    for (const auto& [id, candidate] : result.candidates) {
        result.assignments[id] = candidate.matchedCompany;
        if (candidate.matchedCompany >= 0) {
            ++result.allocated;
            result.matchedLocations.insert(candidate.location);
            result.matchedSectors.insert(candidate.sector);
        }
    }
    for (const auto& [id, company] : result.companies) {
        (void)id;
        result.seats += static_cast<std::size_t>(company.seatsFilled());
    }
    return result;
}

void emitScenario(const std::string& name, const ScenarioResult& result,
                  const std::unordered_map<int, int>& baseline,
                  const std::vector<std::string>& cohorts,
                  unsigned seed, int n, int m) {
    std::size_t changed = 0;
    for (const auto& [id, assignment] : result.assignments)
        if (baseline.at(id) != assignment) ++changed;
    const double utilization = result.totalSeats == 0 ? 0.0 :
        static_cast<double>(result.seats) / result.totalSeats;
    for (const auto& label : cohorts) {
        std::size_t count = 0, eligible = 0, allocated = 0;
        double scoreTotal = 0.0;
        std::set<std::string> groupLocations, groupSectors;
        for (const auto& [id, candidate] : result.candidates) {
            if (result.cohort.at(id) != label) continue;
            ++count;
            if (!candidate.preferenceList.empty()) ++eligible;
            if (candidate.matchedCompany >= 0) {
                ++allocated;
                groupLocations.insert(candidate.location);
                groupSectors.insert(candidate.sector);
                scoreTotal += computeScore(candidate, result.companies.at(candidate.matchedCompany),
                                           result.weights);
            }
        }
        const double eligibleRateByGroup = count ? static_cast<double>(eligible) / count : 0.0;
        const double allocationRate = count ? static_cast<double>(allocated) / count : 0.0;
        const double averageScore = allocated ? scoreTotal / allocated : 0.0;
        std::cout << seed << ',' << n << ',' << m << ',' << name << ',' << label << ',' << count << ',' << eligible << ','
                  << std::fixed << std::setprecision(4) << eligibleRateByGroup << ','
                  << allocated << ',' << (count - allocated) << ',' << allocationRate << ',' << averageScore << ',' << changed << ','
                  << result.seats << ',' << result.totalSeats << ',' << utilization << ','
                  << groupLocations.size() << ',' << groupSectors.size() << '\n';
    }
}
}

int main(int argc, char** argv) {
    const int n = argc > 1 ? std::max(2, std::stoi(argv[1])) : 400;
    const int m = argc > 2 ? std::max(1, std::stoi(argv[2])) : 24;
    const unsigned seed = argc > 3 ? static_cast<unsigned>(std::stoul(argv[3])) : 25033U;
    std::mt19937 rng(seed);
    const std::vector<std::string> skills = {"SQL", "Python", "Cloud", "Design", "Finance", "Communication"};
    const std::vector<std::string> locations = {"Pune", "Delhi", "Chennai", "Bengaluru"};
    const std::vector<std::string> sectors = {"IT", "Design", "Finance", "Operations"};
    const std::vector<std::string> qualifications = {"degree_a", "degree_b", "certificate_c"};
    CandidateMap candidates;
    CompanyMap companies;
    std::unordered_map<int, std::string> cohort;
    std::uniform_int_distribution<int> pickLocation(0, static_cast<int>(locations.size()) - 1);
    std::uniform_int_distribution<int> pickSector(0, static_cast<int>(sectors.size()) - 1);
    std::uniform_int_distribution<int> pickQualification(0, static_cast<int>(qualifications.size()) - 1);
    std::uniform_real_distribution<double> cgpa(5.0, 10.0);
    for (int j = 0; j < m; ++j) {
        Company company{};
        company.id = j + 1;
        company.name = "Synthetic opportunity " + std::to_string(j + 1);
        company.seats = std::max(1, (n * 60) / (100 * m));
        company.location = locations[static_cast<std::size_t>(j) % locations.size()];
        company.sector = sectors[static_cast<std::size_t>(j) % sectors.size()];
        addRandomMembers(company.requiredSkills, skills, rng, 0.35);
        company.requiredQualifications.insert(qualifications[static_cast<std::size_t>(j) % qualifications.size()]);
        companies.emplace(company.id, std::move(company));
    }
    for (int i = 0; i < n; ++i) {
        Candidate candidate{};
        candidate.id = i + 1;
        candidate.name = "Synthetic candidate " + std::to_string(i + 1);
        candidate.cgpa = cgpa(rng);
        candidate.location = locations[static_cast<std::size_t>(pickLocation(rng))];
        candidate.sector = sectors[static_cast<std::size_t>(pickSector(rng))];
        addRandomMembers(candidate.skills, skills, rng, 0.35);
        candidate.qualifications.insert(qualifications[static_cast<std::size_t>(pickQualification(rng))]);
        candidate.preferredLocations.push_back(candidate.location);
        candidate.sectorInterests.push_back(candidate.sector);
        candidate.priorParticipation = (i % 5 == 0);
        candidates.emplace(candidate.id, std::move(candidate));
        cohort.emplace(i + 1, i % 2 == 0 ? "synthetic_group_A" : "synthetic_group_B");
    }

    AllocationPolicy baselinePolicy = loadAllocationPolicy("config/allocation_policy_v2.conf");
    const ScenarioResult baseline = runScenario(candidates, companies, cohort, baselinePolicy);
    std::vector<std::string> groups = {"synthetic_group_A", "synthetic_group_B"};
    std::cout << "seed,candidates,companies,scenario,cohort,cohort_size,eligible,eligible_rate,allocated,unmatched,allocation_rate,average_score,changed_assignments,seats_filled,total_seats,seat_utilization,location_coverage,sectors_covered\n";
    // Keep stable top-level columns alongside the cohort rows for an audit-friendly CSV.
    for (const auto& group : groups) {
        std::size_t count = 0, eligible = 0, allocated = 0;
        double scoreSum = 0.0;
        std::set<std::string> groupLocations, groupSectors;
        for (const auto& [id, candidate] : baseline.candidates) {
            if (cohort.at(id) != group) continue;
            ++count;
            if (!candidate.preferenceList.empty()) ++eligible;
            if (candidate.matchedCompany >= 0) {
                ++allocated;
                groupLocations.insert(candidate.location);
                groupSectors.insert(candidate.sector);
                scoreSum += computeScore(candidate, baseline.companies.at(candidate.matchedCompany), baselinePolicy.weights);
            }
        }
        const double average = allocated ? scoreSum / allocated : 0.0;
        std::cout << seed << ',' << n << ',' << m << ",baseline," << group << ',' << count << ',' << eligible << ','
                  << std::fixed << std::setprecision(4) << (count ? static_cast<double>(eligible) / count : 0.0)
                  << ',' << allocated << ',' << (count - allocated) << ','
                  << (count ? static_cast<double>(allocated) / count : 0.0) << ','
                  << average << ",0," << baseline.seats << ',' << baseline.totalSeats << ','
                  << (baseline.totalSeats ? static_cast<double>(baseline.seats) / baseline.totalSeats : 0.0)
                  << ',' << groupLocations.size() << ',' << groupSectors.size() << '\n';
    }

    AllocationPolicy skillPolicy = baselinePolicy;
    skillPolicy.version = "synthetic-skills-emphasis";
    skillPolicy.weights = {0.65, 0.25, 0.05, 0.05};
    emitScenario("skills_emphasis", runScenario(candidates, companies, cohort, skillPolicy), baseline.assignments, groups, seed, n, m);

    AllocationPolicy qualificationPolicy = baselinePolicy;
    qualificationPolicy.version = "synthetic-qualification-filter";
    qualificationPolicy.qualificationRequirement = "all_required";
    emitScenario("qualification_filter", runScenario(candidates, companies, cohort, qualificationPolicy), baseline.assignments, groups, seed, n, m);

    AllocationPolicy locationPolicy = baselinePolicy;
    locationPolicy.version = "synthetic-location-filter";
    locationPolicy.locationRequirement = "preferred_locations";
    emitScenario("location_filter", runScenario(candidates, companies, cohort, locationPolicy), baseline.assignments, groups, seed, n, m);

    AllocationPolicy participationPolicy = baselinePolicy;
    participationPolicy.version = "synthetic-prior-participation-filter";
    participationPolicy.excludePriorParticipants = true;
    emitScenario("prior_participation_filter", runScenario(candidates, companies, cohort, participationPolicy), baseline.assignments, groups, seed, n, m);
    return 0;
}
