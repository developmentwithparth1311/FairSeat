#include "allocator.h"
#include "explain_export.h"

#include <cassert>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <unordered_map>

int main() {
    std::filesystem::create_directories("tests/export_fixture");
    std::unordered_map<int, Candidate> candidates;
    Candidate candidate{};
    candidate.id = 1;
    candidate.name = "A \"Candidate\"\\";
    candidate.skills = {"SQL"};
    candidate.cgpa = 8.0;
    candidate.sector = "IT";
    candidate.location = "Pune";
    candidates.emplace(candidate.id, candidate);

    std::unordered_map<int, Company> companies;
    Company preferred{};
    preferred.id = 10;
    preferred.name = "Preferred \"Co\"";
    preferred.requiredSkills = {"sql"};
    preferred.seats = 1;
    preferred.sector = "IT";
    preferred.location = "Pune";
    companies.emplace(preferred.id, preferred);

    Company open{};
    open.id = 20;
    open.name = "Open Co";
    open.requiredSkills = {"Python"};
    open.seats = 2;
    open.sector = "Design";
    open.location = "Delhi";
    companies.emplace(open.id, open);

    Allocator allocator(candidates, companies);
    allocator.buildPreferenceLists();
    allocator.runAllocation();
    const auto matchedBefore = allocator.candidates().at(1).matchedCompany;
    const auto preferredHoldersBefore = allocator.companies().at(10).heldSeats.size();
    const auto openHoldersBefore = allocator.companies().at(20).heldSeats.size();
    const auto preferredTopBefore = allocator.companies().at(10).heldSeats.top();

    allocator.exportResults("tests/export_fixture/results_before.csv");
    exportExplanationData(allocator, "tests/export_fixture", 1);
    allocator.exportResults("tests/export_fixture/results_after.csv");

    std::ifstream beforeFile("tests/export_fixture/results_before.csv");
    std::ifstream afterFile("tests/export_fixture/results_after.csv");
    const std::string before((std::istreambuf_iterator<char>(beforeFile)), {});
    const std::string after((std::istreambuf_iterator<char>(afterFile)), {});
    assert(before == after);

    assert(allocator.candidates().at(1).matchedCompany == matchedBefore);
    assert(allocator.companies().at(10).heldSeats.size() == preferredHoldersBefore);
    assert(allocator.companies().at(20).heldSeats.size() == openHoldersBefore);
    assert(allocator.companies().at(10).heldSeats.top() == preferredTopBefore);
    assert(allocator.cutoffFor(10).has_value());
    assert(!allocator.cutoffFor(20).has_value());
    assert(std::abs(allocator.scoreFor(1, 10) - preferredTopBefore.first) < 1e-9);
}
