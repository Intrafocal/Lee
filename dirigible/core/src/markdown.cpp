/*
 * markdown.cpp — see dirigible/markdown.hpp.
 *
 * Two layers: a block pass over source lines (quotes, fences, headings,
 * lists, tables, paragraphs) and an inline renderer for the text inside a
 * block (emphasis, code, links).  Both append straight onto Doc::text, so a
 * document costs its own size in text plus one Line per logical line; the
 * only per-line allocation is the paragraph accumulator, which is reused.
 */

#include "dirigible/markdown.hpp"

#include <cstring>

namespace dirigible::md {

namespace {

constexpr size_t NPOS       = (size_t)-1;
constexpr size_t LOOKAHEAD  = 4096;   // how far an opener looks for its closer
constexpr int    MAX_DEPTH  = 6;      // inline nesting
constexpr size_t URL_SHOW   = 40;     // longer urls are dropped, not shown

bool is_space(char c) { return c == ' ' || c == '\t'; }
bool is_alnum(char c)
{
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}
bool is_alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
bool is_punct(char c)
{
    return (c >= '!' && c <= '/') || (c >= ':' && c <= '@') ||
           (c >= '[' && c <= '`') || (c >= '{' && c <= '~');
}

/// Style-tracking writer onto a string.
struct Out {
    std::string& s;
    uint8_t      cur = 0;

