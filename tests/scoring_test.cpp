#include "scoring.h"

#include <cassert>

int main() {
    Candidate candidate{};
    candidate.skills = {"Python", "SQL"};
    candidate.cgpa = 8.0;
    candidate.sector = "IT";
    candidate.location = "Pune";

    Company company{};
    company.requiredSkills = {"Python", "SQL"};
    company.sector = "IT";
    company.location = "Pune";

    // 50 skill + 24 CGPA + 10 sector + 10 location points.
    assert(computeScore(candidate, company) == 94.0);
}
