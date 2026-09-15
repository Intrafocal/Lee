import 'package:flutter/material.dart';

import '../models/lee_context.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Horizontal scrollable tab strip rendering LeeContext.tabs[].
class LeeTabBar extends StatelessWidget {
  final List<TabContext> tabs;
  final int? activeTabId;
  final ValueChanged<TabContext>? onTabTap;

  const LeeTabBar({
    required this.tabs,
    this.activeTabId,
    this.onTabTap,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    if (tabs.isEmpty) {
      return const SizedBox(height: 44);
    }

    return SizedBox(
      height: 44,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(
          horizontal: AeronautTheme.spacingMd,
        ),
        itemCount: tabs.length,
        separatorBuilder: (_, _) =>
            const SizedBox(width: AeronautTheme.spacingSm),
        itemBuilder: (context, index) {
          final tab = tabs[index];
          final isActive = tab.id == activeTabId;
          return _TabChip(
            tab: tab,
            isActive: isActive,
            onTap: () => onTabTap?.call(tab),
          );
        },
      ),
    );
  }
}

class _TabChip extends StatelessWidget {
  final TabContext tab;
  final bool isActive;
  final VoidCallback? onTap;

  const _TabChip({
    required this.tab,
    this.isActive = false,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: isActive ? AeronautColors.bgElevated : Colors.transparent,
          borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
          border: Border.all(
            color: isActive
                ? AeronautColors.accent.withValues(alpha: 0.4)
                : AeronautColors.border,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              _iconForTabType(tab.type),
              size: 14,
              color: isActive
                  ? AeronautColors.accent
                  : AeronautColors.textSecondary,
            ),
            const SizedBox(width: 6),
            Text(
              tab.label,
              style: AeronautTheme.caption.copyWith(
                color: isActive
                    ? AeronautColors.textPrimary
                    : AeronautColors.textSecondary,
                fontWeight: isActive ? FontWeight.w600 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }

  IconData _iconForTabType(TabType type) => iconForTabType(type);
}

/// Icon per tab type, mirroring `TAB_ICONS` in Lee's `TabBar.tsx`.
IconData iconForTabType(TabType type) {
  switch (type) {
    case TabType.editor:
    case TabType.editorPanel:
      return Icons.code;
    case TabType.file:
      return Icons.description_outlined;
    case TabType.terminal:
      return Icons.terminal;
    case TabType.git:
      return Icons.merge_type;
    case TabType.docker:
      return Icons.widgets_outlined;
    case TabType.k8s:
      return Icons.cloud_outlined;
    case TabType.flutter:
      return Icons.phone_android;
    case TabType.hester:
    case TabType.hesterQa:
      return Icons.cruelty_free;
    case TabType.claude:
      return Icons.auto_awesome;
    case TabType.agent:
      return Icons.smart_toy_outlined;
    case TabType.files:
      return Icons.folder_outlined;
    case TabType.browser:
      return Icons.public;
    case TabType.devops:
      return Icons.rocket_launch_outlined;
    case TabType.system:
      return Icons.monitor_heart_outlined;
    case TabType.sql:
      return Icons.storage;
    case TabType.library:
      return Icons.library_books_outlined;
    case TabType.workstream:
      return Icons.checklist;
    case TabType.spyglass:
      return Icons.travel_explore;
    case TabType.bridge:
      return Icons.swap_horiz;
    case TabType.kicad:
      return Icons.memory;
    case TabType.model:
      return Icons.view_in_ar_outlined;
    case TabType.pdf:
      return Icons.picture_as_pdf_outlined;
    case TabType.binary:
      return Icons.inventory_2_outlined;
    case TabType.custom:
      return Icons.build_outlined;
    case TabType.unknown:
      return Icons.tab_outlined;
  }
}
