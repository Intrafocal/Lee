import 'package:flutter/material.dart';

import '../models/lee_context.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';

/// Icon per TUI key, mirroring the tab-type mapping in `widgets/tab_bar.dart`.
/// Used for every tile here — including ones Lee sends an emoji icon for —
/// so the sheet reads as one icon system instead of mixing emoji and
/// glyphs. Unknown keys fall back to the generic tab glyph below.
const _tuiIcons = <String, PhosphorIconData>{
  'bridge': PhosphorIcons.link,
  'terminal': PhosphorIcons.terminal,
  'git': PhosphorIcons.git,
  'docker': PhosphorIcons.docker,
  'k8s': PhosphorIcons.kubernetes,
  'hester': PhosphorIcons.hester,
  'claude': PhosphorIcons.agent,
  'pi': PhosphorIcons.agent,
  'spyglass': PhosphorIcons.eye,
  'flutter': PhosphorIcons.mobile,
  'devops': PhosphorIcons.devops,
  'hester-qa': PhosphorIcons.hester,
  'system': PhosphorIcons.system,
  'sql': PhosphorIcons.sql,
};

/// Bottom sheet for creating a new TUI tab.
///
/// Shows a grid of available TUI types from the remote context.
/// Falls back to a hardcoded list if no availableTuis are provided.
/// Returns the selected action string, or null if dismissed.
class NewTabSheet extends StatelessWidget {
  final List<AvailableTui> availableTuis;

  const NewTabSheet({super.key, this.availableTuis = const []});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(
        AeronautTheme.spacingMd,
        AeronautTheme.spacingSm,
        AeronautTheme.spacingMd,
        AeronautTheme.spacingXl,
      ),
      decoration: const BoxDecoration(
        color: AeronautColors.bgSurface,
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Drag handle
          Container(
            width: 36,
            height: 4,
            margin: const EdgeInsets.only(bottom: AeronautTheme.spacingMd),
            decoration: BoxDecoration(
              color: AeronautColors.textTertiary,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const Text(
            'New Tab',
            style: AeronautTheme.headline,
          ),
          const SizedBox(height: AeronautTheme.spacingMd),
          GridView.count(
            crossAxisCount: 3,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            mainAxisSpacing: AeronautTheme.spacingSm,
            crossAxisSpacing: AeronautTheme.spacingSm,
            childAspectRatio: 1.1,
            children: [
              // Terminal is always available (not in availableTuis)
              _TuiTile(
                label: 'Terminal',
                icon: PhosphorIcons.terminal,
                onTap: () => Navigator.of(context).pop('terminal'),
              ),
              ...availableTuis.map((tui) => _TuiTile(
                label: tui.name,
                icon: _tuiIcons[tui.key],
                onTap: () => Navigator.of(context).pop(tui.key),
              )),
            ],
          ),
        ],
      ),
    );
  }
}

class _TuiTile extends StatelessWidget {
  final String label;

  /// Null when the TUI key has no Phosphor icon — falls back to a generic
  /// tab glyph so the tile grid still reads as one icon system.
  final PhosphorIconData? icon;
  final VoidCallback onTap;

  const _TuiTile({
    required this.label,
    required this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AeronautColors.bgElevated,
      borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            PhosphorIcon(icon ?? PhosphorIcons.tabs, size: 28, color: AeronautColors.accent),
            const SizedBox(height: AeronautTheme.spacingXs),
            Text(
              label,
              style: AeronautTheme.caption1.copyWith(
                color: AeronautColors.textPrimary,
                fontWeight: FontWeight.w500,
              ),
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
      ),
    );
  }
}
