#pragma once
#include <string>
#include <set>
#include <queue>
#include <vector>
#include <utility>

struct Company {
    int id;
    std::string name;
    std::set<std::string> requiredSkills;
    int seats;
    std::string sector;
    std::string location;

    std::priority_queue<
        std::pair<double, int>,
        std::vector<std::pair<double, int>>,
        std::greater<std::pair<double, int>>
    > heldSeats;

    int seatsFilled() const { return static_cast<int>(heldSeats.size()); }
    bool hasOpenSeat() const { return seatsFilled() < seats; }
};
