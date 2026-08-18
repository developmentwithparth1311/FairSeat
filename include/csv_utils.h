#pragma once
#include <string>
#include <vector>
#include <unordered_map>
#include "candidate.h"
#include "company.h"

std::vector<std::string> splitStr(const std::string& s, char delim);

std::unordered_map<int, Candidate> loadCandidates(const std::string& path);

std::unordered_map<int, Company> loadCompanies(const std::string& path);
