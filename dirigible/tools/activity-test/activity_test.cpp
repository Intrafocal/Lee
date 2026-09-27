// Host tests for the Cockpit-design ports in dirigible/core:
//   activity.cpp  describe_activity / strip_leading_cd / format_tokens /
//                 work_line, the same cases as electron/scripts/
//                 cockpit-renderer-smoke.mjs (so the C++ port cannot drift);
//   attention.cpp the compact snapshot's agents[] / limits / deep, tolerant
//                 of absence;
//   carry.cpp     GET /carry.
// Pure C++17 plus ESP-IDF's copy of cJSON, no LVGL:  make check
#include "dirigible/activity.hpp"
#include "dirigible/attention.hpp"
#include "dirigible/carry.hpp"
#include "cJSON.h"

#include <cstdio>
#include <string>
#include <vector>

using namespace dirigible;

static int fails = 0;

static void expect(const std::string& what, const std::string& got, const std::string& want)
{
    if (got != want) {
        printf("FAIL %s\n  got  [%s]\n  want [%s]\n", what.c_str(), got.c_str(), want.c_str());
        fails++;
    } else {
        printf("ok   %s\n", what.c_str());
    }
}

static void expect_int(const std::string& what, long long got, long long want)
{
    if (got != want) {
        printf("FAIL %s: got %lld want %lld\n", what.c_str(), got, want);
        fails++;
    } else {
        printf("ok   %s\n", what.c_str());
    }
}

using Files = std::vector<std::string>;

static std::string now_(const char* tool, const char* preview = "", Files files = {}, bool failed = false)
{
    return describe_activity(tool, preview, files, failed, false);
}

static std::string past_(const char* tool, const char* preview = "", Files files = {}, bool failed = false)
{
    return describe_activity(tool, preview, files, failed, true);
}

