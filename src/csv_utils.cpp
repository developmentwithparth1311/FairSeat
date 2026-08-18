#include "csv_utils.h"
#include <fstream>
#include <sstream>
#include <iostream>
#include <stdexcept>

std::vector<std::string> splitStr(const std::string& s, char delim) {
    std::vector<std::string> out;
    std::stringstream ss(s);
    std::string item;
    while (std::getline(ss, item, delim)) {
        if (!item.empty()) out.push_back(item);
    }
    return out;
}

static std::string trim(const std::string& s) {
    size_t start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    size_t end = s.find_last_not_of(" \t\r\n");
    return s.substr(start, end - start + 1);
}

std::unordered_map<int, Candidate> loadCandidates(const std::string& path) {
    std::unordered_map<int, Candidate> candidates;
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open candidates file: " + path);
    }

    std::string line;
    bool firstLine = true;
    while (std::getline(file, line)) {
        if (line.empty()) continue;
        if (firstLine) { firstLine = false; continue; } 

        std::stringstream ss(line);
        std::string field;
        std::vector<std::string> fields;
        while (std::getline(ss, field, ',')) fields.push_back(trim(field));

        if (fields.size() < 6) {
            std::cerr << "Skipping malformed candidate row: " << line << "\n";
            continue;
        }

        Candidate c;
        c.id = std::stoi(fields[0]);
        c.name = fields[1];
        for (auto& sk : splitStr(fields[2], ';')) c.skills.insert(trim(sk));
        c.cgpa = std::stod(fields[3]);
        c.sector = fields[4];
        c.location = fields[5];

        candidates[c.id] = c;
    }
    return candidates;
}

std::unordered_map<int, Company> loadCompanies(const std::string& path) {
    std::unordered_map<int, Company> companies;
    std::ifstream file(path);
    if (!file.is_open()) {
        throw std::runtime_error("Could not open companies file: " + path);
    }

    std::string line;
    bool firstLine = true;
    while (std::getline(file, line)) {
        if (line.empty()) continue;
        if (firstLine) { firstLine = false; continue; }

        std::stringstream ss(line);
        std::string field;
        std::vector<std::string> fields;
        while (std::getline(ss, field, ',')) fields.push_back(trim(field));

        if (fields.size() < 6) {
            std::cerr << "Skipping malformed company row: " << line << "\n";
            continue;
        }

        Company comp;
        comp.id = std::stoi(fields[0]);
        comp.name = fields[1];
        for (auto& sk : splitStr(fields[2], ';')) comp.requiredSkills.insert(trim(sk));
        comp.seats = std::stoi(fields[3]);
        comp.sector = fields[4];
        comp.location = fields[5];

        companies[comp.id] = comp;
    }
    return companies;
}
