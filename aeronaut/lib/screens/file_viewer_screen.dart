import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_svg/flutter_svg.dart';

import '../models/fs_entry.dart';
import '../providers/machines_provider.dart';
import '../services/fs_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/phosphor_icon.dart';

/// Cap on how much of an unclassified-but-text file is actually displayed.
/// The server already caps the *transfer* at 2 MB (`/fs/read`); this trims
/// the *render* for the generic "everything else" text fallback so a big
/// log file doesn't build a giant text widget.
const int _genericTextDisplayCap = 64 * 1024; // 64 KB

/// Read-only file viewer: fetches a file via `GET /fs/read` and renders it
/// by [FileViewKind] — markdown, syntax-free monospace code with line
/// numbers, inline images (raster + SVG), a metadata placeholder for PDFs
/// (no PDF renderer dependency), or metadata + a text preview for anything
/// else that turns out to be UTF-8.
///
/// Used two ways:
/// - embedded for an editor-like tab (`file`/`editor`/`editor-panel`), where
///   the caller passes [modified] from the tab's live `EditorContext` and
///   rebuilds this widget with a new [filePath] whenever the context
///   reports the tab now points at a different file — `didUpdateWidget`
///   below reloads in response;
/// - pushed as a full route from the Files browser, where [modified] is
///   just false.
class FileViewerScreen extends ConsumerStatefulWidget {
  final String filePath;
  final bool modified;

  const FileViewerScreen({
    required this.filePath,
    this.modified = false,
    super.key,
  });

  @override
  ConsumerState<FileViewerScreen> createState() => _FileViewerScreenState();
}

class _FileViewerScreenState extends ConsumerState<FileViewerScreen> {
  FsReadResult? _result;
  FsApiException? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant FileViewerScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.filePath != widget.filePath) {
      _load();
    }
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      setState(() => _loading = false);
      return;
    }
    final api = FsApi(machine: machine);
    try {
      final result = await api.readFile(widget.filePath);
      if (!mounted) return;
      setState(() {
        _result = result;
        _error = null;
        _loading = false;
      });
    } on FsApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _result = e.result; // 413/415 still carry metadata
        _loading = false;
      });
    } finally {
      api.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Header(
          path: widget.filePath,
          result: _result,
          modified: widget.modified,
          onRefresh: _load,
        ),
        const Divider(height: 1),
        Expanded(child: _buildBody()),
      ],
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(
        child: CircularProgressIndicator.adaptive(
          strokeWidth: 2,
        ),
      );
    }

    if (_error != null) {
      switch (_error!.kind) {
        case FsErrorKind.tooLarge:
          return _MessageView(
            icon: PhosphorIcons.warning,
            title: 'File too large to view',
            message: _result != null
                ? '${_formatBytes(_result!.size)} is over the 2 MB viewer cap.'
                : _error!.message,
          );
        case FsErrorKind.unviewable:
          return _MessageView(
            icon: PhosphorIcons.fileCode,
            title: 'Binary file',
            message: _result != null
                ? '${_formatBytes(_result!.size)} — no preview available for this file type.'
                : _error!.message,
          );
        case FsErrorKind.forbidden:
          return const _MessageView(
            icon: PhosphorIcons.lock,
            title: 'Outside workspace',
            message: 'This path is outside every open Lee workspace.',
          );
        case FsErrorKind.notFound:
          return const _MessageView(
            icon: PhosphorIcons.search,
            title: 'Not found',
            message: 'The file may have been moved or deleted.',
          );
        case FsErrorKind.unauthorized:
          return const _MessageView(
            icon: PhosphorIcons.lock,
            title: 'Token rejected',
            message: 'Re-pair this machine.',
          );
        case FsErrorKind.network:
        case FsErrorKind.other:
          return _MessageView(
            icon: PhosphorIcons.warning,
            title: 'Couldn\'t load file',
            message: _error!.message,
          );
      }
    }

    final result = _result;
    if (result == null || result.content == null) {
      return const _MessageView(
        icon: PhosphorIcons.book,
        title: 'No content',
        message: 'Nothing to show.',
      );
    }

    final kind = classifyFile(widget.filePath);
    switch (kind) {
      case FileViewKind.markdown:
        return result.isUtf8
            ? _MarkdownView(content: result.content!)
            : _MessageView(
                icon: PhosphorIcons.book,
                title: 'Unexpected encoding',
                message: 'Expected utf8 markdown, got ${result.encoding}.',
              );
      case FileViewKind.code:
        return result.isUtf8
            ? _CodeView(content: result.content!)
            : _MessageView(
                icon: PhosphorIcons.fileCode,
                title: 'Unexpected encoding',
                message: 'Expected utf8 source, got ${result.encoding}.',
              );
      case FileViewKind.image:
        return result.isBase64
            ? _ImageView(mime: result.mime, base64Content: result.content!)
            : _MessageView(
                icon: PhosphorIcons.image,
                title: 'Unexpected encoding',
                message: 'Expected base64 image, got ${result.encoding}.',
              );
      case FileViewKind.pdf:
        // No PDF renderer dependency — show metadata instead of trying to
        // open the file some other way that isn't available on this build.
        return _MessageView(
          // No PDF icon in the Phosphor set; generic file is the closest fit.
          icon: PhosphorIcons.fileCode,
          title: 'PDF preview not available',
          message:
              '${_formatBytes(result.size)} — opening in Files/Safari is '
              'not available from here yet. Focus the tab on the desktop '
              'to view it in Lee.',
        );
      case FileViewKind.binary:
      case FileViewKind.text:
        if (!result.isUtf8) {
          return _MessageView(
            icon: PhosphorIcons.fileCode,
            title: 'Binary file',
            message: '${_formatBytes(result.size)} — no preview available.',
          );
        }
        final content = result.content!;
        final truncated = content.length > _genericTextDisplayCap;
        final shown =
            truncated ? content.substring(0, _genericTextDisplayCap) : content;
        return _GenericTextView(content: shown, truncated: truncated);
    }
  }
}

