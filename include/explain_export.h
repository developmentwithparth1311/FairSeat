#pragma once

#include <string>

class Allocator;

void exportExplanationData(const Allocator& allocator,
                           const std::string& outputDirectory = "exports",
                           std::size_t topK = 5);
