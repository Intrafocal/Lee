# Host-side tests for dirigible/core/src/markdown.cpp, the markdown reader the
# viewer uses.  It has no LVGL or IDF dependency, so tables, lists and inline
# styling can be checked on a laptop.
#
#   make check

CORE := ../../core

md_test: md_test.cpp $(CORE)/src/markdown.cpp $(CORE)/include/dirigible/markdown.hpp
	c++ -std=c++17 -O1 -Wall -Wextra -I$(CORE)/include -o $@ md_test.cpp $(CORE)/src/markdown.cpp

.PHONY: check clean
check: md_test
	./md_test

clean:
	rm -f md_test
