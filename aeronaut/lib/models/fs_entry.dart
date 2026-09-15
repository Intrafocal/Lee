import 'package:equatable/equatable.dart';

/// How the file viewer should render a file, decided purely from its
/// extension (mirrors the classification Lee's own tab-routing does in
/// `App.tsx`'s `handleFileOpen`: kicad/model/pdf extensions get a dedicated
/// pane, everything else is text unless a NUL-byte sniff says otherwise).
enum FileViewKind { markdown, code, image, pdf, binary, text }

const Set<String> _markdownExts = {'md', 'markdown'};

/// Raster/vector image extensions Lee's `/fs/read` returns as base64.
const Set<String> _imageExts = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'};

/// Extensions with a recognizable source language — rendered monospace with
/// line numbers. Not exhaustive; anything else still renders as `.text`.
const Set<String> _codeExts = {
  'dart', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp',
  'hpp', 'cc', 'cxx', 'rb', 'php', 'sql', 'sh', 'bash', 'zsh', 'yaml', 'yml',
  'json', 'toml', 'xml', 'html', 'css', 'scss', 'less', 'kt', 'swift',
};

/// Classify a file purely by its extension, for viewer routing.
///
/// This is intentionally cheap and content-independent — the actual binary
/// vs. text call for anything not in [_imageExts] is made server-side by
/// `/fs/read`'s NUL-byte sniff (surfaced as a 415, see [FsApi.readFile]).
FileViewKind classifyFile(String path) {
  final ext = _extensionOf(path);
  if (_markdownExts.contains(ext)) return FileViewKind.markdown;
  if (_imageExts.contains(ext)) return FileViewKind.image;
  if (ext == 'pdf') return FileViewKind.pdf;
  if (_codeExts.contains(ext)) return FileViewKind.code;
  return FileViewKind.text;
}

String _extensionOf(String path) {
  final base = path.split('/').last;
  final dot = base.lastIndexOf('.');
  if (dot <= 0 || dot == base.length - 1) return '';
  return base.substring(dot + 1).toLowerCase();
}

/// Result of `GET /fs/read` on Lee (`electron/src/main/api-server.ts`).
///
/// `content`/`encoding` are null when the request used `?stat=1` (metadata
/// only) or when the server refused the body (413 too large, 415 binary
/// not viewable) but still returned metadata alongside the error.
class FsReadResult extends Equatable {
  final String path;
  final int size;
  final double mtimeMs;
  final String mime;
  final String? encoding; // 'utf8' | 'base64' | null
  final String? content;

  const FsReadResult({
    required this.path,
    required this.size,
    required this.mtimeMs,
    required this.mime,
    this.encoding,
    this.content,
  });

  DateTime get mtime => DateTime.fromMillisecondsSinceEpoch(mtimeMs.round());

  bool get isBase64 => encoding == 'base64';
  bool get isUtf8 => encoding == 'utf8';

  factory FsReadResult.fromJson(Map<String, dynamic> json) {
    return FsReadResult(
      path: json['path'] as String? ?? '',
      size: (json['size'] as num?)?.toInt() ?? 0,
      mtimeMs: (json['mtimeMs'] as num?)?.toDouble() ?? 0,
      mime: json['mime'] as String? ?? 'application/octet-stream',
      encoding: json['encoding'] as String?,
      content: json['content'] as String?,
    );
  }

  @override
  List<Object?> get props => [path, size, mtimeMs, mime, encoding, content];
}

/// One entry from `GET /fs/list`.
class FsEntryInfo extends Equatable {
  final String name;
  final String type; // 'file' | 'dir' | 'symlink'
  final int size;
  final double mtimeMs;

  const FsEntryInfo({
    required this.name,
    required this.type,
    required this.size,
    required this.mtimeMs,
  });

  bool get isDir => type == 'dir';
  bool get isSymlink => type == 'symlink';

  DateTime get mtime => DateTime.fromMillisecondsSinceEpoch(mtimeMs.round());

  factory FsEntryInfo.fromJson(Map<String, dynamic> json) {
    return FsEntryInfo(
      name: json['name'] as String? ?? '',
      type: json['type'] as String? ?? 'file',
      size: (json['size'] as num?)?.toInt() ?? 0,
      mtimeMs: (json['mtimeMs'] as num?)?.toDouble() ?? 0,
    );
  }

  @override
  List<Object?> get props => [name, type, size, mtimeMs];
}

/// Result of `GET /fs/list`.
class FsListResult extends Equatable {
  final String path;
  final List<FsEntryInfo> entries;

  const FsListResult({required this.path, required this.entries});

  factory FsListResult.fromJson(Map<String, dynamic> json) {
    final entriesJson = json['entries'] as List<dynamic>? ?? [];
    return FsListResult(
      path: json['path'] as String? ?? '',
      entries: entriesJson
          .map((e) => FsEntryInfo.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  @override
  List<Object?> get props => [path, entries];
}
