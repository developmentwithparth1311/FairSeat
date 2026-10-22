#pragma once
#include <string>
#include <set>
#include <vector>

struct Candidate {
    int id;
    std::string name;
    std::set<std::string> skills;
    double cgpa;         
    std::string sector;    
    std::string location;   

    // If present in input, this is the candidate's ordered acceptable list.
    // An empty explicit list means the candidate has no acceptable options.
    std::vector<int> submittedPreferences;
    bool hasSubmittedPreferences = false;
    std::vector<int> preferenceList;
    size_t nextPrefIdx = 0;  
    int matchedCompany = -1; 
};
