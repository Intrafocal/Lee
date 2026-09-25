#include "dirigible/fs.hpp"
#include "cJSON.h"
#include <cctype>
#include <cstring>

namespace dirigible {

// ---------------------------------------------------------------------------
// Classification — same extension sets as Aeronaut's fs_entry.dart, so a file
// renders as the same kind on both clients.
// ---------------------------------------------------------------------------

static std::string extension_of(const std::string& path) {
    size_t slash = path.find_last_of('/');
    std::string base = slash == std::string::npos ? path : path.substr(slash + 1);
    size_t dot = base.find_last_of('.');
    if (dot == std::string::npos || dot == 0 || dot == base.size() - 1) return "";
    std::string ext = base.substr(dot + 1);
    for (auto& c : ext) c = (char)tolower((unsigned char)c);
    return ext;
}

static bool in_set(const std::string& ext, const char* const* set) {
    for (; *set; set++) {
        if (ext == *set) return true;
    }
    return false;
}

FileViewKind classify_file(const std::string& path) {
    static const char* const markdown[] = { "md", "markdown", nullptr };
    static const char* const image[] = {
        "png", "jpg", "jpeg", "gif", "webp", "svg", nullptr };
    static const char* const code[] = {
        "dart", "ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "h",
        "cpp", "hpp", "cc", "cxx", "rb", "php", "sql", "sh", "bash", "zsh",
        "yaml", "yml", "json", "toml", "xml", "html", "css", "scss", "less",
        "kt", "swift", nullptr };

    const std::string ext = extension_of(path);
    if (in_set(ext, markdown)) return FileViewKind::Markdown;
    if (in_set(ext, image))    return FileViewKind::Image;
    if (ext == "pdf")          return FileViewKind::Pdf;
    if (in_set(ext, code))     return FileViewKind::Code;
    return FileViewKind::Text;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

FsError fs_error_for_status(int status) {
    switch (status) {
    case 200: return FsError::None;
    case 0:   return FsError::Network;
    case 401: return FsError::Unauthorized;
    case 403: return FsError::Forbidden;
    case 404: return FsError::NotFound;
    case 413: return FsError::TooLarge;
    case 415: return FsError::Unviewable;
    default:  return FsError::Other;
    }
}

static std::string get_str(cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return (item && cJSON_IsString(item) && item->valuestring)
        ? std::string(item->valuestring) : std::string();
}

static double get_num(cJSON* obj, const char* key) {
    cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
    return (item && cJSON_IsNumber(item)) ? item->valuedouble : 0;
}

static std::string error_message(int status, cJSON* resp) {
    std::string msg = resp ? get_str(resp, "error") : std::string();
    if (!msg.empty()) return msg;
    if (status == 0) return "Lee did not answer";
    return "HTTP " + std::to_string(status);
}

void fs_list_parse(int status, cJSON* resp, FsListResult& out) {
    out.error = fs_error_for_status(status);
    if (out.error == FsError::None && !resp) out.error = FsError::Network;
    if (out.error != FsError::None) {
        out.message = error_message(status, resp);
        return;
    }

    cJSON* data = cJSON_GetObjectItemCaseSensitive(resp, "data");
    out.path = get_str(data, "path");
    cJSON* arr = cJSON_GetObjectItemCaseSensitive(data, "entries");
    if (!arr || !cJSON_IsArray(arr)) return;

    out.entries.reserve(cJSON_GetArraySize(arr));
    cJSON* item = nullptr;
    cJSON_ArrayForEach(item, arr) {
        FsEntry e;
        e.name     = get_str(item, "name");
        e.type     = get_str(item, "type");
        if (e.type.empty()) e.type = "file";
        e.size     = (int64_t)get_num(item, "size");
        e.mtime_ms = get_num(item, "mtimeMs");
        out.entries.push_back(std::move(e));
    }
}

void fs_read_parse(int status, cJSON* resp, FsReadResult& out) {
    out.error = fs_error_for_status(status);
    if (out.error == FsError::None && !resp) out.error = FsError::Network;

    // 200, 413 and 415 all carry metadata under "data".
    cJSON* data = resp ? cJSON_GetObjectItemCaseSensitive(resp, "data") : nullptr;
    if (data && cJSON_IsObject(data)) {
        out.has_meta = true;
        out.path     = get_str(data, "path");
        out.size     = (int64_t)get_num(data, "size");
        out.mtime_ms = get_num(data, "mtimeMs");
        out.mime     = get_str(data, "mime");
        if (out.error == FsError::None) {
            out.encoding = get_str(data, "encoding");
            cJSON* c = cJSON_GetObjectItemCaseSensitive(data, "content");
            if (c && cJSON_IsString(c) && c->valuestring) out.content = c->valuestring;
        }
    }
    if (out.error != FsError::None) out.message = error_message(status, resp);
}

std::string url_encode(const std::string& s) {
    static const char hex[] = "0123456789ABCDEF";
    std::string out;
    out.reserve(s.size() + 16);
    for (unsigned char c : s) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || c == '/') {
            out += (char)c;
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0x0F];
        }
    }
    return out;
}

}  // namespace dirigible
