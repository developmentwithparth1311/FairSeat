CXX := g++
CXXFLAGS := -std=c++17 -Wall -Wextra -O2 -Iinclude

SRC := $(filter-out src/runner.cpp,$(wildcard src/*.cpp))
OBJ := $(SRC:.cpp=.o)
TARGET := allocator_app
TEST_TARGET := tests/scoring_test
EXPORT_TEST_TARGET := tests/explain_export_test
ALLOCATOR_TEST_TARGET := tests/allocator_test
BENCHMARK_TARGET := benchmarks/allocator_benchmark
PHASE3_TARGET := tools/phase3_scenarios
RUNNER_TARGET := allocator_runner

all: $(TARGET) $(RUNNER_TARGET)

$(TARGET): $(OBJ)
	$(CXX) $(CXXFLAGS) -o $@ $^

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@

clean:
	rm -f src/*.o $(TARGET) $(TEST_TARGET) $(EXPORT_TEST_TARGET) $(ALLOCATOR_TEST_TARGET) results.csv
	rm -f $(BENCHMARK_TARGET)
	rm -f $(PHASE3_TARGET)
	rm -f $(RUNNER_TARGET)
	rm -rf tests/export_fixture

$(TEST_TARGET): tests/scoring_test.cpp src/scoring.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

test: $(TEST_TARGET)
	./$(TEST_TARGET)
	$(MAKE) $(ALLOCATOR_TEST_TARGET)
	./$(ALLOCATOR_TEST_TARGET)
	$(MAKE) $(EXPORT_TEST_TARGET)
	./$(EXPORT_TEST_TARGET)
	python3 tests/validate_export.py

$(EXPORT_TEST_TARGET): tests/explain_export_test.cpp src/allocator.cpp src/scoring.cpp src/explain_export.cpp src/allocation_policy.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

$(ALLOCATOR_TEST_TARGET): tests/allocator_test.cpp src/allocator.cpp src/scoring.cpp src/csv_utils.cpp src/allocation_policy.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

$(BENCHMARK_TARGET): benchmarks/allocator_benchmark.cpp src/allocator.cpp src/scoring.cpp src/allocation_policy.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

$(PHASE3_TARGET): tools/phase3_scenarios.cpp src/allocator.cpp src/scoring.cpp src/allocation_policy.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

$(RUNNER_TARGET): src/runner.cpp src/allocator.cpp src/csv_utils.cpp src/scoring.cpp src/explain_export.cpp src/allocation_policy.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

benchmark: $(BENCHMARK_TARGET)
	./$(BENCHMARK_TARGET) 1000 50 0.25 42

phase3-report: $(PHASE3_TARGET)
	./$(PHASE3_TARGET) 400 24 25033

.PHONY: all clean test benchmark phase3-report
