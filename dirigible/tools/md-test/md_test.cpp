// Host tests for dirigible/core/src/markdown.cpp — the parser behind the
// T-Deck viewer's markdown mode.  Pure C++17, no LVGL:  make check
#include "dirigible/markdown.hpp"

#include <cstdio>
#include <cstring>
#include <string>

using namespace dirigible::md;

static int fails = 0;

static void expect(const char* what, const std::string& got, const std::string& want)
{
    if (got != want) {
        printf("FAIL %s\n  got  [%s]\n  want [%s]\n", what, got.c_str(), want.c_str());
        fails++;
    } else {
        printf("ok   %s\n", what);
    }
}

static void expect_int(const char* what, long got, long want)
{
    if (got != want) {
        printf("FAIL %s: got %ld want %ld\n", what, got, want);
        fails++;
    } else {
        printf("ok   %s\n", what);
    }
}

static Doc parse_str(const char* s)
{
    Doc d;
    parse(s, strlen(s), d);
    return d;
}

static std::string text(const Doc& d, size_t i)
{
    return plain(d.text.data() + d.lines[i].off, d.lines[i].len);
}

/// Kinds as a compact string: T text, H heading, C code, R rule, _ spacer, | row.
static std::string kinds(const Doc& d)
{
    std::string k;
    for (const Line& l : d.lines) {
        switch (l.kind) {
        case Kind::Text:     k += 'T'; break;
        case Kind::Heading:  k += 'H'; break;
        case Kind::Code:     k += 'C'; break;
        case Kind::Rule:     k += 'R'; break;
        case Kind::Spacer:   k += '_'; break;
        case Kind::TableRow: k += '|'; break;
        }
    }
    return k;
}

/// Inline render with markers spelt out: {s} strong, {e} em, {c} code,
/// {l} link, {d} dim, combinations as digits; {0} back to plain.
static std::string marked(const char* in)
{
    std::string r;
    render_inline(in, strlen(in), r);
    std::string out;
    for (unsigned char c : r) {
        if (is_style(c)) {
            const uint8_t st = style_of(c);
            out += '{';
            if (!st) out += '0';
            if (st & STRONG) out += 's';
            if (st & EM)     out += 'e';
            if (st & CODE)   out += 'c';
            if (st & LINK)   out += 'l';
            if (st & DIM)    out += 'd';
            out += '}';
        } else {
            out += (char)c;
        }
    }
    return out;
}