    void put(char c, uint8_t style)
    {
        if (style != cur) {
            s += (char)(STYLE_MARK | style);
            cur = style;
        }
        const unsigned char u = (unsigned char)c;
        if (u >= 0x80)     c = '?';    // reserved for markers
        else if (u < 0x20) c = ' ';
        s += c;
    }
    void puts(const char* p, size_t n, uint8_t style)
    {
        for (size_t i = 0; i < n; i++) put(p[i], style);
    }
};

size_t find_backticks(const char* s, size_t n, size_t from, size_t k)
{
    const size_t lim = from + LOOKAHEAD < n ? from + LOOKAHEAD : n;
    size_t i = from;
    while (i < lim) {
        if (s[i] != '`') { i++; continue; }
        size_t j = i;
        while (j < n && s[j] == '`') j++;
        if (j - i == k) return i;
        i = j;
    }
    return NPOS;
}

/// Index just past the code span that starts at `i`, or past its backtick
/// run when it has no closer.
size_t skip_code(const char* s, size_t n, size_t i)
{
    size_t j = i;
    while (j < n && s[j] == '`') j++;
    const size_t c = find_backticks(s, n, j, j - i);
    return c == NPOS ? j : c + (j - i);
}

/// Matching close for the `open` at `i`, honouring nesting, escapes and code.
size_t find_match(const char* s, size_t n, size_t i, char open, char close)
{
    int depth = 0;
    const size_t lim = i + LOOKAHEAD < n ? i + LOOKAHEAD : n;
    for (size_t j = i; j < lim;) {
        const char c = s[j];
        if (c == '\\') { j += 2; continue; }
        if (c == '`' && open == '[') { j = skip_code(s, n, j); continue; }
        if (c == open) depth++;
        else if (c == close && --depth == 0) return j;
        j++;
    }
    return NPOS;
}

/// A closing run of exactly `k` `ch`s after `from` that can close: not
/// preceded by a space, and for '_' not followed by a letter or digit.
size_t find_closer(const char* s, size_t n, size_t from, char ch, size_t k)
{
    const size_t lim = from + LOOKAHEAD < n ? from + LOOKAHEAD : n;
    for (size_t j = from; j < lim;) {
        const char c = s[j];
        if (c == '\\') { j += 2; continue; }
        if (c == '`') { j = skip_code(s, n, j); continue; }
        if (c != ch) { j++; continue; }
        size_t e = j;
        while (e < n && s[e] == ch) e++;
        const char prev = j > 0 ? s[j - 1] : ' ';
        const char next = e < n ? s[e] : ' ';
        const bool can_close = !is_space(prev) && (ch != '_' || !is_alnum(next));
        if (can_close && e - j == k && j > from) return j;
        j = e;
    }
    return NPOS;
}

void render(const char* s, size_t n, uint8_t style, Out& o, int depth);

void render_link_url(const char* text, size_t tn, const char* u, size_t un,
                     uint8_t style, Out& o)
{
    if (un == 0 || un > URL_SHOW || u[0] == '#') return;
    if (un == tn && memcmp(u, text, un) == 0) return;
    const uint8_t dim = (uint8_t)((style & ~LINK) | DIM);
    o.put(' ', dim);
    o.put('(', dim);
    o.puts(u, un, dim);
    o.put(')', dim);
}

/// `<...>` at `i`: an autolink is drawn as a link, an HTML tag is dropped
/// (<br> becomes a space).  Returns the index after it, or NPOS if it is
/// neither and the '<' is literal.
size_t render_angle(const char* s, size_t n, size_t i, uint8_t style, Out& o)
{
    size_t gt = NPOS;
    for (size_t j = i + 1; j < n && j < i + 256; j++) {
        if (s[j] == '>') { gt = j; break; }
        if (s[j] == '<') break;
    }
    if (gt == NPOS || gt == i + 1) return NPOS;
    const char* b = s + i + 1;
    const size_t bl = gt - i - 1;

    bool spaces = false, at = false, scheme = false;
    for (size_t j = 0; j < bl; j++) {
        if (b[j] == ' ') spaces = true;
        if (b[j] == '@') at = true;
        if (j + 2 < bl && b[j] == ':' && b[j + 1] == '/' && b[j + 2] == '/') scheme = true;
    }
    if (!spaces && (scheme || at)) {
        o.puts(b, bl, style | LINK);
        return gt + 1;
    }
    if (is_alpha(b[0]) || b[0] == '/' || b[0] == '!') {
        const char* name = b[0] == '/' ? b + 1 : b;
        if ((name[0] == 'b' || name[0] == 'B') && (name[1] == 'r' || name[1] == 'R') &&
            (name + 2 == b + bl || name[2] == ' ' || name[2] == '/')) {
            o.put(' ', style);
        }
        return gt + 1;
    }
    return NPOS;
}

void render(const char* s, size_t n, uint8_t style, Out& o, int depth)
{
    size_t i = 0;
    while (i < n) {
        const char c = s[i];

        if (c == '\\' && i + 1 < n && is_punct(s[i + 1])) {
            o.put(s[i + 1], style);
            i += 2;
            continue;
        }

        if (c == '`') {
            size_t j = i;
            while (j < n && s[j] == '`') j++;
            const size_t k = j - i;
            const size_t cl = find_backticks(s, n, j, k);
            if (cl == NPOS) {
                o.puts(s + i, k, style);
                i = j;
                continue;
            }
            size_t a = j, b = cl;
            if (b - a >= 2 && s[a] == ' ' && s[b - 1] == ' ') {
                bool all = true;
                for (size_t t = a; t < b; t++) if (s[t] != ' ') { all = false; break; }
                if (!all) { a++; b--; }
            }
            o.puts(s + a, b - a, (uint8_t)(style | CODE));
            i = cl + k;
            continue;
        }

        if (c == '!' && i + 1 < n && s[i + 1] == '[' && depth < MAX_DEPTH) {
            const size_t rb = find_match(s, n, i + 1, '[', ']');
            if (rb != NPOS && rb + 1 < n && s[rb + 1] == '(') {
                const size_t rp = find_match(s, n, rb + 1, '(', ')');
                if (rp != NPOS) {
                    if (rb > i + 2) render(s + i + 2, rb - i - 2, (uint8_t)(style | DIM), o, depth + 1);
                    else            o.puts("image", 5, (uint8_t)(style | DIM));
                    i = rp + 1;
                    continue;
                }
            }
        }

        if (c == '[' && depth < MAX_DEPTH) {
            const size_t rb = find_match(s, n, i, '[', ']');
            if (rb != NPOS && rb + 1 < n && s[rb + 1] == '(') {
                const size_t rp = find_match(s, n, rb + 1, '(', ')');
                if (rp != NPOS) {
                    const char* text = s + i + 1;
                    const size_t tn = rb - i - 1;
                    render(text, tn, (uint8_t)(style | LINK), o, depth + 1);
                    size_t u0 = rb + 2;
                    while (u0 < rp && s[u0] == ' ') u0++;
                    const bool angle = u0 < rp && s[u0] == '<';
                    if (angle) u0++;
                    size_t u1 = u0;
                    while (u1 < rp && s[u1] != ' ' && !(angle && s[u1] == '>')) u1++;
                    render_link_url(text, tn, s + u0, u1 - u0, style, o);
                    i = rp + 1;
                    continue;
                }
            }
            if (rb != NPOS && rb + 1 < n && s[rb + 1] == '[') {
                const size_t rr = find_match(s, n, rb + 1, '[', ']');
                if (rr != NPOS) {
                    render(s + i + 1, rb - i - 1, (uint8_t)(style | LINK), o, depth + 1);
                    i = rr + 1;
                    continue;
                }
            }
        }

        if (c == '<') {
            const size_t next = render_angle(s, n, i, style, o);
            if (next != NPOS) { i = next; continue; }
        }

        if ((c == '*' || c == '_') && depth < MAX_DEPTH) {
            size_t e = i;
            while (e < n && s[e] == c) e++;
            const size_t run = e - i;
            const char prev = i > 0 ? s[i - 1] : ' ';
            const bool can_open = e < n && !is_space(s[e]) && run <= 3 &&
                                  (c != '_' || !is_alnum(prev));
            if (can_open) {
                const size_t cl = find_closer(s, n, e, c, run);
                if (cl != NPOS) {
                    const uint8_t add = run == 1 ? EM : run == 2 ? STRONG : (STRONG | EM);
                    render(s + e, cl - e, (uint8_t)(style | add), o, depth + 1);
                    i = cl + run;
                    continue;
                }
            }
            o.puts(s + i, run, style);
            i = e;
            continue;
        }

        if (c == '~' && i + 1 < n && s[i + 1] == '~' && depth < MAX_DEPTH &&
            i + 2 < n && !is_space(s[i + 2])) {
            size_t cl = NPOS;
            const size_t lim = i + LOOKAHEAD < n ? i + LOOKAHEAD : n;
            for (size_t j = i + 2; j + 1 < lim; j++) {
                if (s[j] == '~' && s[j + 1] == '~' && !is_space(s[j - 1])) { cl = j; break; }
            }
            if (cl != NPOS) {
                render(s + i + 2, cl - i - 2, (uint8_t)(style | DIM), o, depth + 1);
                i = cl + 2;
                continue;
            }
        }

        o.put(c, style);
        i++;
    }
}

// ---------------------------------------------------------------------------
// Block pass
// ---------------------------------------------------------------------------

struct Span {
    const char* p;
    size_t      n;
};

Span trim(const char* p, size_t n)
{
    while (n && is_space(*p)) { p++; n--; }
    while (n && is_space(p[n - 1])) n--;
    return { p, n };
}

bool has_pipe(const char* p, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if (p[i] == '\\') { i++; continue; }
        if (p[i] == '|') return true;
    }
    return false;
}

/// Cells of a table row: split on unescaped pipes, one leading and one
/// trailing pipe dropped.  Escapes stay in the text for render_inline.
void split_cells(const char* p, size_t n, std::vector<Span>& out)
{
    out.clear();
    Span t = trim(p, n);
    p = t.p;
    n = t.n;
    if (n && p[0] == '|') { p++; n--; }
    if (n && p[n - 1] == '|' && !(n >= 2 && p[n - 2] == '\\')) n--;
    size_t start = 0;
    for (size_t i = 0; i <= n; i++) {
        if (i < n && p[i] == '\\') { i++; continue; }
        if (i == n || p[i] == '|') {
            out.push_back(trim(p + start, i - start));
            start = i + 1;
        }
    }
}

bool delimiter_row(const char* p, size_t n, std::vector<Span>& cells, Align* align, int& ncols)
{
    if (!has_pipe(p, n)) return false;
    split_cells(p, n, cells);
    if (cells.empty()) return false;
    for (const Span& c : cells) {
        if (!c.n) return false;
        size_t a = 0, b = c.n;
        const bool left  = c.p[0] == ':';
        const bool right = c.p[c.n - 1] == ':';
        if (left) a++;
        if (right && b > a) b--;
        if (b <= a) return false;
        for (size_t k = a; k < b; k++) if (c.p[k] != '-') return false;
    }
    ncols = (int)cells.size() < MAX_COLS ? (int)cells.size() : MAX_COLS;
    for (int i = 0; i < ncols; i++) {
        const Span& c = cells[i];
        const bool left  = c.p[0] == ':';
        const bool right = c.n > 1 && c.p[c.n - 1] == ':';
        align[i] = left && right ? Align::Center : right ? Align::Right
                 : left ? Align::Left : Align::None;
    }
    return true;
}

bool is_rule(const char* p, size_t n)
{
    char ch = 0;
    int count = 0;
    for (size_t i = 0; i < n; i++) {
        const char c = p[i];
        if (is_space(c)) continue;
        if (c != '-' && c != '*' && c != '_') return false;
        if (ch && c != ch) return false;
        ch = c;
        count++;
    }
    return count >= 3;
}

/// Strip up to `limit` block-quote markers; returns the offset of the rest and
/// the depth found.
size_t strip_quotes(const char* s, size_t n, int limit, int& depth)
{
    depth = 0;
    size_t p = 0;
    while (depth < limit) {
        size_t k = p;
        int sp = 0;
        while (k < n && s[k] == ' ' && sp < 3) { k++; sp++; }
        if (k >= n || s[k] != '>') break;
        depth++;
        p = k + 1;
        if (p < n && s[p] == ' ') p++;
    }
    return p;
}

struct Parser {
    Doc& d;
    std::vector<Span> src_lines;
    std::vector<Span> cells;
    std::string       cell;           // one table cell, unescaped
    std::vector<int>  list;           // marker indent per open list level

