#pragma once
#include <string>
#include <set>
#include <queue>
#include <vector>
#include <utility>

struct WeakerSeatHolderFirst {
    bool operator()(const std::pair<double, int>& left,
                    const std::pair<double, int>& right) const {
        // Higher score is stronger; for equal scores, lower candidate ID wins.
        // priority_queue places the weakest holder at top for O(1) inspection.
        if (left.first != right.first) return left.first > right.first;
        return left.second < right.second;
    }
};

struct Company {
    int id;
    std::string name;
    std::set<std::string> requiredSkills;
    std::set<std::string> requiredQualifications;
    int seats;
    std::string sector;
    std::string location;

    std::priority_queue<
        std::pair<double, int>,
        std::vector<std::pair<double, int>>,
        WeakerSeatHolderFirst
    > heldSeats;

    int seatsFilled() const { return static_cast<int>(heldSeats.size()); }
    bool hasOpenSeat() const { return seatsFilled() < seats; }
};
