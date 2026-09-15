import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/lee_context.dart';
import '../providers/context_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import 'file_viewer_screen.dart';

/// Screen for an editor-like tab (`editor`, `editor-panel`, `file`).
///
/// Shows the live cursor/language/modified bar from Lee's per-tab
/// `context.editors[tab.id]` (falling back to the legacy single `editor`
/// field — see `LeeContext.editorFor`), and embeds [FileViewerScreen] below
/// it to actually render the file's content.
class EditorScreen extends ConsumerWidget {
  final TabContext tab;

  const EditorScreen({required this.tab, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ctx = ref.watch(leeContextProvider).valueOrNull;
    final editor = ctx?.editorFor(tab);

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
        // File content — re-fetches whenever `editor.file` changes.
        Expanded(
          child: FileViewerScreen(
            key: ValueKey('editor-${tab.id}'),
            filePath: editor.file!,
            modified: editor.modified,
          ),
        ),
      ],
    );
  }
}
