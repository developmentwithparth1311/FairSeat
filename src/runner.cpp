#include "allocator.h"
#include "csv_utils.h"
#include "explain_export.h"

#include <iostream>
#include <stdexcept>
#include <string>

int main(int argc, char** argv) {
    try {
        if (argc == 4 && std::string(argv[1]) == "--validate-only") {
            const auto candidates = loadCandidates(argv[2]);
            const auto companies = loadCompanies(argv[3]);
            std::cout << "{\"candidates\":" << candidates.size()
                      << ",\"companies\":" << companies.size() << "}\n";
            return 0;
        }
        if (argc != 5) {
            std::cerr << "Usage: allocator_runner <candidates.csv> <companies.csv> <export-dir> <policy.conf>\n"
                         "   or: allocator_runner --validate-only <candidates.csv> <companies.csv>\n";
            return 2;
        }
        auto candidates = loadCandidates(argv[1]);
        auto companies = loadCompanies(argv[2]);
        Allocator allocator(candidates, companies, loadAllocationPolicy(argv[4]));
        allocator.buildPreferenceLists();
        allocator.runAllocation();
        exportExplanationData(allocator, argv[3]);
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
