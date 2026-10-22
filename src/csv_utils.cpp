#include "csv_utils.h"

#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <unordered_set>

namespace {
std::string trim(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

std::vector<std::string> parseCsvRow(const std::string& line,
                                     const std::string& path,
                                     std::size_t lineNumber) {
    std::vector<std::string> fields;
    std::string field;
    bool quoted = false;
    for (std::size_t i = 0; i < line.size(); ++i) {
        const char ch = line[i];
        if (ch == '"') {
            if (quoted && i + 1 < line.size() && line[i + 1] == '"') {
                field.push_back('"');
                ++i;
            } else {
                quoted = !quoted;
            }
        } else if (ch == ',' && !quoted) {
            fields.push_back(trim(field));
            field.clear();
        } else {
            field.push_back(ch);
        }
    }
    if (quoted) {
        throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                 ": unterminated quoted CSV field");
    }
    fields.push_back(trim(field));
    return fields;
}

std::vector<std::string> readHeader(std::ifstream& file,
                                    const std::string& path) {
    std::string line;
    if (!std::getline(file, line)) {
        throw std::runtime_error("CSV file is empty: " + path);
    }
    auto header = parseCsvRow(line, path, 1);
    if (!header.empty() && header[0].size() >= 3 &&
        static_cast<unsigned char>(header[0][0]) == 0xEF &&
        static_cast<unsigned char>(header[0][1]) == 0xBB &&
        static_cast<unsigned char>(header[0][2]) == 0xBF) {
        header[0].erase(0, 3);
    }
    return header;
}

void requireHeader(const std::vector<std::string>& actual,
                   const std::vector<std::string>& expected,
                   const std::string& path) {
    if (actual != expected) {
        std::ostringstream message;
        message << "Unexpected CSV header in " << path << ". Expected: ";
        for (std::size_t i = 0; i < expected.size(); ++i) {
            if (i) message << ',';
            message << expected[i];
        }
        throw std::runtime_error(message.str());
    }
}

int parseInt(const std::string& field, const std::string& name,
             const std::string& path, std::size_t lineNumber) {
    try {
        std::size_t used = 0;
        const int value = std::stoi(field, &used);
        if (used != field.size()) throw std::invalid_argument("trailing data");
        return value;
    } catch (const std::exception&) {
        throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                 ": invalid integer for " + name + ": " + field);
    }
}

double parseCgpa(const std::string& field, const std::string& path,
                 std::size_t lineNumber) {
    try {
        std::size_t used = 0;
        const double value = std::stod(field, &used);
        if (used != field.size() || !std::isfinite(value) || value < 0.0 || value > 10.0) {
            throw std::invalid_argument("outside 0..10");
        }
        return value;
    } catch (const std::exception&) {
        throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                 ": CGPA must be a finite value from 0 to 10");
    }
}

std::vector<int> parsePreferences(const std::string& field,
                                  const std::string& path,
                                  std::size_t lineNumber) {
    std::vector<int> preferences;
    std::unordered_set<int> seen;
    if (trim(field).empty()) return preferences;
    std::size_t start = 0;
    while (start <= field.size()) {
        const std::size_t separator = field.find(';', start);
        const std::string item = trim(field.substr(start,
            separator == std::string::npos ? std::string::npos : separator - start));
        if (item.empty()) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": empty company ID in preferred_company_ids");
        }
        const int id = parseInt(item, "preferred_company_ids", path, lineNumber);
        if (!seen.insert(id).second) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": duplicate company ID in preferred_company_ids: " + item);
        }
        preferences.push_back(id);
        if (separator == std::string::npos) break;
        start = separator + 1;
    }
    return preferences;
}

std::vector<std::string> splitSkills(const std::string& value) {
    std::vector<std::string> result;
    std::stringstream stream(value);
    std::string skill;
    while (std::getline(stream, skill, ';')) {
        skill = trim(skill);
        if (!skill.empty()) result.push_back(skill);
    }
    return result;
}
}

std::vector<std::string> splitStr(const std::string& s, char delim) {
    std::vector<std::string> out;
    std::stringstream stream(s);
    std::string item;
    while (std::getline(stream, item, delim)) {
        item = trim(item);
        if (!item.empty()) out.push_back(item);
    }
    return out;
}

std::unordered_map<int, Candidate> loadCandidates(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open candidates file: " + path);
    }

    const auto header = readHeader(file, path);
    const std::vector<std::string> v1Header = {
        "id", "name", "skills", "cgpa", "sector", "location"
    };
    const std::vector<std::string> v2Header = {
        "id", "name", "skills", "cgpa", "sector", "location", "preferred_company_ids"
    };
    const bool hasPreferences = header == v2Header;
    if (!hasPreferences) requireHeader(header, v1Header, path);

    std::unordered_map<int, Candidate> candidates;
    std::string line;
    std::size_t lineNumber = 1;
    while (std::getline(file, line)) {
        ++lineNumber;
        if (trim(line).empty()) continue;
        const auto fields = parseCsvRow(line, path, lineNumber);
        if (fields.size() != header.size()) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": expected " + std::to_string(header.size()) +
                                     " fields but found " + std::to_string(fields.size()));
        }

        Candidate candidate{};
        candidate.id = parseInt(fields[0], "id", path, lineNumber);
        if (candidate.id < 0) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": candidate ID must be non-negative");
        }
        candidate.name = fields[1];
        if (candidate.name.empty()) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": candidate name is required");
        }
        for (const auto& skill : splitSkills(fields[2])) candidate.skills.insert(skill);
        candidate.cgpa = parseCgpa(fields[3], path, lineNumber);
        candidate.sector = fields[4];
        candidate.location = fields[5];
        candidate.hasSubmittedPreferences = hasPreferences;
        if (hasPreferences) {
            candidate.submittedPreferences = parsePreferences(fields[6], path, lineNumber);
        }
        if (!candidates.emplace(candidate.id, std::move(candidate)).second) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": duplicate candidate ID");
        }
    }
    if (candidates.empty()) throw std::runtime_error("No candidate records found in " + path);
    return candidates;
}

std::unordered_map<int, Company> loadCompanies(const std::string& path) {
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open companies file: " + path);
    }
    const std::vector<std::string> expectedHeader = {
        "id", "name", "required_skills", "seats", "sector", "location"
    };
    requireHeader(readHeader(file, path), expectedHeader, path);

    std::unordered_map<int, Company> companies;
    std::string line;
    std::size_t lineNumber = 1;
    while (std::getline(file, line)) {
        ++lineNumber;
        if (trim(line).empty()) continue;
        const auto fields = parseCsvRow(line, path, lineNumber);
        if (fields.size() != expectedHeader.size()) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": expected " + std::to_string(expectedHeader.size()) +
                                     " fields but found " + std::to_string(fields.size()));
        }

        Company company{};
        company.id = parseInt(fields[0], "id", path, lineNumber);
        if (company.id < 0) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": company ID must be non-negative");
        }
        company.name = fields[1];
        if (company.name.empty()) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": company name is required");
        }
        for (const auto& skill : splitSkills(fields[2])) company.requiredSkills.insert(skill);
        company.seats = parseInt(fields[3], "seats", path, lineNumber);
        if (company.seats <= 0) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": company seats must be greater than zero");
        }
        company.sector = fields[4];
        company.location = fields[5];
        if (!companies.emplace(company.id, std::move(company)).second) {
            throw std::runtime_error(path + ":" + std::to_string(lineNumber) +
                                     ": duplicate company ID");
        }
    }
    if (companies.empty()) throw std::runtime_error("No company records found in " + path);

    return companies;
}
