import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/windows_provider.dart';
import '../services/lee_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';

/// Workspace switcher dropdown for the app bar.
///
/// Shows the active workspace name with a dropdown to switch between
/// open windows on the same Lee host. Only visible when multiple
/// windows are open.
class WorkspaceSwitcher extends ConsumerWidget {
  const WorkspaceSwitcher({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final windowsState = ref.watch(windowsProvider);

    if (!windowsState.hasMultipleWindows) {
      // Single window or none — just show the workspace name
      final active = windowsState.activeWindow;
      if (active == null) return const SizedBox.shrink();
      return Text(
        active.workspaceName,
        style: AeronautTheme.caption1.copyWith(
          color: AeronautColors.textSecondary,
        ),
        overflow: TextOverflow.ellipsis,
      );
    }

    return PopupMenuButton<int>(
      offset: const Offset(0, 40),
      color: AeronautColors.bgElevated,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        side: const BorderSide(color: AeronautColors.border),
      ),
      onSelected: (windowId) {
        ref.read(windowsProvider.notifier).setActiveWindow(windowId);
      },
      itemBuilder: (context) {
        return windowsState.windows.map((window) {
          final isActive = window.id == windowsState.activeWindowId;
          return PopupMenuItem<int>(
            value: window.id,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                window.focused
                    ? const PhosphorIcon(
                        PhosphorIcons.eye,
                        size: 14,
                        color: AeronautColors.accent,
                      )
                    : const PhosphorIcon(
                        PhosphorIcons.eyeOff,
                        size: 14,
                        color: AeronautColors.textTertiary,
                      ),
                const SizedBox(width: 10),
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        window.workspaceName,
                        style: AeronautTheme.subheadline.copyWith(
                          fontWeight:
                              isActive ? FontWeight.w600 : FontWeight.w400,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                      if (window.workspace != null)
                        Text(
                          window.workspace!,
                          style: AeronautTheme.caption2.copyWith(
                            color: AeronautColors.textTertiary,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                    ],
                  ),
                ),
                if (isActive) ...[
                  const SizedBox(width: 8),
                  const PhosphorIcon(
                    PhosphorIcons.check,
                    size: 16,
                    color: AeronautColors.accent,
                  ),
                ],
              ],
            ),
          );
        }).toList();
      },
      child: _WorkspaceChip(window: windowsState.activeWindow),
    );
  }
}

class _WorkspaceChip extends StatelessWidget {
  final WindowInfo? window;

  const _WorkspaceChip({required this.window});

  @override
  Widget build(BuildContext context) {
    if (window == null) return const SizedBox.shrink();
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const PhosphorIcon(
          PhosphorIcons.folder,
          size: 14,
          color: AeronautColors.textSecondary,
        ),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            window!.workspaceName,
            style: AeronautTheme.caption1.copyWith(
              color: AeronautColors.textSecondary,
            ),
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 2),
        const PhosphorIcon(
          PhosphorIcons.chevronDown,
          size: 14,
          color: AeronautColors.textTertiary,
        ),
      ],
    );
  }
}
