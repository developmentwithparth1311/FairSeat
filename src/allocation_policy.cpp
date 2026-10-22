#include "allocation_policy.h"

#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <unordered_set>
#include <unordered_map>

namespace {
std::string trim(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

double number(const std::unordered_map<std::string, std::string>& values,
              const std::string& key, double fallback) {
    const auto found = values.find(key);
    if (found == values.end()) return fallback;
    std::size_t used = 0;
    try {
        const double parsed = std::stod(found->second, &used);
        if (used != found->second.size() || !std::isfinite(parsed)) throw std::invalid_argument("invalid");
        return parsed;
    } catch (const std::exception&) {
        throw std::runtime_error("Invalid numeric policy value for " + key);
    }
}

std::string valueOr(const std::unordered_map<std::string, std::string>& values,
                    const std::string& key, const std::string& fallback) {
    const auto found = values.find(key);
    return found == values.end() ? fallback : found->second;
}
}

AllocationPolicy loadAllocationPolicy(const std::string& path) {
    std::ifstream input(path);
    if (!input) throw std::runtime_error("Could not open allocation policy: " + path);
    std::unordered_map<std::string, std::string> values;
    std::string line;
    std::size_t lineNumber = 0;
    while (std::getline(input, line)) {
        ++lineNumber;
        line = trim(line);
        if (line.empty() || line[0] == '#') continue;
        const auto separator = line.find('=');
        if (separator == std::string::npos) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) + ": expected key=value");
        }
        const std::string key = trim(line.substr(0, separator));
        const std::string value = trim(line.substr(separator + 1));
        if (key.empty() || value.empty() || !values.emplace(key, value).second) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) + ": empty or duplicate policy key");
        }
    }

    const std::unordered_set<std::string> supportedKeys = {
        "policy_version", "algorithm", "tie_break", "seat_rule",
        "weight.skills", "weight.cgpa", "weight.sector", "weight.location",
        "requirement.qualifications", "requirement.location", "requirement.sector",
        "exclude_prior_participants"
    };
    for (const auto& [key, value] : values) {
        (void)value;
        if (!supportedKeys.count(key)) throw std::runtime_error("Unknown allocation policy key: " + key);
    }

    AllocationPolicy policy;
    policy.version = valueOr(values, "policy_version", policy.version);
    policy.algorithm = valueOr(values, "algorithm", policy.algorithm);
    policy.tieBreak = valueOr(values, "tie_break", policy.tieBreak);
    policy.seatRule = valueOr(values, "seat_rule", policy.seatRule);
    policy.weights.skills = number(values, "weight.skills", policy.weights.skills);
    policy.weights.cgpa = number(values, "weight.cgpa", policy.weights.cgpa);
    policy.weights.sector = number(values, "weight.sector", policy.weights.sector);
    policy.weights.location = number(values, "weight.location", policy.weights.location);
    policy.qualificationRequirement = valueOr(values, "requirement.qualifications", policy.qualificationRequirement);
    policy.locationRequirement = valueOr(values, "requirement.location", policy.locationRequirement);
    policy.sectorRequirement = valueOr(values, "requirement.sector", policy.sectorRequirement);
    const std::string excludePrior = valueOr(values, "exclude_prior_participants", "false");
    if (excludePrior != "true" && excludePrior != "false") {
        throw std::runtime_error("exclude_prior_participants must be true or false");
    }
    policy.excludePriorParticipants = excludePrior == "true";
    validateAllocationPolicy(policy);
    return policy;
}

void validateAllocationPolicy(const AllocationPolicy& policy) {
    if (policy.version.empty()) throw std::invalid_argument("Policy version is required");
    if (policy.algorithm != "candidate-proposing-deferred-acceptance")
        throw std::invalid_argument("Unsupported allocation algorithm: " + policy.algorithm);
    if (policy.tieBreak != "candidate_id_ascending")
        throw std::invalid_argument("Unsupported tie_break: " + policy.tieBreak);
    if (policy.seatRule != "company_capacity")
        throw std::invalid_argument("Unsupported seat_rule: " + policy.seatRule);
    if (policy.qualificationRequirement != "disabled" && policy.qualificationRequirement != "all_required")
        throw std::invalid_argument("requirement.qualifications must be disabled or all_required");
    if (policy.locationRequirement != "disabled" && policy.locationRequirement != "preferred_locations")
        throw std::invalid_argument("requirement.location must be disabled or preferred_locations");
    if (policy.sectorRequirement != "disabled" && policy.sectorRequirement != "sector_interests")
        throw std::invalid_argument("requirement.sector must be disabled or sector_interests");
    const auto& w = policy.weights;
    if (w.skills < 0.0 || w.cgpa < 0.0 || w.sector < 0.0 || w.location < 0.0 ||
        std::abs(w.skills + w.cgpa + w.sector + w.location - 1.0) > 1e-9) {
        throw std::invalid_argument("Scoring weights must be non-negative and sum to 1");
    }
}
