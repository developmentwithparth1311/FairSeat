#include "scoring.h"
#include <algorithm>
#include <cctype>
#include <string>

namespace {
    constexpr double MAX_CGPA   = 10.0;
}

namespace {
    std::string normalizeSkill(const std::string& value) {
        auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char ch) {
            return std::isspace(ch) != 0;
        });
        auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char ch) {
            return std::isspace(ch) != 0;
        }).base();
        if (first >= last) return {};

        std::string normalized(first, last);
        std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](unsigned char ch) {
            return static_cast<char>(std::tolower(ch));
        });
        return normalized;
    }
}

ScoreBreakdown scoreBreakdown(const Candidate& c, const Company& comp,
                              const ScoreWeights& weights) {
    int overlapCount = 0;
    std::vector<std::string> candidateSkills;
    candidateSkills.reserve(c.skills.size());
    for (const auto& skill : c.skills) {
        const auto normalized = normalizeSkill(skill);
        if (!normalized.empty()) candidateSkills.push_back(normalized);
    }

    ScoreBreakdown result{};
    for (const auto& skill : comp.requiredSkills) {
        const auto normalized = normalizeSkill(skill);
        const auto match = std::find(candidateSkills.begin(), candidateSkills.end(), normalized);
        if (!normalized.empty() && match != candidateSkills.end()) {
            ++overlapCount;
            result.matchedSkills.push_back(normalized);
        } else if (!normalized.empty()) {
            result.missingSkills.push_back(normalized);
        }
    }
    std::sort(result.matchedSkills.begin(), result.matchedSkills.end());
    std::sort(result.missingSkills.begin(), result.missingSkills.end());

    double skillScore = comp.requiredSkills.empty()
        ? 1.0
        : static_cast<double>(overlapCount) / comp.requiredSkills.size();

    double cgpaScore = std::min(c.cgpa / MAX_CGPA, 1.0);

    const bool sectorMatch = c.sectorInterests.empty()
        ? c.sector == comp.sector
        : std::find(c.sectorInterests.begin(), c.sectorInterests.end(), comp.sector) != c.sectorInterests.end();
    const bool locationMatch = c.preferredLocations.empty()
        ? c.location == comp.location
        : std::find(c.preferredLocations.begin(), c.preferredLocations.end(), comp.location) != c.preferredLocations.end();
    double sectorScore = sectorMatch ? 1.0 : 0.0;
    double locationScore = locationMatch ? 1.0 : 0.0;

    result.skills = weights.skills * skillScore * 100.0;
    result.cgpa = weights.cgpa * cgpaScore * 100.0;
    result.sector = weights.sector * sectorScore * 100.0;
    result.location = weights.location * locationScore * 100.0;
    result.total = (weights.skills * skillScore
                  + weights.cgpa * cgpaScore
                  + weights.sector * sectorScore
                  + weights.location * locationScore) * 100.0;
    return result;
}

double computeScore(const Candidate& c, const Company& comp, const ScoreWeights& weights) {
    return scoreBreakdown(c, comp, weights).total;
}