static void test_activity()
{
    for (const char* tool : { "Edit", "Write", "MultiEdit", "NotebookEdit" }) {
        expect(std::string(tool) + " one file", now_(tool, "/ws/src/main.ts", { "/ws/src/main.ts" }), "Editing main.ts");
        expect(std::string(tool) + " one file, past", past_(tool, "/ws/src/main.ts", { "/ws/src/main.ts" }), "Edited main.ts");
    }
    expect("MultiEdit 3 files", now_("MultiEdit", "/ws/a.ts", { "/ws/a.ts", "/ws/b.ts", "/ws/c.ts" }), "Editing 3 files");
    expect("Edit 2 files, past", past_("Edit", "", { "/ws/a.ts", "/ws/b.ts" }), "Edited 2 files");
    expect("Write, the preview names it", now_("Write", "/ws/notes/plan.md"), "Editing plan.md");
    expect("Edit, nothing names a file", now_("Edit"), "Editing");

    expect("Read one", now_("Read", "/ws/README.md", { "/ws/README.md" }), "Reading README.md");
    expect("Read 4", now_("Read", "", { "/a", "/b", "/c", "/d" }), "Reading 4 files");
    expect("Read one, past", past_("Read", "/ws/README.md", { "/ws/README.md" }), "Read README.md");
    expect("Read 2, past", past_("Read", "", { "/a", "/b" }), "Read 2 files");

    expect("Grep pattern", now_("Grep", "describeActivity"), "Searching for describeActivity");
    expect("Glob pattern", now_("Glob", "src/**/*.tsx"), "Searching for src/**/*.tsx");
    expect("Grep pattern, past", past_("Grep", "describeActivity"), "Searched for describeActivity");
    expect("Grep too long", now_("Grep", std::string(31, 'x').c_str()), "Searching");
    expect("Grep 30 is fine", now_("Grep", std::string(30, 'x').c_str()), "Searching for " + std::string(30, 'x'));
    expect("Grep a path is not a pattern", now_("Grep", "/Users/ben/Development/Lee"), "Searching");
    expect("Glob empty", now_("Glob", ""), "Searching");
    expect("Glob empty, past", past_("Glob", ""), "Searched");
    expect("Grep the tool name is not a pattern", now_("Grep", "Grep"), "Searching");

    for (const char* cmd : { "npm test", "pytest tests/copilot -q", "npx jest", "npx vitest run",
                             "node scripts/cockpit-renderer-smoke.mjs", "PYTHONPATH=. python -m pytest" }) {
        expect(std::string("tests: ") + cmd, now_("Bash", cmd), "Running tests");
        expect(std::string("tests, past: ") + cmd, past_("Bash", cmd), "Ran tests");
    }
    for (const char* cmd : { "npm run build", "npm run build:main", "npm run dist", "npx tsc --noEmit", "idf.py flash" }) {
        expect(std::string("build: ") + cmd, now_("Bash", cmd), "Building");
        expect(std::string("build, past: ") + cmd, past_("Bash", cmd), "Built");
    }
    expect("git status", now_("Bash", "git status --short"), "Using git");
    expect("git by its first word", now_("Bash", "git commit -m \"fix the test\""), "Using git");
    expect("git push, past", past_("Bash", "git push"), "Used git");
    expect("ls", now_("Bash", "ls -la"), "Running ls");
    expect("a path's base name", now_("Bash", "/usr/bin/python3 x.py"), "Running python3");
    expect("curl, past", past_("Bash", "curl -s localhost:9000/health"), "Ran curl");
    expect("empty command", now_("Bash", ""), "Running a command");
    expect("empty command, past", past_("Bash", ""), "Ran a command");
    expect("testing is not test", now_("Bash", "echo testing"), "Running echo");

    expect("cd && tests", now_("Bash", "cd electron && npm test"), "Running tests");
    expect("cd && tests, past", past_("Bash", "cd electron && npm test"), "Ran tests");
    expect("cd && build, past", past_("Bash", "cd electron && npm run build"), "Built");
    expect("cd && git", now_("Bash", "cd /Users/ben/Development/Lee && git status"), "Using git");
    expect("cd \"quoted\"; grep", past_("Bash", "cd \"my dir\"; grep -rn foo ."), "Ran grep");
    expect("several cd segments", past_("Bash", "cd a && cd b; ls -la"), "Ran ls");
    expect("the directory is not the command", past_("Bash", "cd tests && ls"), "Ran ls");
    expect("cd && git commit", past_("Bash", "cd electron && git commit -m \"fix the test\""), "Used git");
    expect("a bare cd", past_("Bash", "cd electron"), "Ran cd");
    expect("only the cd builtin", past_("Bash", "cdk deploy"), "Ran cdk");
    expect("strip_leading_cd", strip_leading_cd("  cd 'x y' ;  make all"), "make all");
    expect("strip_leading_cd keeps a lone cd", strip_leading_cd("cd a &&"), "cd a &&");

    expect("WebFetch", now_("WebFetch", "https://example.com"), "Reading the web");
    expect("WebSearch", now_("WebSearch", "newsreader font"), "Reading the web");
    expect("WebFetch, past", past_("WebFetch"), "Read the web");
    expect("Task", now_("Task", "explore the repo"), "Working with a subagent");
    expect("Agent", now_("Agent"), "Working with a subagent");
    expect("Agent, past", past_("Agent"), "Worked with a subagent");
    expect("AskUserQuestion", now_("AskUserQuestion"), "Asking you a question");
    expect("AskUserQuestion, past", past_("AskUserQuestion"), "Asked you a question");
    expect("anything else", now_("mcp__linear__create_issue", "{\"title\":\"x\"}"), "mcp__linear__create_issue");
    expect("anything else, past", past_("TodoWrite"), "TodoWrite");

    expect("failed tests", now_("Bash", "npm test", {}, true), "Running tests (failed)");
    expect("failed tests, past", past_("Bash", "npm test", {}, true), "Ran tests (failed)");
    expect("failed edits, past", past_("Edit", "", { "/a", "/b" }, true), "Edited 2 files (failed)");
    expect("failed other", now_("Weird", "", {}, true), "Weird (failed)");
    expect("not failed", now_("Read", "/x", { "/x" }, false), "Reading x");
}

