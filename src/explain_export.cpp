#include "explain_export.h"

#include "allocator.h"
#include "scoring.h"

#include <algorithm>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace {
std::string jsonEscape(const std::string& value) {
    std::ostringstream escaped;
    for (unsigned char ch : value) {
        switch (ch) {
            case '"': escaped << "\\\""; break;
            case '\\': escaped << "\\\\"; break;
            case '\b': escaped << "\\b"; break;
            case '\f': escaped << "\\f"; break;
            case '\n': escaped << "\\n"; break;
            case '\r': escaped << "\\r"; break;
            case '\t': escaped << "\\t"; break;
            default:
                if (ch < 0x20) {
                    escaped << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                            << static_cast<int>(ch) << std::dec << std::setfill(' ');
                } else {
                    escaped << static_cast<char>(ch);
                }
        }
    }
    return escaped.str();
}

void writeString(std::ostream& out, const std::string& value) {
    out << '"' << jsonEscape(value) << '"';
}

void writeStringArray(std::ostream& out, const std::vector<std::string>& values) {
    out << '[';
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i) out << ", ";
        writeString(out, values[i]);
    }
    out << ']';
}

std::string generatedAtUtc() {
    const std::time_t now = std::time(nullptr);
    std::tm utc{};
#if defined(_WIN32)
    gmtime_s(&utc, &now);
#else
    gmtime_r(&now, &utc);
#endif
    std::ostringstream out;
    out << std::put_time(&utc, "%Y-%m-%dT%H:%M:%SZ");
    return out.str();
}

std::vector<std::string> skills(const std::set<std::string>& values) {
    return {values.begin(), values.end()};
}
}

