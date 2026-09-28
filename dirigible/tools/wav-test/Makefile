# Host-side tests for dirigible/core/src/voice.cpp, the pure half of voice
# input (plan 2026-09-28 §5.6): the WAV header the T-Deck puts on a clip, the
# silence gate, appendTranscript's rules (the same cases as Lee's
# electron/src/shared/voice.ts), and Hester's GET /voice and
# POST /voice/transcribe answers.  cJSON comes from ESP-IDF's copy, so the
# firmware and the test parse with the same library.  No LVGL, no IDF.
#
#   make check                      (IDF_PATH defaults to ~/Development/hardware/esp-idf)

CORE     := ../../core
IDF_PATH ?= $(HOME)/Development/hardware/esp-idf
CJSON    := $(IDF_PATH)/components/json/cJSON

# voice.cpp's VoiceClient talks through the transport interface only, so the
# test links it with no platform code at all.
SRCS := wav_test.cpp $(CORE)/src/voice.cpp

wav_test: $(SRCS) $(CORE)/include/dirigible/voice.hpp $(CORE)/include/dirigible/transport.hpp cJSON.o
	c++ -std=c++17 -O1 -Wall -Wextra -I$(CORE)/include -I$(CJSON) -o $@ $(SRCS) cJSON.o

cJSON.o: $(CJSON)/cJSON.c
	cc -O1 -c -o $@ $<

.PHONY: check clean
check: wav_test
	./wav_test

clean:
	rm -f wav_test cJSON.o
