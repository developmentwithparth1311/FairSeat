#pragma once

#include <string>

class Allocator;

// Writes read-only explanation data for the RAG assistant.
void exportExplanationData(const Allocator& allocator,
                           const std::string& outputDirectory = "exports",
                           std::size_t topK = 5);
