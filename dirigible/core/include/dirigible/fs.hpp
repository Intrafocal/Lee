#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct cJSON;

namespace dirigible {

// ---------------------------------------------------------------------------
// Read-only filesystem models for Lee's `GET /fs/list` and `GET /fs/read`
// (electron/src/main/api-server.ts).  Mirrors Aeronaut's fs_entry.dart /
// fs_api.dart so both clients classify files and report errors the same way.
// ---------------------------------------------------------------------------

/// Why an `/fs/*` request didn't return content (Aeronaut's FsErrorKind).
enum class FsError {
    None,
    Forbidden,      // 403 — outside every open window's workspace
    NotFound,       // 404
    TooLarge,       // 413 — over Lee's 2 MB cap; metadata still present
    Unviewable,     // 415 — binary Lee won't base64; metadata still present
    Unauthorized,   // 401 — token rejected
    Network,        // no response / unparseable
    Other,
};

/// How the viewer renders a file, decided purely from its extension.
enum class FileViewKind { Markdown, Code, Image, Pdf, Binary, Text };

FileViewKind classify_file(const std::string& path);

struct FsEntry {
    std::string name;
    std::string type;     // "file" | "dir" | "symlink"
    int64_t     size     = 0;
    double      mtime_ms = 0;

    bool isDir() const     { return type == "dir"; }
    bool isSymlink() const { return type == "symlink"; }
};

struct FsListResult {
    FsError              error = FsError::None;
    std::string          message;
    std::string          path;
    std::vector<FsEntry> entries;   // dirs first, then files (Lee sorts)
};

struct FsReadResult {
    FsError     error = FsError::None;
    std::string message;
    std::string path;
    int64_t     size     = 0;
    double      mtime_ms = 0;
    std::string mime;
    std::string encoding;   // "utf8" | "base64" | "" (stat-only / refused)
    std::string content;
    bool        has_meta = false;   // metadata present (200, 413, 415)

    bool isUtf8() const { return encoding == "utf8"; }
};

/// Map an HTTP status to FsError (0 = transport failure).
FsError fs_error_for_status(int status);

/// Parse a `/fs/list` response body into `out` (status already mapped).
void fs_list_parse(int status, cJSON* resp, FsListResult& out);

/// Parse a `/fs/read` response body into `out` (status already mapped).
void fs_read_parse(int status, cJSON* resp, FsReadResult& out);

/// Percent-encode a query parameter value (RFC 3986 unreserved kept).
std::string url_encode(const std::string& s);

}  // namespace dirigible