    // paragraph being accumulated (raw inline text)
    bool        para_on    = false;
    std::string para;
    std::string prefix;               // list marker for the first line
    int32_t     para_src   = 0;
    uint8_t     para_quote = 0;
    uint8_t     para_indent = 0;
    bool        para_hard  = false;   // the last line ended in a hard break

    bool gap        = false;          // air owed before the next block
    bool prev_blank = true;
    int  last_quote = 0;

    bool in_fence = false;
    char fence_ch = 0;
    size_t fence_len = 0;
    size_t fence_indent = 0;
    int  fence_quote = 0;

    bool in_icode = false;
    bool in_comment = false;

    bool     in_table = false;
    uint16_t table = 0;

    explicit Parser(Doc& doc) : d(doc) {}

    Line& push(Kind k, int32_t src, int quote, int indent)
    {
        Line l;
        l.kind   = k;
        l.src    = src;
        l.quote  = (uint8_t)(quote > 255 ? 255 : quote);
        l.indent = (uint8_t)(indent > 255 ? 255 : indent);
        l.off    = (uint32_t)d.text.size();
        d.lines.push_back(l);
        return d.lines.back();
    }

    void close(Line& l) { l.len = (uint32_t)(d.text.size() - l.off); }

    void spacer(int32_t src, int quote)
    {
        if (d.lines.empty() || d.lines.back().kind == Kind::Spacer) return;
        // Air between blocks belongs to a quote only when both sides are in it.
        const int q = quote < d.lines.back().quote ? quote : d.lines.back().quote;
        close(push(Kind::Spacer, src, q, 0));
    }

