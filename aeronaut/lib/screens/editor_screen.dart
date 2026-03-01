import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/lee_context.dart';
import '../providers/context_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Editor screen showing reactive file metadata from the WebSocket context.
///
/// Watches the editorProvider for real-time updates to file, cursor,
/// language, and modified state.
class EditorScreen extends ConsumerWidget {
  const EditorScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final editor = ref.watch(editorProvider);

    if (editor == null || editor.file == null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(
              Icons.code,
              size: 48,
              color: AeronautColors.textTertiary,
            ),
            const SizedBox(height: AeronautTheme.spacingMd),
            Text(
              'No file open',
              style: AeronautTheme.body.copyWith(
                color: AeronautColors.textSecondary,
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Collapsible file path breadcrumb
        _FileBreadcrumb(editor: editor),
        // Cursor + language bar
        Container(
          padding: const EdgeInsets.symmetric(
            horizontal: AeronautTheme.spacingMd,
            vertical: AeronautTheme.spacingXs,
          ),
          color: AeronautColors.bgSurface,
          child: Row(
            children: [
              if (editor.language != null)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: AeronautColors.bgElevated,
                    borderRadius: BorderRadius.circular(
                      AeronautTheme.radiusSm,
                    ),
                  ),
                  child: Text(
                    editor.language!,
                    style: AeronautTheme.caption.copyWith(fontSize: 11),
                  ),
                ),
              const Spacer(),
              if (editor.modified)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 6,
                    vertical: 2,
                  ),
                  margin: const EdgeInsets.only(right: 8),
                  decoration: BoxDecoration(
                    color: AeronautColors.warning.withValues(alpha: 0.2),
                    borderRadius: BorderRadius.circular(
                      AeronautTheme.radiusSm,
                    ),
                  ),
                  child: Text(
                    'Modified',
                    style: AeronautTheme.caption.copyWith(
                      fontSize: 11,
                      color: AeronautColors.warning,
                    ),
                  ),
                ),
              Text(
                'Ln ${editor.cursor.line}, Col ${editor.cursor.column}',
                style: AeronautTheme.mono.copyWith(
                  fontSize: 11,
                  color: AeronautColors.textTertiary,
                ),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        // Content area — metadata view (no file content fetch yet)
        Expanded(
          child: Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(
                  Icons.code,
                  size: 48,
                  color: AeronautColors.accent,
                ),
                const SizedBox(height: AeronautTheme.spacingMd),
                Text(
                  editor.fileName ?? 'Editor',
                  style: AeronautTheme.heading,
                ),
                const SizedBox(height: AeronautTheme.spacingSm),
                Text(
                  'File content view coming in a later milestone',
                  style: AeronautTheme.caption,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// Collapsible file path breadcrumb.
class _FileBreadcrumb extends StatefulWidget {
  final EditorContext editor;

  const _FileBreadcrumb({required this.editor});

  @override
  State<_FileBreadcrumb> createState() => _FileBreadcrumbState();
}

class _FileBreadcrumbState extends State<_FileBreadcrumb> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final file = widget.editor.file!;
    final fileName = widget.editor.fileName ?? file;

    return GestureDetector(
      onTap: () => setState(() => _expanded = !_expanded),
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AeronautTheme.spacingMd,
          vertical: AeronautTheme.spacingSm,
        ),
        color: AeronautColors.bgSurface,
        child: Row(
          children: [
            Icon(
              _expanded ? Icons.expand_less : Icons.expand_more,
              size: 16,
              color: AeronautColors.textTertiary,
            ),
            const SizedBox(width: AeronautTheme.spacingXs),
            Expanded(
              child: Text(
                _expanded ? file : fileName,
                style: AeronautTheme.mono.copyWith(
                  fontSize: 12,
                  color: AeronautColors.textSecondary,
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (widget.editor.modified)
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(left: 8),
                decoration: const BoxDecoration(
                  shape: BoxShape.circle,
                  color: AeronautColors.warning,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
