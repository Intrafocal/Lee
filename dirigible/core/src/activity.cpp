#include "dirigible/activity.hpp"

#include <cstdio>

namespace dirigible {

namespace {

// JavaScript's \s for the ASCII range, which is all a tool preview needs.
bool is_space(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v';
}

// JavaScript's \w.
bool is_word(char c)
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

std::string trim(const std::string& s)
{
    size_t b = 0, e = s.size();
    while (b < e && is_space(s[b])) b++;
    while (e > b && is_space(s[e - 1])) e--;
    return s.substr(b, e - b);
}

std::string lower(const std::string& s)
{
    std::string out = s;
    for (auto& c : out) {
        if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    }
    return out;
}

/// String length in UTF-16 code units, as JavaScript counts it.
size_t js_length(const std::string& s)
{
    size_t n = 0;
    for (size_t i = 0; i < s.size(); i++) {
        const unsigned char c = (unsigned char)s[i];
        if ((c & 0xC0) == 0x80) continue;   // continuation byte
        n += c >= 0xF0 ? 2 : 1;             // outside the BMP: a surrogate pair
    }
    return n;
}

/// `word` in `text` with a \b on either side.
bool has_word(const std::string& text, const char* word)
{
    const std::string w = word;
    for (size_t at = text.find(w); at != std::string::npos; at = text.find(w, at + 1)) {
        const bool before = at == 0 || !is_word(text[at - 1]);
        const size_t end = at + w.size();
        const bool after = end >= text.size() || !is_word(text[end]);
        if (before && after) return true;
    }
    return false;
}

std::string base_name(const std::string& path)
{
    size_t end = path.size();
    while (end > 0 && (path[end - 1] == '/' || path[end - 1] == '\\')) end--;
    const std::string cut = path.substr(0, end);
    const size_t slash = cut.find_last_of("/\\");
    const std::string last = slash == std::string::npos ? cut : cut.substr(slash + 1);
    return last.empty() ? path : last;
}

/// "Editing main.ts", "Editing 3 files", or the bare verb when nothing names a file.
std::string on_files(const char* verb, const std::vector<std::string>& files,
                     const std::string& preview)
{
    if (files.size() > 1) return std::string(verb) + " " + std::to_string(files.size()) + " files";
    const std::string one = files.empty() ? trim(preview) : files[0];
    return one.empty() ? std::string(verb) : std::string(verb) + " " + base_name(one);
}

/// Length of one leading `cd <dir> &&` / `cd <dir>;` segment at the start of
/// `s` (with the whitespace around it), or 0.  The regex in cockpit.ts:
///   ^\s*cd(?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?\s*(?:&&|;)\s*
size_t leading_cd(const std::string& s)
{
    size_t p = 0;
    while (p < s.size() && is_space(s[p])) p++;
    if (s.compare(p, 2, "cd") != 0) return 0;
    p += 2;

    // After "cd" (and its argument, if any): \s*(?:&&|;)\s*
    auto tail = [&](size_t q) -> size_t {
        while (q < s.size() && is_space(s[q])) q++;
        if (s.compare(q, 2, "&&") == 0) q += 2;
        else if (q < s.size() && s[q] == ';') q += 1;
        else return 0;
        while (q < s.size() && is_space(s[q])) q++;
        return q;
    };

    if (p < s.size() && is_space(s[p])) {
        size_t q = p;
        while (q < s.size() && is_space(s[q])) q++;
        size_t arg_end = 0;
        if (q < s.size() && (s[q] == '"' || s[q] == '\'')) {
            const size_t close = s.find(s[q], q + 1);
            if (close != std::string::npos) arg_end = close + 1;
        } else {
            size_t r = q;
            while (r < s.size() && !is_space(s[r]) && s[r] != ';' && s[r] != '&' && s[r] != '|') r++;
            if (r > q) arg_end = r;
        }
        if (arg_end) {
            if (const size_t end = tail(arg_end)) return end;
        }
    }
    return tail(p);
}

/// A Bash command in words: tests, builds and git by name, else its first word.
std::string describe_command(const std::string& full, bool past)
{
    const std::string command = strip_leading_cd(full);
    // The first word that is not a VAR=value assignment.
    std::string first;
    const std::string t = trim(command);
    size_t i = 0;
    while (i < t.size()) {
        while (i < t.size() && is_space(t[i])) i++;
        size_t j = i;
        while (j < t.size() && !is_space(t[j])) j++;
        if (j == i) break;
        const std::string w = t.substr(i, j - i);
        i = j;
        size_t k = 0;
        bool assign = false;
        if (!w.empty() && (w[0] == '_' || (w[0] >= 'a' && w[0] <= 'z') || (w[0] >= 'A' && w[0] <= 'Z'))) {
            k = 1;
            while (k < w.size() && is_word(w[k])) k++;
            assign = k < w.size() && w[k] == '=';
        }
        if (assign) continue;
        first = base_name(w);
        break;
    }
    if (first == "git") return past ? "Used git" : "Using git";
    const std::string lc = lower(command);
    for (const char* w : { "test", "tests", "pytest", "jest", "vitest", "smoke" }) {
        if (has_word(lc, w)) return past ? "Ran tests" : "Running tests";
    }
    for (const char* w : { "build", "dist", "tsc", "idf.py" }) {
        if (has_word(lc, w)) return past ? "Built" : "Building";
    }
    if (first.empty()) return past ? "Ran a command" : "Running a command";
    return std::string(past ? "Ran " : "Running ") + first;
}

constexpr size_t SEARCH_PATTERN_MAX = 30;

}  // namespace

std::string strip_leading_cd(const std::string& command)
{
    std::string rest = command;
    for (size_t n = leading_cd(rest); n && !trim(rest.substr(n)).empty(); n = leading_cd(rest)) {
        rest = rest.substr(n);
    }
    return rest;
}

std::string describe_activity(const std::string& tool, const std::string& preview,
                              const std::vector<std::string>& files, bool failed, bool past)
{
    std::string phrase;
    if (tool == "Edit" || tool == "Write" || tool == "MultiEdit" || tool == "NotebookEdit") {
        phrase = on_files(past ? "Edited" : "Editing", files, preview);
    } else if (tool == "Read") {
        phrase = on_files(past ? "Read" : "Reading", files, preview);
    } else if (tool == "Grep" || tool == "Glob") {
        // toolPreview prefers a path over the pattern; a path or JSON is not a pattern.
        const std::string p = trim(preview);
        const bool pattern = !p.empty() && p != tool && js_length(p) <= SEARCH_PATTERN_MAX &&
                             p[0] != '/' && p[0] != '~' && p[0] != '{' && p[0] != '[';
        phrase = std::string(past ? "Searched" : "Searching") + (pattern ? " for " + p : "");
    } else if (tool == "Bash") {
        phrase = describe_command(preview, past);
    } else if (tool == "WebFetch" || tool == "WebSearch") {
        phrase = past ? "Read the web" : "Reading the web";
    } else if (tool == "Task" || tool == "Agent") {
        phrase = past ? "Worked with a subagent" : "Working with a subagent";
    } else if (tool == "AskUserQuestion") {
        phrase = past ? "Asked you a question" : "Asking you a question";
    } else {
        phrase = tool;
    }
    return failed ? phrase + " (failed)" : phrase;
}

std::string format_tokens(int64_t n)
{
    if (n < 0) return "";
    char b[24];
    if (n < 1000) {
        snprintf(b, sizeof(b), "%lld tok", (long long)n);
    } else if (n < 1000000) {
        snprintf(b, sizeof(b), "%lldk tok", (long long)((n + 500) / 1000));   // Math.round
    } else if (n < 10000000) {
        const long long tenths = (n + 50000) / 100000;                        // toFixed(1)
        snprintf(b, sizeof(b), "%lld.%lldM tok", tenths / 10, tenths % 10);
    } else {
        snprintf(b, sizeof(b), "%lldM tok", (long long)((n + 500000) / 1000000));
    }
    return b;
}

std::string number_word(int n, bool capital)
{
    static const char* const WORDS[] = { "no", "one", "two", "three", "four", "five", "six",
                                         "seven", "eight", "nine", "ten", "eleven", "twelve" };
    std::string w = n >= 0 && n <= 12 ? WORDS[n] : std::to_string(n);
    if (capital && !w.empty() && w[0] >= 'a' && w[0] <= 'z') w[0] = (char)(w[0] - 'a' + 'A');
    return w;
}

std::string work_line(int waiting, int working)
{
    if (waiting < 0) waiting = 0;
    if (waiting > 0) {
        return number_word(waiting, true) + (waiting == 1 ? " thing needs" : " things need") + " you.";
    }
    return working > 0 ? "Working on it." : "All clear.";
}

}  // namespace dirigible