    void begin_block(int32_t src, int quote)
    {
        if (gap) spacer(src, quote);
        gap = false;
    }

    void flush_para(Kind kind = Kind::Text, uint8_t level = 0)
    {
        if (!para_on) return;
        para_on = false;
        Line& l = push(kind, para_src, para_quote, kind == Kind::Heading ? 0 : para_indent);
        l.level = level;
        size_t off = l.off;
        if (kind == Kind::Text) {
            d.text += prefix;
            l.hang = (uint8_t)prefix.size();
        }
        Span t = trim(para.data(), para.size());
        render_inline(t.p, t.n, d.text);
        Line& back = d.lines.back();
        back.len = (uint32_t)(d.text.size() - off);
        para.clear();
        prefix.clear();
    }

    void end_table()
    {
        if (!in_table) return;
        in_table = false;
        gap = true;
    }

    void emit_row(const char* p, size_t n, int32_t src, int quote, uint16_t row)
    {
        Table& t = d.tables[table];
        split_cells(p, n, cells);
        Line& l = push(Kind::TableRow, src, quote, 0);
        l.table = table;
        l.row   = row;
        const uint32_t off = l.off;
        for (int c = 0; c < t.ncols; c++) {
            if (c) d.text += CELL_SEP;
            if (c >= (int)cells.size()) continue;
            // GFM unescapes \| at the table level, before inline parsing, so
            // it reads as a pipe even inside a code span.
            cell.clear();
            for (size_t i = 0; i < cells[c].n; i++) {
                if (cells[c].p[i] == '\\' && i + 1 < cells[c].n && cells[c].p[i + 1] == '|') continue;
                cell += cells[c].p[i];
            }
            render_inline(cell.data(), cell.size(), d.text);
        }
        d.lines.back().len = (uint32_t)(d.text.size() - off);
        t.rows++;
    }