static void test_tokens_and_line()
{
    expect("0 tok", format_tokens(0), "0 tok");
    expect("999 tok", format_tokens(999), "999 tok");
    expect("1k tok", format_tokens(1000), "1k tok");
    expect("412k tok", format_tokens(412345), "412k tok");
    expect("1000k at the edge", format_tokens(999600), "1000k tok");
    expect("1.2M tok", format_tokens(1234567), "1.2M tok");
    expect("1.3M, half up", format_tokens(1250000), "1.3M tok");
    expect("12M tok", format_tokens(12400000), "12M tok");
    expect("negative", format_tokens(-1), "");

    expect("one", work_line(1, 0), "One thing needs you.");
    expect("two", work_line(2, 3), "Two things need you.");
    expect("thirteen", work_line(13, 0), "13 things need you.");
    expect("working", work_line(0, 2), "Working on it.");
    expect("clear", work_line(0, 0), "All clear.");
}

static void test_snapshot()
{
    const char* json = R"({"success":true,"data":{
      "items":[],"counts":{"blocking":0,"needs_you":0,"ambient":0,"parked":0},
      "focus":{"active":true},"away":{"active":false},
      "generated_at":"2026-09-27T12:00:00.000Z",
      "mode":"deep","deep":{"exploration_id":"exp-1","title":"Carry on the T-Deck"},
      "limits":{"five_hour":{"used_pct":41.6,"resets_at":null},"as_of":"2026-09-27T11:59:00Z"},
      "agents":[
        {"pty_id":7,"window_id":1,"tab_id":3,"label":"lee copilot","provider":"claude","workspace":"/ws",
         "state":"busy","busy_since":"2026-09-27T11:42:00.000Z","idle_since":null,"last_tool":"Bash",
         "last_summary":"Running the smokes.","files_touched_count":2,
         "now":{"tool":"Bash","preview":"cd electron && npm test","files":[],"since":"2026-09-27T11:59:30.000Z"},
         "recent":[{"at":"2026-09-27T11:58:00.000Z","tool":"Edit","preview":"/ws/a.ts","files":["/ws/a.ts"],"writes":true,"phase":"post"}],
         "updates":[{"at":"2026-09-27T11:40:00.000Z","summary":"Done with the first half.","lee_status":null},
                    {"at":"2026-09-27T11:41:00.000Z","summary":null,"lee_status":{"files":[]}}],
         "usage":{"tokens":{"input":1000},"shown_tokens":412345,"cost_basis":"subscription"}},
        {"pty_id":8,"label":"old lee","state":"idle"},
        {"label":"no pty"}
      ]}})";
    cJSON* root = cJSON_Parse(json);
    AttentionSnapshot s;
    expect_int("snapshot parses", attention_snapshot_parse(root, s), 1);
    cJSON_Delete(root);
    expect_int("agents without pty_id are dropped", (long long)s.agents.size(), 2);
    expect_int("working", s.working(), 1);
    expect_int("deep", s.deep_active, 1);
    expect("deep title", s.deep_title, "Carry on the T-Deck");
    expect("mode", s.mode, "deep");
    expect_int("limits", s.has_limits, 1);
    expect_int("five hour rounds", s.limits.five_hour_pct, 42);
    expect_int("seven day absent", s.limits.seven_day_pct, -1);
    if (s.agents.size() == 2) {
        const auto& a = s.agents[0];
        expect_int("busy for 18m", a.busy_ms, 18 * 60000);
        expect_int("idle absent", a.idle_ms, -1);
        expect_int("has now", a.has_now, 1);
        expect("now in words", describe_activity(a.now.tool, a.now.preview, a.now.files), "Running tests");
        expect_int("now age", a.now.age_ms, 30000);
        expect_int("recent", (long long)a.recent.size(), 1);
        if (!a.recent.empty()) {
            expect_int("recent is post", a.recent[0].past, 1);
            expect("recent in words", describe_activity(a.recent[0].tool, a.recent[0].preview,
                                                        a.recent[0].files, a.recent[0].failed, a.recent[0].past),
                   "Edited a.ts");
        }
        expect_int("status-only updates are skipped", (long long)a.updates.size(), 1);
        expect_int("usage", a.has_usage, 1);
        expect("token label", format_tokens(a.usage.shown_tokens), "412k tok");
        const auto& b = s.agents[1];
        expect_int("old agent: no now", b.has_now, 0);
        expect_int("old agent: no usage", b.has_usage, 0);
        expect_int("old agent: idle", (int)b.state, (int)AgentState::Idle);
    }

    // An older Lee: nothing new at all.
    root = cJSON_Parse(R"({"items":[],"focus":{"active":false}})");
    AttentionSnapshot old;
    expect_int("old snapshot parses", attention_snapshot_parse(root, old), 1);
    cJSON_Delete(root);
    expect_int("old: no agents", (long long)old.agents.size(), 0);
    expect_int("old: no deep", old.deep_active, 0);
    expect_int("old: no limits", old.has_limits, 0);
    expect_int("old: deep null", old.deep_active, 0);
}

