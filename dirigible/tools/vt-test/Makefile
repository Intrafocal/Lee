# Host-side tests for firmware/main/vt.cpp.
#
# VtScreen is pure logic with no LVGL or IDF dependency, which makes it the one
# part of the firmware that can be tested without a T-Deck on the desk.  The
# cases here are the ones that actually broke on-device: UTF-8 folded at the
# byte level (three blank cells per box-drawing rule), private CSI sequences
# mistaken for their non-private finals, and reverse-video selection bars
# trimmed away as trailing blanks.
#
#   make && ./vt_test

VT_DIR := ../../firmware/main

vt_test: vt_test.cpp $(VT_DIR)/vt.cpp $(VT_DIR)/vt.hpp
	c++ -std=c++17 -Wall -Wextra -I$(VT_DIR) -o $@ vt_test.cpp $(VT_DIR)/vt.cpp

.PHONY: check clean
check: vt_test
	./vt_test

clean:
	rm -f vt_test