    void code_line(const char* p, size_t n, int32_t src, int quote, int indent)
    {
        Line& l = push(Kind::Code, src, quote, indent);
        const uint32_t off = l.off;
        for (size_t i = 0; i < n; i++) {
            const unsigned char u = (unsigned char)p[i];
            d.text += u >= 0x80 ? '?' : u < 0x20 ? ' ' : (char)u;
        }
        d.lines.back().len = (uint32_t)(d.text.size() - off);
    }

    /// Appends a paragraph line, splitting at a pending hard break.
    void para_append(const char* p, size_t n, int32_t src, int quote, int indent)
    {
        // A hard break ends the line: two trailing spaces, a backslash, <br>.
        bool hard = false;
        size_t sp = 0;
        while (sp < n && p[n - 1 - sp] == ' ') sp++;
        if (sp >= 2) hard = true;
        Span t = trim(p, n);
        if (t.n && t.p[t.n - 1] == '\\') { hard = true; t.n--; }
        if (t.n >= 4) {
            const char* e = t.p + t.n;
            for (const char* br : { "<br>", "<br/>", "<br />" }) {
                const size_t bl = strlen(br);
                if (t.n >= bl && strncmp(e - bl, br, bl) == 0) { hard = true; t.n -= bl; break; }
            }
        }

        if (para_on && para_hard) {
            const uint8_t q = para_quote, ind = para_indent;
            flush_para();
            para_on = true;
            para_src = src;
            para_quote = q;
            para_indent = ind;
        } else if (para_on) {
            para += ' ';
        } else {
            para_on = true;
            para_src = src;
            para_quote = (uint8_t)quote;
            para_indent = (uint8_t)indent;
        }
        para.append(t.p, t.n);
        para_hard = hard;
    }

    bool list_marker(const char* t, size_t n, size_t& after, std::string& mark)
    {
        if (!n) return false;
        if ((t[0] == '-' || t[0] == '*' || t[0] == '+') && (n == 1 || t[1] == ' ')) {
            mark.assign(1, (char)GLYPH_BULLET);
            after = 1;
            return true;
        }
        size_t k = 0;
        while (k < n && k < 9 && t[k] >= '0' && t[k] <= '9') k++;
        if (k == 0 || k >= n || (t[k] != '.' && t[k] != ')')) return false;
        if (k + 1 < n && t[k + 1] != ' ') return false;
        mark.assign(t, k + 1);
        after = k + 1;
        return true;
    }

