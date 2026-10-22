#include "allocator.h"
#include "csv_utils.h"

#include <cassert>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace {
Candidate candidate(int id, std::set<std::string> skills,
                    std::vector<int> preferences, bool explicitPreferences = true) {
    Candidate value{};
    value.id = id;
    value.name = "Synthetic " + std::to_string(id);
    value.skills = std::move(skills);
    value.cgpa = 8.0;
    value.sector = "IT";
    value.location = "Pune";
    value.submittedPreferences = std::move(preferences);
    value.hasSubmittedPreferences = explicitPreferences;
    return value;
}

Company company(int id, std::set<std::string> skills, int seats,
                std::string sector = "IT", std::string location = "Pune") {
    Company value{};
    value.id = id;
    value.name = "Synthetic opportunity " + std::to_string(id);
    value.requiredSkills = std::move(skills);
    value.seats = seats;
    value.sector = std::move(sector);
    value.location = std::move(location);
    return value;
}

void test_explicit_preferences_ties_trace_and_stability() {
    std::unordered_map<int, Candidate> candidates;
    candidates.emplace(3, candidate(3, {"SQL", "X"}, {20}));
    candidates.emplace(2, candidate(2, {"SQL"}, {10}));
    candidates.emplace(1, candidate(1, {"SQL"}, {20, 10}));

    std::unordered_map<int, Company> companies;
    companies.emplace(10, company(10, {"SQL"}, 1));
    companies.emplace(20, company(20, {"SQL", "X"}, 1));

    Allocator allocator(candidates, companies);
    allocator.buildPreferenceLists();
    assert((allocator.candidates().at(1).preferenceList == std::vector<int>{20, 10}));
    allocator.runAllocation();

    assert(allocator.candidates().at(1).matchedCompany == 10);
    assert(allocator.candidates().at(2).matchedCompany == -1);
    assert(allocator.candidates().at(3).matchedCompany == 20);
    assert(allocator.unmatchedReason(2) == "all_acceptable_opportunities_rejected");
    assert(allocator.validateAllocation().empty());
    assert(allocator.blockingPairs().empty());

    bool sawTieBreak = false;
    bool sawDisplacement = false;
    for (const auto& event : allocator.allocationTrace()) {
        if (event.reasonCode == "higher_priority_equal_score") sawTieBreak = true;
        if (event.type == "displaced") sawDisplacement = true;
    }
    assert(sawTieBreak);
    assert(sawDisplacement);
}

void test_empty_preferences_and_legacy_ranking() {
    std::unordered_map<int, Candidate> candidates;
    candidates.emplace(1, candidate(1, {"SQL"}, {}));
    candidates.emplace(2, candidate(2, {"SQL"}, {}, false));
    std::unordered_map<int, Company> companies;
    companies.emplace(10, company(10, {"SQL"}, 2));

    Allocator allocator(candidates, companies);
    allocator.buildPreferenceLists();
    assert(allocator.candidates().at(1).preferenceList.empty());
    assert((allocator.candidates().at(2).preferenceList == std::vector<int>{10}));
    allocator.runAllocation();
    assert(allocator.candidates().at(1).matchedCompany == -1);
    assert(allocator.unmatchedReason(1) == "no_acceptable_opportunities");
    assert(allocator.candidates().at(2).matchedCompany == 10);
    assert(allocator.validateAllocation().empty());
    assert(allocator.blockingPairs().empty());
}

void test_csv_preferences_and_validation() {
    const auto root = std::filesystem::temp_directory_path() / "sae_phase1_csv_fixture";
    std::filesystem::create_directories(root);
    const auto candidatesPath = root / "candidates.csv";
    const auto companiesPath = root / "companies.csv";
    {
        std::ofstream out(candidatesPath);
        out << "id,name,skills,cgpa,sector,location,preferred_company_ids\n"
            << "1,\"Synthetic, Candidate\",SQL,8.0,IT,Pune,10;20\n";
    }
    {
        std::ofstream out(companiesPath);
        out << "id,name,required_skills,seats,sector,location\n"
            << "10,One,SQL,1,IT,Pune\n"
            << "20,Two,Python,1,IT,Pune\n";
    }
    auto candidates = loadCandidates(candidatesPath.string());
    auto companies = loadCompanies(companiesPath.string());
    assert(candidates.at(1).name == "Synthetic, Candidate");
    assert(candidates.at(1).hasSubmittedPreferences);
    assert((candidates.at(1).submittedPreferences == std::vector<int>{10, 20}));
    Allocator allocator(candidates, companies);
    allocator.buildPreferenceLists();
    assert((allocator.candidates().at(1).preferenceList == std::vector<int>{10, 20}));

    {
        std::ofstream out(candidatesPath);
        out << "id,name,skills,cgpa,sector,location,preferred_company_ids\n"
            << "1,Test,SQL,8.0,IT,Pune,99\n";
    }
    candidates = loadCandidates(candidatesPath.string());
    bool rejectedUnknownPreference = false;
    try {
        Allocator invalid(candidates, companies);
    } catch (const std::invalid_argument&) {
        rejectedUnknownPreference = true;
    }
    assert(rejectedUnknownPreference);

    {
        std::ofstream out(candidatesPath);
        out << "id,name,skills,cgpa,sector,location\n"
            << "1,Test,SQL,11.0,IT,Pune\n";
    }
    bool rejectedInvalidCgpa = false;
    try {
        (void)loadCandidates(candidatesPath.string());
    } catch (const std::runtime_error&) {
        rejectedInvalidCgpa = true;
    }
    assert(rejectedInvalidCgpa);
    std::filesystem::remove_all(root);
}
}

int main() {
    test_explicit_preferences_ties_trace_and_stability();
    test_empty_preferences_and_legacy_ranking();
    test_csv_preferences_and_validation();
}
