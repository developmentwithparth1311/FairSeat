#pragma once
#include "candidate.h"
#include "company.h"
#include <string>
#include <vector>

struct ScoreBreakdown {
    double skills;
    double cgpa;
    double sector;
    double location;
    double total;
    std::vector<std::string> matchedSkills;
    std::vector<std::string> missingSkills;
};

double computeScore(const Candidate& c, const Company& comp);
ScoreBreakdown scoreBreakdown(const Candidate& c, const Company& comp);
