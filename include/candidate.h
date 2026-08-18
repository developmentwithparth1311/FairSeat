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

    std::vector<int> preferenceList;
    size_t nextPrefIdx = 0;  
    int matchedCompany = -1; 
