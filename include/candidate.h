#pragma once
#include <string>
#include <set>
#include <vector>
#include <optional>

struct Candidate {
    int id;
    std::string name;
    std::set<std::string> skills;
    double cgpa;         
    std::string sector;    
    std::string location;   

    std::set<std::string> qualifications;
    std::vector<std::string> preferredLocations;
    std::vector<std::string> sectorInterests;
    std::optional<bool> priorParticipation;
    std::size_t eligibilityFilteredCount = 0;

    std::vector<int> submittedPreferences;
    bool hasSubmittedPreferences = false;
    std::vector<int> preferenceList;
    size_t nextPrefIdx = 0;  
    int matchedCompany = -1; 
};
