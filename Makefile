CXX := g++
CXXFLAGS := -std=c++17 -Wall -Wextra -O2 -Iinclude

SRC := $(wildcard src/*.cpp)
OBJ := $(SRC:.cpp=.o)
TARGET := allocator_app
TEST_TARGET := tests/scoring_test
EXPORT_TEST_TARGET := tests/explain_export_test

all: $(TARGET)

$(TARGET): $(OBJ)
	$(CXX) $(CXXFLAGS) -o $@ $^

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@

clean:
	rm -f src/*.o $(TARGET) $(TEST_TARGET) $(EXPORT_TEST_TARGET) results.csv
	rm -rf tests/export_fixture

$(TEST_TARGET): tests/scoring_test.cpp src/scoring.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

test: $(TEST_TARGET)
	./$(TEST_TARGET)
	$(MAKE) $(EXPORT_TEST_TARGET)
	./$(EXPORT_TEST_TARGET)
	python3 tests/validate_export.py

$(EXPORT_TEST_TARGET): tests/explain_export_test.cpp src/allocator.cpp src/scoring.cpp src/explain_export.cpp
	$(CXX) $(CXXFLAGS) -o $@ $^

.PHONY: all clean test