static void test_carry()
{
    cJSON* root = cJSON_Parse(R"({"workspace":"/ws",
      "pick_up":{"exploration_id":"exp-1","title":"Carry","stopped_at":"The pager should hold one thought.","last_touched_at":"2026-09-27T10:00:00Z"},
      "open_questions":[{"exploration_id":"exp-1","question_id":"q1","text":"Does Open next replace f?"},
                        {"exploration_id":"exp-2","question_id":"q2","text":"Voice on the walk?"},
                        {"exploration_id":"exp-1","question_id":"q3","text":"Second question"},
                        {"exploration_id":"exp-3","question_id":"q4","text":""}],
      "captured_count":2,"reading_count":0,
      "open_next":{"exploration_id":"exp-2","set_at":"2026-09-27T10:05:00Z"}})");
    CarryState c;
    expect_int("carry parses", carry_parse(root, c), 1);
    cJSON_Delete(root);
    expect_int("pick up", c.has_pick_up, 1);
    expect("stopped at", c.stopped_at, "The pager should hold one thought.");
    expect_int("empty questions dropped", (long long)c.questions.size(), 3);
    const auto ex = c.explorations();
    expect_int("two explorations", (long long)ex.size(), 2);
    if (ex.size() == 2) {
        expect("pick-up first", ex[0], "exp-1");
        expect("then the others", ex[1], "exp-2");
    }
    const CarryQuestion* q = c.question_for("exp-1");
    expect("first question for exp-1", q ? q->text : "", "Does Open next replace f?");
    expect_int("open next", c.has_open_next, 1);
    expect("open next id", c.open_next_exploration_id, "exp-2");
    expect_int("captured", c.captured_count, 2);

    root = cJSON_Parse(R"({"workspace":"/ws","pick_up":null,"open_questions":[],"captured_count":0,"reading_count":0,"open_next":null})");
    CarryState empty;
    expect_int("empty carry parses", carry_parse(root, empty), 1);
    cJSON_Delete(root);
    expect_int("empty: nothing", (long long)empty.explorations().size(), 0);
    expect_int("empty: no open next", empty.has_open_next, 0);

    root = cJSON_Parse(R"({"error":"hester_offline"})");
    CarryState err;
    expect_int("an error body is not carry", carry_parse(root, err), 0);
    cJSON_Delete(root);
}

int main()
{
    test_activity();
    test_tokens_and_line();
    test_snapshot();
    test_carry();
    printf(fails ? "\n%d FAILED\n" : "\nall passed\n", fails);
    return fails ? 1 : 0;
}
