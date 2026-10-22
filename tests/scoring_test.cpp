#include "scoring.h"

#include <cassert>
#include <cmath>

int main() {
    Candidate candidate{};
    candidate.skills = {" Python ", "SQL"};
    candidate.cgpa = 8.0;
    candidate.sector = "IT";
    candidate.location = "Pune";

    Company company{};
    company.requiredSkills = {"python", " SQL "};
    company.sector = "IT";
    company.location = "Pune";

    // 50 skill + 24 CGPA + 10 sector + 10 location points.
    const ScoreBreakdown breakdown = scoreBreakdown(candidate, company);
    assert(breakdown.total == computeScore(candidate, company));
    assert(std::abs(breakdown.total - 94.0) < 1e-9);
    assert(std::abs((breakdown.skills + breakdown.cgpa + breakdown.sector + breakdown.location)
                    - breakdown.total) < 1e-9);
    assert((breakdown.matchedSkills == std::vector<std::string>{"python", "sql"}));
    assert(breakdown.missingSkills.empty());

    candidate.preferredLocations = {"Delhi"};
    candidate.sectorInterests = {"Design"};
    const auto preferenceAware = scoreBreakdown(candidate, company);
    assert(std::abs(preferenceAware.location) < 1e-9);
    assert(std::abs(preferenceAware.sector) < 1e-9);
    candidate.preferredLocations = {"Pune"};
    candidate.sectorInterests = {"IT"};
    const ScoreWeights skillHeavy{0.70, 0.10, 0.10, 0.10};
    assert(std::abs(computeScore(candidate, company, skillHeavy) - 98.0) < 1e-9);

    Candidate partial{};
    partial.cgpa = 8.0;
    partial.sector = "Finance";
    partial.location = "Pune";
    Company other{};
    other.requiredSkills = {"SQL", "Java"};
    other.sector = "IT";
    other.location = "Pune";
    const auto partialBreakdown = scoreBreakdown(partial, other);
    assert(partialBreakdown.total == computeScore(partial, other));
    assert(std::abs(partialBreakdown.total - 34.0) < 1e-9);
    assert((partialBreakdown.missingSkills == std::vector<std::string>{"java", "sql"}));
}
