#pragma once

#include <string>

struct ScoreWeights {
    double skills = 0.50;
    double cgpa = 0.30;
    double sector = 0.10;
    double location = 0.10;
};

struct AllocationPolicy {
    std::string version = "prototype-score-v2";
    std::string algorithm = "candidate-proposing-deferred-acceptance";
    std::string tieBreak = "candidate_id_ascending";
    std::string seatRule = "company_capacity";
    ScoreWeights weights;
    std::string qualificationRequirement = "disabled";
    std::string locationRequirement = "disabled";
    std::string sectorRequirement = "disabled";
    bool excludePriorParticipants = false;
};

AllocationPolicy loadAllocationPolicy(const std::string& path);
void validateAllocationPolicy(const AllocationPolicy& policy);