class _Header extends StatelessWidget {
  final String path;
  final FsReadResult? result;
  final bool modified;
  final VoidCallback onRefresh;

  const _Header({
    required this.path,
    required this.result,
    required this.modified,
    required this.onRefresh,
  });

  @override
  Widget build(BuildContext context) {
    final fileName = path.split('/').last;
    return Container(
      color: AeronautColors.bgSurface,
      padding: const EdgeInsets.symmetric(
        horizontal: AeronautTheme.spacingMd,
        vertical: AeronautTheme.spacingSm,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        fileName,
                        overflow: TextOverflow.ellipsis,
                        style: AeronautTheme.subheadline.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    if (modified)
                      Container(
                        width: 8,
                        height: 8,
                        margin: const EdgeInsets.only(left: 6),
                        decoration: const BoxDecoration(
                          shape: BoxShape.circle,
                          color: AeronautColors.warning,
                        ),
                      ),
                  ],
                ),
                Text(
                  path,
                  overflow: TextOverflow.ellipsis,
                  style: AeronautTheme.caption2,
                ),
                if (result != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      '${_formatBytes(result!.size)} · ${_formatMtime(result!.mtime)}',
                      style: AeronautTheme.caption2.copyWith(
                        color: AeronautColors.textTertiary,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            icon: const PhosphorIcon(PhosphorIcons.refresh, size: 20),
            tooltip: 'Refresh',
            onPressed: onRefresh,
          ),
        ],
      ),
    );
  }
}

class _MarkdownView extends StatelessWidget {
  final String content;
  const _MarkdownView({required this.content});

  @override
  Widget build(BuildContext context) {
    return Markdown(
      data: content,
      padding: const EdgeInsets.all(AeronautTheme.spacingMd),
      styleSheet: AeronautTheme.markdown(context, compact: true),
    );
  }
}

/// Plain monospace source view with a line-number gutter. No syntax
/// highlighting — see the CLAUDE.md design note on why that was left out.
class _CodeView extends StatelessWidget {
  final String content;
  const _CodeView({required this.content});

  @override
  Widget build(BuildContext context) {
    final lines = content.split('\n');
    // Trailing newline produces one empty trailing "line" — drop it so the
    // gutter numbering matches what an editor would show.
    final effectiveLines =
        lines.isNotEmpty && lines.last.isEmpty && content.endsWith('\n')
            ? lines.sublist(0, lines.length - 1)
            : lines;
    final gutterWidth = '${effectiveLines.length}'.length;

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(
          vertical: AeronautTheme.spacingSm,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < effectiveLines.length; i++)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AeronautTheme.spacingSm,
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: (gutterWidth * 9).toDouble() + 8,
                      child: Text(
                        '${i + 1}',
                        textAlign: TextAlign.right,
                        style: AeronautTheme.mono.copyWith(
                          color: AeronautColors.textTertiary,
                        ),
                      ),
                    ),
                    const SizedBox(width: AeronautTheme.spacingSm),
                    Text(
                      effectiveLines[i].isEmpty ? ' ' : effectiveLines[i],
                      style: AeronautTheme.mono,
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _ImageView extends StatelessWidget {
  final String mime;
  final String base64Content;
  const _ImageView({required this.mime, required this.base64Content});

  @override
  Widget build(BuildContext context) {
    late final Uint8List bytes;
    try {
      bytes = base64Decode(base64Content);
    } catch (_) {
      return const _MessageView(
        icon: PhosphorIcons.image,
        title: 'Couldn\'t decode image',
        message: 'The base64 payload was malformed.',
      );
    }

    final isSvg = mime == 'image/svg+xml';
    return Container(
      color: AeronautColors.bgPrimary,
      child: InteractiveViewer(
        minScale: 0.5,
        maxScale: 6,
        child: Center(
          child: isSvg
              ? SvgPicture.memory(bytes, fit: BoxFit.contain)
              : Image.memory(bytes, fit: BoxFit.contain),
        ),
      ),
    );
  }
}

class _GenericTextView extends StatelessWidget {
  final String content;
  final bool truncated;
  const _GenericTextView({required this.content, required this.truncated});

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(AeronautTheme.spacingMd),
      children: [
        if (truncated)
          Padding(
            padding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
            child: Text(
              'Showing the first 64 KB.',
              style: AeronautTheme.caption1.copyWith(
                color: AeronautColors.warning,
              ),
            ),
          ),
        SelectableText(content, style: AeronautTheme.mono),
      ],
    );
  }
}

class _MessageView extends StatelessWidget {
  final PhosphorIconData icon;
  final String title;
  final String message;

  const _MessageView({
    required this.icon,
    required this.title,
    required this.message,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AeronautTheme.spacingXl),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            PhosphorIcon(icon, size: 40, color: AeronautColors.textTertiary),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(
              title,
              style: AeronautTheme.headline.copyWith(
                color: AeronautColors.textSecondary,
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AeronautTheme.caption1,
            ),
          ],
        ),
      ),
    );
  }
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(2)} MB';
}

String _formatMtime(DateTime dt) {
  final local = dt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}