    void line(size_t li)
    {
        const char* s = src_lines[li].p;
        const size_t n = src_lines[li].n;
        const int32_t src = (int32_t)li;

        if (in_comment) {
            for (size_t i = 0; i + 2 < n; i++) {
                if (s[i] == '-' && s[i + 1] == '-' && s[i + 2] == '>') { in_comment = false; break; }
            }
            return;
        }

        int q = 0;
        size_t p = strip_quotes(s, n, in_fence ? fence_quote : 64, q);

        if (in_fence) {
            if (q < fence_quote) {
                in_fence = false;   // the quote holding it ended
                gap = true;
                p = strip_quotes(s, n, 64, q);
            } else {
                const char* c = s + p;
                const size_t cl = n - p;
                size_t k = 0;
                while (k < cl && k < 3 && c[k] == ' ') k++;
                size_t r = k;
                while (r < cl && c[r] == fence_ch) r++;
                if (r - k >= fence_len && trim(c + r, cl - r).n == 0) {
                    in_fence = false;
                    gap = true;
                    return;
                }
                size_t skip = 0;
                while (skip < cl && skip < fence_indent && c[skip] == ' ') skip++;
                code_line(c + skip, cl - skip, src, q, list.size());
                return;
            }
        }

        const char* c = s + p;
        const size_t cl = n - p;
        const Span tr = trim(c, cl);

        // ---- blank
        if (tr.n == 0) {
            flush_para();
            end_table();
            if (in_icode) in_icode = false;
            gap = !d.lines.empty();
            prev_blank = true;
            return;
        }

        if (q != last_quote) {
            flush_para();
            end_table();
            if (in_icode) in_icode = false;
            gap = true;
            last_quote = q;
        }

        size_t indent = 0;
        while (indent < cl && c[indent] == ' ') indent++;
        const char* t = c + indent;
        const size_t tl = cl - indent;

        // ---- indented code (outside lists, not continuing a paragraph)
        if (indent >= 4 && !para_on && list.empty() && !in_table) {
            if (!in_icode) begin_block(src, q);
            in_icode = true;
            code_line(c + 4, cl - 4, src, q, 0);
            prev_blank = false;
            return;
        }
        if (in_icode) { in_icode = false; gap = true; }

        // ---- HTML comment
        if (tl >= 4 && strncmp(t, "<!--", 4) == 0) {
            flush_para();
            bool closed = false;
            for (size_t i = 4; i + 2 < tl; i++) {
                if (t[i] == '-' && t[i + 1] == '-' && t[i + 2] == '>') { closed = true; break; }
            }
            in_comment = !closed;
            return;
        }

        // ---- fence open
        if (tl >= 3 && (t[0] == '`' || t[0] == '~')) {
            size_t r = 0;
            while (r < tl && t[r] == t[0]) r++;
            bool ok = r >= 3;
            if (ok && t[0] == '`') {
                for (size_t i = r; i < tl; i++) if (t[i] == '`') { ok = false; break; }
            }
            if (ok) {
                flush_para();
                end_table();
                gap = gap || !d.lines.empty();
                begin_block(src, q);
                in_fence = true;
                fence_ch = t[0];
                fence_len = r;
                fence_indent = indent;
                fence_quote = q;
                prev_blank = false;
                return;
            }
        }

        // ---- ATX heading
        if (indent <= 3 && t[0] == '#') {
            size_t h = 0;
            while (h < tl && t[h] == '#') h++;
            if (h <= 6 && (h == tl || t[h] == ' ')) {
                flush_para();
                end_table();
                list.clear();
                gap = !d.lines.empty();
                begin_block(src, q);
                Span body = trim(t + h, tl - h);
                // Closing #s, when separated by a space.
                size_t e = body.n;
                while (e && body.p[e - 1] == '#') e--;
                if (e < body.n && (e == 0 || body.p[e - 1] == ' ')) body = trim(body.p, e);
                Line& l = push(Kind::Heading, src, q, 0);
                l.level = (uint8_t)h;
                const uint32_t off = l.off;
                render_inline(body.p, body.n, d.text);
                d.lines.back().len = (uint32_t)(d.text.size() - off);
                gap = true;
                prev_blank = false;
                return;
            }
        }

        // ---- setext underline
        if (para_on && prefix.empty() && para_indent == 0 && indent <= 3 &&
            (tr.p[0] == '=' || tr.p[0] == '-')) {
            bool all = true;
            for (size_t i = 0; i < tr.n; i++) if (tr.p[i] != tr.p[0]) { all = false; break; }
            if (all && (tr.p[0] == '=' || tr.n >= 2)) {
                flush_para(Kind::Heading, tr.p[0] == '=' ? 1 : 2);
                gap = true;
                prev_blank = false;
                return;
            }
        }

        // ---- thematic break
        if (indent <= 3 && is_rule(t, tl)) {
            flush_para();
            end_table();
            list.clear();
            begin_block(src, q);
            close(push(Kind::Rule, src, q, 0));
            gap = true;
            prev_blank = false;
            return;
        }

        // ---- table
        if (in_table) {
            if (has_pipe(t, tl)) {
                emit_row(t, tl, src, q, (uint16_t)d.tables[table].rows);
                prev_blank = false;
                return;
            }
            end_table();
        }
        if (has_pipe(t, tl) && li + 1 < src_lines.size()) {
            int nq = 0;
            const Span& nx = src_lines[li + 1];
            const size_t np = strip_quotes(nx.p, nx.n, 64, nq);
            Table tb;
            int ncols = 0;
            if (nq == q && delimiter_row(nx.p + np, nx.n - np, cells, tb.align, ncols)) {
                flush_para();
                list.clear();
                gap = !d.lines.empty();   // a table always gets air above it
                begin_block(src, q);
                tb.ncols = (uint8_t)ncols;
                d.tables.push_back(tb);
                table = (uint16_t)(d.tables.size() - 1);
                in_table = true;
                emit_row(t, tl, src, q, 0);
                skip_next = true;   // the delimiter row
                prev_blank = false;
                return;
            }
        }

        // ---- list item
        size_t after = 0;
        std::string mark;
        if (list_marker(t, tl, after, mark)) {
            flush_para();
            while (!list.empty() && (int)indent < list.back() + 2) list.pop_back();
            begin_block(src, q);
            list.push_back((int)indent);
            size_t r = after;
            while (r < tl && r < after + 4 && t[r] == ' ') r++;
            // Task item: the checkbox replaces the bullet.
            if (r + 2 < tl && t[r] == '[' && (t[r + 1] == ' ' || t[r + 1] == 'x' || t[r + 1] == 'X') &&
                t[r + 2] == ']' && (r + 3 == tl || t[r + 3] == ' ')) {
                mark.assign(1, (char)(t[r + 1] == ' ' ? GLYPH_TASK_OPEN : GLYPH_TASK_DONE));
                r += 3;
                while (r < tl && t[r] == ' ') r++;
            }
            para_on = true;
            para.clear();
            para_src = src;
            para_quote = (uint8_t)q;
            para_indent = (uint8_t)list.size();
            para_hard = false;
            prefix = mark;
            prefix += ' ';
            if (r < tl) para_append(t + r, tl - r, src, q, list.size());
            prev_blank = false;
            return;
        }

        // ---- paragraph text
        if (para_on && !prev_blank) {
            para_append(t, tl, src, q, para_indent);
            prev_blank = false;
            return;
        }
        int depth = 0;
        if (!list.empty()) {
            if (indent >= 2 || !prev_blank) {
                // Inside the deepest item whose marker it is indented past.
                while (!list.empty() && (int)indent < list.back() + 2 && prev_blank) list.pop_back();
                depth = (int)list.size();
            } else {
                list.clear();
            }
        }
        begin_block(src, q);
        para_hard = false;
        para_append(t, tl, src, q, depth);
        prev_blank = false;
    }

