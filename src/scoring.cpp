#include "scoring.h"
#include <algorithm>

namespace {
    constexpr double W_SKILL    = 0.5;
    constexpr double W_CGPA     = 0.3;
    constexpr double W_SECTOR   = 0.1;
    constexpr double W_LOCATION = 0.1;
    constexpr double MAX_CGPA   = 10.0;
}

double computeScore(const Candidate& c, const Company& comp) {
    int overlapCount = 0;
    for (const auto& skill : comp.requiredSkills) {
        if (c.skills.count(skill)) overlapCount++;
    }
    double skillScore = comp.requiredSkills.empty()
        ? 1.0
        : static_cast<double>(overlapCount) / comp.requiredSkills.size();

    double cgpaScore = std::min(c.cgpa / MAX_CGPA, 1.0);

    double sectorScore   = (c.sector == comp.sector) ? 1.0 : 0.0;
    double locationScore = (c.location == comp.location) ? 1.0 : 0.0;

    double total = W_SKILL * skillScore
                 + W_CGPA * cgpaScore
                 + W_SECTOR * sectorScore
                 + W_LOCATION * locationScore;

    return total * 100.0;
}
