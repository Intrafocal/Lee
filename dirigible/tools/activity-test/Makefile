# Host-side tests for the Cockpit-design ports in dirigible/core:
# describe_activity (the table in electron/src/shared/cockpit.ts), the token
# label, Work's headline, the snapshot's agents[] / limits / deep, and
# Tether (GET /tether, /tether/pages, the /tether/send body).  cJSON comes from ESP-IDF's copy, so the firmware and the test
# parse with the same library.
#
#   make check                      (IDF_PATH defaults to ~/Development/hardware/esp-idf)

CORE     := ../../core
IDF_PATH ?= $(HOME)/Development/hardware/esp-idf
CJSON    := $(IDF_PATH)/components/json/cJSON

SRCS := activity_test.cpp $(CORE)/src/activity.cpp $(CORE)/src/attention.cpp $(CORE)/src/tether.cpp

activity_test: $(SRCS) $(CORE)/include/dirigible/activity.hpp $(CORE)/include/dirigible/attention.hpp $(CORE)/include/dirigible/tether.hpp cJSON.o
	c++ -std=c++17 -O1 -Wall -Wextra -I$(CORE)/include -I$(CJSON) -o $@ $(SRCS) cJSON.o

cJSON.o: $(CJSON)/cJSON.c
	cc -O1 -c -o $@ $<

.PHONY: check clean
check: activity_test
	./activity_test

clean:
	rm -f activity_test cJSON.o