    bool skip_next = false;

    void run(const char* s, size_t n)
    {
        size_t pos = 0;
        while (pos <= n) {
            size_t e = pos;
            while (e < n && s[e] != '\n') e++;
            size_t len = e - pos;
            if (len && s[pos + len - 1] == '\r') len--;
            src_lines.push_back({ s + pos, len });
            if (e >= n) break;
            pos = e + 1;
        }
        if (src_lines.size() > 1 && src_lines.back().n == 0 && n && s[n - 1] == '\n') {
            src_lines.pop_back();
        }
        for (size_t li = 0; li < src_lines.size(); li++) {
            if (skip_next) { skip_next = false; continue; }
            line(li);
        }
        flush_para();
        while (!d.lines.empty() && d.lines.back().kind == Kind::Spacer) d.lines.pop_back();
    }
};

}  // namespace

void render_inline(const char* s, size_t n, std::string& out)
{
    Out o{ out };
    render(s, n, 0, o, 0);
    // Leave the text in style 0 so whatever is appended next (another cell,
    // another line) does not inherit a bold that ran to the end.
    if (o.cur) out += (char)STYLE_MARK;
}

void parse(const char* src, size_t n, Doc& out)
{
    out.clear();
    out.text.reserve(n + n / 16);
    Parser p(out);
    p.run(src, n);
}

std::string plain(const char* r, size_t n)
{
    std::string s;
    s.reserve(n);
    for (size_t i = 0; i < n; i++) {
        const unsigned char c = (unsigned char)r[i];
        if (is_style(c)) continue;
        if (c == GLYPH_BULLET)         s += '*';
        else if (c == GLYPH_TASK_OPEN) s += "[ ]";
        else if (c == GLYPH_TASK_DONE) s += "[x]";
        else if (c == (unsigned char)CELL_SEP) s += '|';
        else                            s += (char)c;
    }
    return s;
}

}  // namespace dirigible::md