int main()
{
    printf("--- inline ---\n");
    expect("strong/em", marked("a **b** *c* ***d***"), "a {s}b{0} {e}c{0} {se}d{0}");
    expect("underscore not intraword", marked("snake_case_name and _em_"), "snake_case_name and {e}em{0}");
    expect("lone stars stay", marked("2 * 3 * 4"), "2 * 3 * 4");
    expect("code span", marked("run `idf.py build` now"), "run {c}idf.py build{0} now");
    expect("code keeps stars", marked("`**not bold**`"), "{c}**not bold**{0}");
    expect("double backtick", marked("``a ` b``"), "{c}a ` b{0}");
    expect("escape", marked("\\*literal\\* \\| pipe"), "*literal* | pipe");
    expect("link short url", marked("[docs](docs/a.md)"), "{l}docs{d} (docs/a.md){0}");
    expect("link long url dropped", marked("[x](https://example.com/a/very/long/path/that/goes/on/and/on)"), "{l}x{0}");
    expect("link anchor dropped", marked("[top](#top)"), "{l}top{0}");
    expect("link same as url", marked("[a.md](a.md)"), "{l}a.md{0}");
    expect("bold link", marked("**[x](#y)**"), "{sl}x{0}");
    expect("ref link", marked("see [the spec][spec]."), "see {l}the spec{0}.");
    expect("image alt", marked("![logo](a.png) x"), "{d}logo{0} x");
    expect("autolink", marked("<https://lee.dev>"), "{l}https://lee.dev{0}");
    expect("tags stripped", marked("a<br>b <kbd>K</kbd>"), "a b K");
    expect("strike", marked("~~gone~~ kept"), "{d}gone{0} kept");
    expect("unclosed", marked("**open and `tick"), "**open and `tick");
    expect("non-ascii becomes ?", marked("caf\xc3\xa9"), "caf??");

    printf("--- blocks ---\n");
    {
        Doc d = parse_str("# Title\n\nFirst line\nsecond line.\n\nNext para  \nhard break\\\nand more\n");
        expect("kinds", kinds(d), "H_T_TTT");
        expect("heading text", text(d, 0), "Title");
        expect_int("heading level", d.lines[0].level, 1);
        expect("soft break joins", text(d, 2), "First line second line.");
        expect("hard break (spaces)", text(d, 4), "Next para");
        expect("hard break (backslash)", text(d, 5), "hard break");
        expect("after hard break", text(d, 6), "and more");
    }
    {
        Doc d = parse_str("Setext one\n===\n\nTwo\n---\n\n## Closed ##\n");
        expect("setext kinds", kinds(d), "H_H_H");
        expect_int("setext 1", d.lines[0].level, 1);
        expect_int("setext 2", d.lines[2].level, 2);
        expect("closing hashes", text(d, 4), "Closed");
    }
    {
        Doc d = parse_str("- one\n- two\n  - nested *em*\n    - deeper\n- three\n1. first\n2) second\n");
        expect("list kinds", kinds(d), "TTTTTTT");
        expect("bullet", text(d, 0), "* one");
        expect_int("depth 1", d.lines[0].indent, 1);
        expect_int("depth 2", d.lines[2].indent, 2);
        expect_int("depth 3", d.lines[3].indent, 3);
        expect_int("back to 1", d.lines[4].indent, 1);
        expect("nested inline", text(d, 2), "* nested em");
        expect_int("hang = glyph + space", d.lines[0].hang, 2);
        expect("ordered", text(d, 5), "1. first");
        expect("ordered paren", text(d, 6), "2) second");
        expect_int("ordered hang", d.lines[5].hang, 3);
    }
    {
        Doc d = parse_str("- [ ] todo\n- [x] done\n- item\n  lazy continuation\n\n  second para\n\nafter\n");
        expect("task open", text(d, 0), "[ ] todo");
        expect("task done", text(d, 1), "[x] done");
        expect("continuation joins", text(d, 2), "* item lazy continuation");
        expect("list para kinds", kinds(d), "TTT_T_T");
        expect_int("item para indent", d.lines[4].indent, 1);
        expect("item para", text(d, 4), "second para");
        expect_int("after list", d.lines[6].indent, 0);
    }
    {
        Doc d = parse_str("> quoted **text**\n> more\n>\n> > nested\n\nplain\n");
        expect("quote kinds", kinds(d), "T_T_T");
        expect("quote joins", text(d, 0), "quoted text more");
        expect_int("quote depth", d.lines[0].quote, 1);
        expect_int("nested depth", d.lines[2].quote, 2);
        expect_int("plain depth", d.lines[4].quote, 0);
    }
    {
        Doc d = parse_str("text\n\n```cpp\nint *p = **q; // # not a heading\n\n```\n---\n    indented code\n");
        expect("code kinds", kinds(d), "T_CC_R_C");
        expect("code verbatim", text(d, 2), "int *p = **q; // # not a heading");
        expect("indented code", text(d, 7), "indented code");
    }
    {
        Doc d = parse_str("<!-- hidden\nstill hidden -->\nshown\n");
        expect("comment", kinds(d), "T");
        expect("comment text", text(d, 0), "shown");
    }

    printf("--- tables ---\n");
    {
        Doc d = parse_str(
            "Intro\n"
            "| Key | Action | Notes |\n"
            "|:----|:------:|------:|\n"
            "| `Cmd+/` | **Palette** | a \\| b `c \\| d` |\n"
            "| x | y |\n"
            "| 1 | 2 | 3 | 4 |\n"
            "\n"
            "after\n");
        expect("table kinds", kinds(d), "T_||||_T");
        expect_int("one table", (long)d.tables.size(), 1);
        const Table& t = d.tables[0];
        expect_int("ncols", t.ncols, 3);
        expect_int("rows", t.rows, 4);
        expect_int("align left", (long)t.align[0], (long)Align::Left);
        expect_int("align center", (long)t.align[1], (long)Align::Center);
        expect_int("align right", (long)t.align[2], (long)Align::Right);
        expect("header", text(d, 2), "Key|Action|Notes");
        expect_int("header row index", d.lines[2].row, 0);
        expect("inline + escaped pipe", text(d, 3), "Cmd+/|Palette|a | b c | d");
        expect("short row padded", text(d, 4), "x|y|");
        expect("long row trimmed", text(d, 5), "1|2|3");
        // Markers inside a cell must not leak into the next one.
        const Line& r = d.lines[3];
        std::string raw(d.text.data() + r.off, r.len);
        const size_t sep = raw.find(CELL_SEP);
        expect_int("cell ends in style 0", (unsigned char)raw[sep - 1], STYLE_MARK);
    }
    {
        Doc d = parse_str("a | b\n--|--\n1 | 2\nnot a row\n");
        expect("no outer pipes", kinds(d), "||_T");
        expect("bare row", text(d, 1), "1|2");
    }
    {
        Doc d = parse_str("| just | pipes |\nno delimiter\n");
        expect("no delimiter, no table", kinds(d), "T");
    }
    {
        Doc d = parse_str("> | q | r |\n> |---|---|\n> | 1 | 2 |\n");
        expect("table in quote", kinds(d), "||");
        expect_int("quoted row", d.lines[1].quote, 1);
    }

    printf("--- robustness ---\n");
    {
        std::string big;
        for (int i = 0; i < 20000; i++) big += "* ** *** _ __ ` [ ( ";
        Doc d;
        parse(big.data(), big.size(), d);
        expect_int("pathological input parses", d.lines.empty() ? 0 : 1, 1);
    }
    {
        Doc d = parse_str("");
        expect_int("empty", (long)d.lines.size(), 0);
        Doc e = parse_str("\r\n\r\nword\r\n");
        expect("CRLF", text(e, 0), "word");
    }

    printf(fails ? "\n%d FAILED\n" : "\nall passed\n", fails);
    return fails ? 1 : 0;
}
