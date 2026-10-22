#include <iostream>
#include <string>
#include <limits>
#include <memory>
#include "csv_utils.h"
#include "allocator.h"
#include "explain_export.h"

static void printMenu() {
    std::cout << "\n===== PM Internship Stable Allocation Engine =====\n"
              << "1. Load candidates & companies from CSV\n"
              << "2. Build preference lists (scoring + sorting)\n"
              << "3. Run stable allocation\n"
              << "4. View results\n"
              << "5. Export results to CSV\n"
              << "7. Export explanation data for RAG assistant\n"
              << "8. Exit\n"
              << "Choose an option: ";
}

int main() {
    std::unordered_map<int, Candidate> candidates;
    std::unordered_map<int, Company> companies;
    std::unique_ptr<Allocator> allocator;

    bool dataLoaded = false;
    bool prefsBuilt = false;
    bool allocated = false;

    int choice;
    while (true) {
        printMenu();
        if (!(std::cin >> choice)) {
            std::cin.clear();
            std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
            std::cout << "Invalid input.\n";
            continue;
        }

        switch (choice) {
            case 1: {
                std::string candPath, compPath;
                std::cout << "Path to candidates CSV [data/candidates.csv]: ";
                std::cin.ignore();
                std::getline(std::cin, candPath);
                if (candPath.empty()) candPath = "data/candidates.csv";

                std::cout << "Path to companies CSV [data/companies.csv]: ";
                std::getline(std::cin, compPath);
                if (compPath.empty()) compPath = "data/companies.csv";

                try {
                    candidates = loadCandidates(candPath);
                    companies = loadCompanies(compPath);
                    allocator = std::make_unique<Allocator>(
                        candidates, companies, loadAllocationPolicy("config/allocation_policy_v2.conf"));
                    dataLoaded = true;
                    prefsBuilt = false;
                    allocated = false;
                    std::cout << "Loaded " << candidates.size() << " candidates and "
                               << companies.size() << " companies.\n";
                } catch (const std::exception& e) {
                    std::cout << "Error: " << e.what() << "\n";
                }
                break;
            }
            case 2: {
                if (!dataLoaded) { std::cout << "Load data first (option 1).\n"; break; }
                allocator->buildPreferenceLists();
                prefsBuilt = true;
                std::cout << "Preference lists built for all candidates.\n";
                break;
            }
            case 3: {
                if (!prefsBuilt) { std::cout << "Build preference lists first (option 2).\n"; break; }
                allocator->runAllocation();
                allocated = true;
                std::cout << "Allocation complete.\n";
                break;
            }
            case 4: {
                if (!allocated) { std::cout << "Run allocation first (option 3).\n"; break; }
                allocator->printResults();
                break;
            }
            case 5: {
                if (!allocated) { std::cout << "Run allocation first (option 3).\n"; break; }
                std::string outPath;
                std::cout << "Output CSV path [results.csv]: ";
                std::cin.ignore();
                std::getline(std::cin, outPath);
                if (outPath.empty()) outPath = "results.csv";
                allocator->exportResults(outPath);
                break;
            }
            case 7: {
                if (!allocated) { std::cout << "Run allocation first (option 3).\n"; break; }
                try {
                    exportExplanationData(*allocator);
                    std::cout << "Explanation data exported to exports/candidates.json and exports/companies.json.\n";
                } catch (const std::exception& e) {
                    std::cout << "Export error: " << e.what() << "\n";
                }
                break;
            }
            case 8:
                std::cout << "Exiting.\n";
                return 0;
            default:
                std::cout << "Invalid option.\n";
        }
    }
}
