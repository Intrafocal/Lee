/*
 * ui_text.cpp — see ui_text.hpp.
 */

#include "ui_text.hpp"

#include <cstring>

namespace dirigible_app {

std::string ui_fold(const std::string& in, bool keep_newlines)
{
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size();) {
        const unsigned char c = (unsigned char)in[i];
        if (c < 0x80) {
            if (c == '\n' && keep_newlines)                  out += '\n';
            else if (c == '\t' || c == '\n' || c == '\r')   out += ' ';
            else if (c >= 0x20 && c < 0x7F)                  out += (char)c;
            i++;
            continue;
        }
        int len = (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 1;
        if (i + len > in.size()) len = (int)(in.size() - i);
        const std::string cp = in.substr(i, len);
        // U+F000..U+F8FF is EF 80 80 .. EF A3 BF: LVGL's LV_SYMBOL_* range,
        // which Montserrat carries.
        const bool symbol = len == 3 && c == 0xEF &&
                            (unsigned char)in[i + 1] >= 0x80 && (unsigned char)in[i + 1] <= 0xA3;
        if (symbol)                                              out += cp;
        else if (cp == "\xE2\x80\x98" || cp == "\xE2\x80\x99") out += '\'';
        else if (cp == "\xE2\x80\x9C" || cp == "\xE2\x80\x9D") out += '"';
        else if (cp == "\xE2\x80\x93" || cp == "\xE2\x80\x94") out += '-';
        else if (cp == "\xE2\x80\xA6")                           out += "...";
        else if (cp == "\xC2\xB7" || cp == "\xE2\x80\xA2")       out += LV_SYMBOL_BULLET;
        else if (cp == "\xE2\x86\x92")                           out += "->";
        else if (cp == "\xC2\xA0")                               out += ' ';
        else                                                     out += '?';
        i += len;
    }
    return out;
}

std::string ui_fold(const char* in, bool keep_newlines)
{
    return ui_fold(std::string(in ? in : ""), keep_newlines);
}

void ui_set_text(lv_obj_t* label, const char* text)
{
    if (!label) return;
    lv_label_set_text(label, ui_fold(text, true).c_str());
}

int ui_char_w(const lv_font_t* font, unsigned char c)
{
    struct Table { const lv_font_t* font; uint8_t w[96]; };
    static Table tables[6];
    static int   used = 0;

    if (c < 0x20 || c >= 0x7F) c = '?';
    for (int i = 0; i < used; i++) {
        if (tables[i].font == font) return tables[i].w[c - 0x20];
    }
    Table& t = tables[used < 6 ? used++ : 5];
    t.font = font;
    for (int k = 0; k < 96; k++) {
        t.w[k] = (uint8_t)lv_font_get_glyph_width(font, (uint32_t)(0x20 + k), 0);
    }
    return t.w[c - 0x20];
}

std::string ui_fit_tail(const std::string& text, const lv_font_t* font, int max_w)
{
    int w = 0;
    for (unsigned char c : text) w += ui_char_w(font, c);
    if (w <= max_w) return text;

    const int budget = max_w - 2 * ui_char_w(font, '.');
    int tail_w = 0;
    size_t start = text.size();
    while (start > 0) {
        const int cw = ui_char_w(font, (unsigned char)text[start - 1]);
        if (tail_w + cw > budget) break;
        tail_w += cw;
        start--;
    }
    return ".." + text.substr(start);
}

}  // namespace dirigible_app
