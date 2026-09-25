import 'package:flutter/material.dart';

import '../models/lee_context.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';

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
            tabTypeIcon(
              tab.type,
              size: 14,
              color: isActive
                  ? AeronautColors.accent
                  : AeronautColors.textSecondary,
            ),
            const SizedBox(width: 6),
            Text(
              tab.label,
              style: AeronautTheme.caption1.copyWith(
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
}

/// Icon per tab type, mirroring `TAB_ICONS` in Lee's `TabBar.tsx`.
Widget tabTypeIcon(TabType type, {double size = 24, Color? color}) {
  switch (type) {
    case TabType.bridge:
      return PhosphorIcon(PhosphorIcons.link, size: size, color: color);
    case TabType.kicad:
      return PhosphorIcon(PhosphorIcons.chip, size: size, color: color);
    case TabType.model:
      return PhosphorIcon(PhosphorIcons.cube, size: size, color: color);
    case TabType.pdf:
      return PhosphorIcon(PhosphorIcons.document, size: size, color: color);
    default:
      return PhosphorIcon(_phosphorIconForTabType(type), size: size, color: color);
  }
}

PhosphorIconData _phosphorIconForTabType(TabType type) {
  switch (type) {
    case TabType.editor:
    case TabType.editorPanel:
      return PhosphorIcons.editor;
    case TabType.file:
      return PhosphorIcons.fileCode;
    case TabType.terminal:
      return PhosphorIcons.terminal;
    case TabType.git:
      return PhosphorIcons.git;
    case TabType.docker:
      return PhosphorIcons.docker;
    case TabType.k8s:
      return PhosphorIcons.kubernetes;
    case TabType.flutter:
      return PhosphorIcons.mobile;
    case TabType.hester:
    case TabType.hesterQa:
      return PhosphorIcons.hester;
    case TabType.claude:
    case TabType.agent:
      return PhosphorIcons.agent;
    case TabType.files:
      return PhosphorIcons.folder;
    case TabType.browser:
      return PhosphorIcons.browser;
    case TabType.devops:
      return PhosphorIcons.devops;
    case TabType.system:
      return PhosphorIcons.system;
    case TabType.sql:
      return PhosphorIcons.sql;
    case TabType.library:
      return PhosphorIcons.book;
    case TabType.workstream:
      return PhosphorIcons.list;
    case TabType.spyglass:
      return PhosphorIcons.eye;
    case TabType.binary:
      return PhosphorIcons.fileCode;
    case TabType.custom:
      return PhosphorIcons.settings;
    case TabType.unknown:
      return PhosphorIcons.tabs;
    case TabType.bridge:
    case TabType.kicad:
    case TabType.model:
    case TabType.pdf:
      // Handled in tabTypeIcon before reaching here.
      return PhosphorIcons.tabs;
  }
}
