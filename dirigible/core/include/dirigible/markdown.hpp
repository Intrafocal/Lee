#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// ---------------------------------------------------------------------------
// A small GitHub-flavoured markdown reader for the T-Deck viewer.
//
// Pure: no LVGL, no ESP-IDF, no fonts.  It turns markdown source into logical
// lines — one per paragraph, heading, list item, code line, table row — whose
// text carries inline style as marker bytes.  Wrapping to pixels, column
// widths and colours are the firmware's job (screen_viewer.cpp), because only
// it knows the fonts.  Host tests: tools/md-test.
//
// Input must be folded to ASCII first (the firmware's fold_utf8_line): bytes
// >= 0x80 are reserved for the markers below, and any that arrive anyway are
// turned into '?'.
//
// Covered: ATX and setext headings; paragraphs with soft breaks joined into
// one line and hard breaks (two trailing spaces, a trailing backslash, <br>)
// splitting it; **strong**, *em*, ***both***, _underscore_ forms (not inside
// words), ~~strike~~, `code` (any backtick run), backslash escapes; links
// [text](url) and [text][ref] (text shown, a short url kept dimmed after it),
// <autolinks>, images as their alt text; bullet, numbered and nested lists
// and task items; block quotes (nesting depth kept); thematic breaks; fenced
// (``` and ~~~) and indented code; HTML comments dropped, other inline tags
// stripped; and pipe tables with alignment rows, escaped pipes, inline
// formatting in cells and ragged rows padded or trimmed to the header.
// ---------------------------------------------------------------------------

namespace dirigible::md {

// ---- inline style markers ----------------------------------------------------
// A byte 0x80 | bits sets the style for everything after it until the next
// marker (absolute, not a toggle).  Every line starts in style 0.
enum StyleBit : uint8_t {
    STRONG = 1 << 0,
    EM     = 1 << 1,
    CODE   = 1 << 2,
    LINK   = 1 << 3,
    DIM    = 1 << 4,   // strikethrough, image alt text, a link's url
};
inline constexpr uint8_t STYLE_MARK = 0x80;
inline bool is_style(uint8_t c) { return (c & 0xE0) == 0x80; }
inline uint8_t style_of(uint8_t c) { return c & 0x1F; }

// ---- glyph tokens ------------------------------------------------------------
// Only ever at the start of a list item's text, inside its `hang` prefix.
inline constexpr uint8_t GLYPH_BULLET    = 0xF0;
inline constexpr uint8_t GLYPH_TASK_OPEN = 0xF1;
inline constexpr uint8_t GLYPH_TASK_DONE = 0xF2;
inline bool is_glyph(uint8_t c) { return c >= 0xF0 && c <= 0xF2; }

/// Separates the cells of a TableRow line's text.
inline constexpr char CELL_SEP = '\x1f';

inline constexpr int MAX_COLS = 12;   // columns past this are dropped

enum class Kind : uint8_t {
    Text,       // paragraph or list item text; wraps
    Heading,    // level 1..6
    Code,       // one line of a code block, verbatim, no markers
    Rule,       // thematic break
    Spacer,     // vertical air between blocks
    TableRow,   // cells separated by CELL_SEP; see Table
};

enum class Align : uint8_t { None, Left, Center, Right };

struct Line {
    uint32_t off    = 0;    // text in Doc::text
    uint32_t len    = 0;
    int32_t  src    = 0;    // 0-based source line it starts on
    Kind     kind   = Kind::Text;
    uint8_t  level  = 0;    // Heading: 1..6
    uint8_t  quote  = 0;    // block quote depth
    uint8_t  indent = 0;    // list nesting: 0 outside lists, 1 top-level item...
    uint8_t  hang   = 0;    // bytes of list marker at the start of the text
                            // (bullet/number/checkbox + space); wrapped rows
                            // of the item line up after it
    uint16_t table  = 0;    // TableRow: index into Doc::tables
    uint16_t row    = 0;    // TableRow: 0 is the header
};

struct Table {
    uint8_t  ncols = 0;
    Align    align[MAX_COLS] = {};
    uint32_t rows  = 0;     // including the header
};

struct Doc {
    std::string        text;
    std::vector<Line>  lines;
    std::vector<Table> tables;

    void clear()
    {
        std::string().swap(text);
        std::vector<Line>().swap(lines);
        std::vector<Table>().swap(tables);
    }
};

/// Parse `n` bytes of ASCII markdown into `out` (cleared first).  Lines are
/// separated by '\n'; a CR before one is ignored.  Linear in the input apart
/// from inline emphasis matching, which looks at most a few KB ahead.
void parse(const char* src, size_t n, Doc& out);

/// Render one run of inline markdown (no block syntax) onto `out`, with
/// style markers.  Starts and ends in style 0 as far as the caller knows.
void render_inline(const char* s, size_t n, std::string& out);

/// `rendered` with markers removed and glyph tokens spelt as "*", "[ ]",
/// "[x]" — what tests compare against, and a cheap plain-text view.
std::string plain(const char* rendered, size_t n);
inline std::string plain(const std::string& r) { return plain(r.data(), r.size()); }

}  // namespace dirigible::md
