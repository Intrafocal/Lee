#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace dirigible {

// ---------------------------------------------------------------------------
// Words for what the agents are doing, shared with Lee and Aeronaut.  Ports
// of electron/src/shared/cockpit.ts (describeActivity, stripLeadingCd,
// formatTokens) and electron/src/renderer/lib/cockpitModel.ts (workLine).
// Change them together.  Pure: no cJSON, no LVGL, host-tested in
// tools/activity-test.
// ---------------------------------------------------------------------------

/// A tool call as a short phrase (Cockpit design §7.1): present tense for
/// "what it's doing now", past tense for the timeline.  A failed entry gets
/// " (failed)".
///
///   Edit / Write / MultiEdit / NotebookEdit  "Editing main.ts", "Editing 3 files"
///   Read                                      "Reading main.ts"
///   Grep / Glob                               "Searching" (+ " for <pattern>")
///   Bash                                      "Running tests", "Building",
///                                             "Using git", "Running <word>"
///   WebFetch / WebSearch                      "Reading the web"
///   Task / Agent                              "Working with a subagent"
///   AskUserQuestion                           "Asking you a question"
///   anything else                             the tool's name
std::string describe_activity(const std::string& tool, const std::string& preview,
                              const std::vector<std::string>& files,
                              bool failed = false, bool past = false);

/// The command after any leading `cd <dir> &&` / `cd <dir>;` segments (the
/// whole command when nothing follows them).
std::string strip_leading_cd(const std::string& command);

/// "412k tok" / "1.2M tok"; "" for a negative count.
std::string format_tokens(int64_t n);

/// "one".."twelve", else digits; `capital` capitalises the first letter.
std::string number_word(int n, bool capital = false);

/// Work's headline (CONTRACT 6): "One thing needs you." / "Two things need
/// you.", else "Working on it." while an agent is busy, else "All clear."
std::string work_line(int waiting, int working);

}  // namespace dirigible