void exportExplanationData(const Allocator& allocator,
                           const std::string& outputDirectory,
                           std::size_t topK) {
    namespace fs = std::filesystem;
    fs::create_directories(outputDirectory);
    const auto candidatesPath = fs::path(outputDirectory) / "candidates.json";
    const auto companiesPath = fs::path(outputDirectory) / "companies.json";
    std::ofstream candidateOut(candidatesPath);
    std::ofstream companyOut(companiesPath);
    if (!candidateOut || !companyOut) {
        throw std::runtime_error("Could not create explanation export files in " + outputDirectory);
    }

    candidateOut.imbue(std::locale::classic());
    companyOut.imbue(std::locale::classic());
    candidateOut << std::fixed << std::setprecision(1);
    companyOut << std::fixed << std::setprecision(1);
    const auto& policy = allocator.policy();
    candidateOut << "{\n  \"schema_version\": 3,\n  \"policy_version\": ";
    writeString(candidateOut, policy.version);
    candidateOut << ",\n  \"algorithm\": ";
    writeString(candidateOut, policy.algorithm);
    candidateOut << ",\n  \"policy_rules\": {\"qualification_requirement\": ";
    writeString(candidateOut, policy.qualificationRequirement);
    candidateOut << ", \"location_requirement\": ";
    writeString(candidateOut, policy.locationRequirement);
    candidateOut << ", \"sector_requirement\": ";
    writeString(candidateOut, policy.sectorRequirement);
    candidateOut << ", \"exclude_prior_participants\": " << (policy.excludePriorParticipants ? "true" : "false") << "},\n"
                    "  \"tie_break_policy\": \"candidate order: submitted list, otherwise score descending then company ID ascending; company order: score descending then candidate ID ascending\",\n"
                    "  \"generated_at\": ";
    writeString(candidateOut, generatedAtUtc());
    const auto& graph = allocator.preferenceGraph();
    const auto& metrics = allocator.operationCounts();
    candidateOut << ",\n  \"graph\": {\"candidate_vertices\": " << graph.candidateIds.size()
                 << ", \"company_vertices\": " << graph.companyIds.size()
                 << ", \"acceptable_edges\": " << graph.edgeCount
                 << ", \"density\": " << graph.density << "},\n"
                    "  \"operation_counts\": {\"score_evaluations\": " << metrics.scoreEvaluations
                 << ", \"score_cache_hits\": " << metrics.scoreCacheHits
                 << ", \"preference_sort_comparisons\": " << metrics.preferenceSortComparisons
                 << ", \"queue_pushes\": " << metrics.queuePushes
                 << ", \"queue_pops\": " << metrics.queuePops
                 << ", \"proposals\": " << metrics.proposals
                 << ", \"company_rank_comparisons\": " << metrics.companyRankComparisons
                 << ", \"seat_heap_pushes\": " << metrics.seatHeapPushes
                 << ", \"seat_heap_pops\": " << metrics.seatHeapPops
                 << ", \"displacements\": " << metrics.displacements
                 << ", \"rejections\": " << metrics.rejections << "},\n"
                    "  \"scoring_weights\": {\"skills\": ";
    candidateOut << policy.weights.skills << ", \"cgpa\": " << policy.weights.cgpa
                 << ", \"sector\": " << policy.weights.sector << ", \"location\": " << policy.weights.location
                 << "},\n  \"candidates\": [\n";

    std::vector<int> candidateIds;
    for (const auto& entry : allocator.candidates()) candidateIds.push_back(entry.first);
    std::sort(candidateIds.begin(), candidateIds.end());
    for (std::size_t ci = 0; ci < candidateIds.size(); ++ci) {
        if (ci) candidateOut << ",\n";
        const Candidate& candidate = allocator.candidates().at(candidateIds[ci]);
        candidateOut << "    {\"id\": ";
        writeString(candidateOut, std::to_string(candidate.id));
        candidateOut << ", \"name\": ";
        writeString(candidateOut, candidate.name);
        candidateOut << ", \"skills\": ";
        writeStringArray(candidateOut, skills(candidate.skills));
        candidateOut << ", \"cgpa\": " << candidate.cgpa << ", \"sector\": ";
        writeString(candidateOut, candidate.sector);
        candidateOut << ", \"location\": ";
        writeString(candidateOut, candidate.location);
        candidateOut << ", \"qualifications\": ";
        writeStringArray(candidateOut, skills(candidate.qualifications));
        candidateOut << ", \"preferred_locations\": ";
        writeStringArray(candidateOut, candidate.preferredLocations);
        candidateOut << ", \"sector_interests\": ";
        writeStringArray(candidateOut, candidate.sectorInterests);
        candidateOut << ", \"allocation\": {\"status\": ";
        const bool matched = candidate.matchedCompany != -1;
        writeString(candidateOut, matched ? "matched" : "unmatched");
        if (matched) {
            const auto rankIt = std::find(candidate.preferenceList.begin(), candidate.preferenceList.end(), candidate.matchedCompany);
            const std::size_t rank = static_cast<std::size_t>(rankIt - candidate.preferenceList.begin()) + 1;
            candidateOut << ", \"company_id\": ";
            writeString(candidateOut, std::to_string(candidate.matchedCompany));
            candidateOut << ", \"preference_rank\": " << rank
                         << ", \"score\": " << allocator.scoreFor(candidate.id, candidate.matchedCompany);
        }
        if (!matched) {
            candidateOut << ", \"reason_code\": ";
            writeString(candidateOut, allocator.unmatchedReason(candidate.id));
        }
        candidateOut << "}, \"top_choices\": [";

        const auto count = candidate.preferenceList.size();
        std::size_t emitted = 0;
        for (std::size_t pi = 0; pi < count; ++pi) {
            const int companyId = candidate.preferenceList[pi];
            if (pi >= topK && (!matched || companyId != candidate.matchedCompany)) continue;
            const Company& company = allocator.companies().at(companyId);
            const ScoreBreakdown breakdown = scoreBreakdown(candidate, company, policy.weights);
            const auto cutoff = allocator.cutoffFor(companyId);
            std::string outcome;
            if (companyId == candidate.matchedCompany) outcome = "matched";
            else if (matched && pi > static_cast<std::size_t>(std::find(candidate.preferenceList.begin(), candidate.preferenceList.end(), candidate.matchedCompany) - candidate.preferenceList.begin())) outcome = "not_reached";
            else if (cutoff && !allocator.companyWouldPrefer(companyId, breakdown.total, candidate.id)) outcome = "lost_seat";
            else outcome = "not_reached";

            if (emitted++) candidateOut << ", ";
            candidateOut << "{\"company_id\": ";
            writeString(candidateOut, std::to_string(company.id));
            candidateOut << ", \"company_name\": ";
            writeString(candidateOut, company.name);
            candidateOut << ", \"preference_rank\": " << (pi + 1)
                         << ", \"breakdown\": {\"skills\": " << breakdown.skills
                         << ", \"cgpa\": " << breakdown.cgpa
                         << ", \"sector\": " << breakdown.sector
                         << ", \"location\": " << breakdown.location
                         << ", \"total\": " << breakdown.total << "}, \"matched_skills\": ";
            writeStringArray(candidateOut, breakdown.matchedSkills);
            candidateOut << ", \"missing_skills\": ";
            writeStringArray(candidateOut, breakdown.missingSkills);
            candidateOut << ", \"outcome\": ";
            writeString(candidateOut, outcome);
            candidateOut << ", \"reason_code\": ";
            if (outcome == "matched") writeString(candidateOut, "assigned_by_allocator");
            else if (outcome == "lost_seat") writeString(candidateOut, "seat_held_by_higher_company_priority");
            else if (matched) writeString(candidateOut, "lower_than_final_assignment_preference");
            else writeString(candidateOut, "not_selected_by_company_priority");
            candidateOut << ", \"company_cutoff_score\": ";
            if (!cutoff) candidateOut << "null";
            else candidateOut << *cutoff;
            candidateOut << '}';
        }
        candidateOut << "]}";
    }
    candidateOut << "\n  ],\n  \"allocation_trace\": [";
    const auto& trace = allocator.allocationTrace();
    for (std::size_t i = 0; i < trace.size(); ++i) {
        if (i) candidateOut << ",";
        const auto& event = trace[i];
        candidateOut << "\n    {\"sequence\": " << event.sequence << ", \"type\": ";
        writeString(candidateOut, event.type);
        candidateOut << ", \"candidate_id\": ";
        writeString(candidateOut, std::to_string(event.candidateId));
        candidateOut << ", \"company_id\": ";
        if (event.companyId < 0) candidateOut << "null";
        else writeString(candidateOut, std::to_string(event.companyId));
        candidateOut << ", \"score\": " << event.score << ", \"displaced_candidate_id\": ";
        if (event.displacedCandidateId < 0) candidateOut << "null";
        else writeString(candidateOut, std::to_string(event.displacedCandidateId));
        candidateOut << ", \"reason_code\": ";
        writeString(candidateOut, event.reasonCode);
        candidateOut << '}';
    }
    if (!trace.empty()) candidateOut << '\n' << "  ";
    candidateOut << "]\n}\n";

    std::vector<int> companyIds;
    for (const auto& entry : allocator.companies()) companyIds.push_back(entry.first);
    std::sort(companyIds.begin(), companyIds.end());
    companyOut << "{\n  \"schema_version\": 3,\n  \"companies\": [\n";
    for (std::size_t i = 0; i < companyIds.size(); ++i) {
        if (i) companyOut << ",\n";
        const Company& company = allocator.companies().at(companyIds[i]);
        const auto cutoff = allocator.cutoffFor(company.id);
        companyOut << "    {\"id\": ";
        writeString(companyOut, std::to_string(company.id));
        companyOut << ", \"name\": ";
        writeString(companyOut, company.name);
        companyOut << ", \"required_skills\": ";
        writeStringArray(companyOut, skills(company.requiredSkills));
        companyOut << ", \"seats\": " << company.seats
                   << ", \"seats_filled\": " << company.seatsFilled() << ", \"required_qualifications\": ";
        writeStringArray(companyOut, skills(company.requiredQualifications));
        companyOut << ", \"sector\": ";
        writeString(companyOut, company.sector);
        companyOut << ", \"location\": ";
        writeString(companyOut, company.location);
        companyOut << ", \"cutoff_score\": ";
        if (!cutoff) companyOut << "null";
        else companyOut << *cutoff;
        companyOut << '}';
    }
    companyOut << "\n  ]\n}\n";
}
