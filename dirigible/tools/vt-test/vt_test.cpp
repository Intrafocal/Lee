#include "vt.hpp"   // firmware/main/vt.hpp, via the Makefile's -I
#include <cstdio>
#include <cstring>
#include <string>
using namespace dirigible_app;

static VtScreen vt;
static void feed(const char* s) { vt.feed((const uint8_t*)s, strlen(s)); }
static int fails = 0;
static void expect(const char* what, const std::string& got, const std::string& want) {
    if (got != want) { printf("FAIL %s\n  got  [%s]\n  want [%s]\n", what, got.c_str(), want.c_str()); fails++; }
    else printf("ok   %s -> [%s]\n", what, got.c_str());
}

int main() {
    // table sanity
    printf("--- fold ---\n");
    vt.resize(40, 10);

    // 1. the exact string from the photo: · is 2 bytes, … is 3
    feed("Update installed \xc2\xb7 Restart to upd\xe2\x80\xa6");
    expect("utf8 one cell per codepoint", vt.row(0), "Update installed . Restart to upd.");

    // 2. box drawing keeps width and shape
    vt.reset();
    feed("\xe2\x95\xad\xe2\x94\x80\xe2\x94\x80\xe2\x95\xae");   // rounded box top
    expect("box drawing", vt.row(0), "+--+");

    // 3. columns still line up after a box rule (the real bug)
    vt.reset();
    feed("\xe2\x94\x82 abc");            // "| abc"
    expect("box + text alignment", vt.row(0), "| abc");

    // 4. double width consumes two cells
    vt.reset();
    feed("\xe4\xb8\xad" "X");            // U+4E2D then X
    expect("wide char = 2 cells", vt.row(0), "? X");

    // 5. zero width consumes none
    vt.reset();
    feed("a\xe2\x80\x8b" "b");
    expect("zero width", vt.row(0), "ab");

    printf("--- colour ---\n");
    vt.reset();
    feed("\x1b[31mRED\x1b[0m.");
    expect("sgr fg red", vt.rowMarkup(0), "#E05252 RED##C8C8C8 .#");

    vt.reset();
    feed("\x1b[1;32mBG\x1b[m");
    expect("bold brightens", vt.rowMarkup(0), "#9AF29A BG#");

    vt.reset();
    feed("\x1b[38;5;196mX");
    expect("256-colour", vt.rowMarkup(0), "#FF8A8A X#");

    vt.reset();
    feed("\x1b[38;2;0;120;255mX");
    expect("truecolour", vt.rowMarkup(0), "#9BC2FF X#");

    vt.reset();
    feed("a#b");
    expect("hash escaped for lvgl", vt.rowMarkup(0), "#C8C8C8 a##b#");

    printf("--- private CSI not mistaken for SGR/DCH ---\n");
    vt.reset();
    feed("\x1b[>4;2m" "ok");
    expect("modifyOtherKeys ignored", vt.rowMarkup(0), "#C8C8C8 ok#");

    vt.reset();
    feed("abcdef\x1b[1;1H\x1b[?25lZ");
    expect("?25l is not DCH", vt.row(0), "Zbcdef");

    printf("--- reverse video keeps a selection bar ---\n");
    vt.reset();
    feed("\x1b[7m  sel \x1b[0m");
    expect("reverse trailing blanks kept", vt.rowMarkup(0), "#FFFFFF   sel #");

    printf("--- per-row dirty ---\n");
    vt.reset(); vt.clearDirty();
    feed("\x1b[3;1Hhi");
    printf("row0 dirty=%d row2 dirty=%d (want 0,1)\n", vt.rowDirty(0), vt.rowDirty(2));
    if (vt.rowDirty(0) || !vt.rowDirty(2)) fails++;

    printf("\n%s (%d failures)\n", fails ? "FAILURES" : "ALL PASS", fails);
    return fails != 0;
}
