import 'package:flutter/material.dart';

import '../models/lee_context.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Fallback icon mapping for TUI keys when no emoji icon is provided.
const _tuiIcons = <String, IconData>{
  'terminal': Icons.terminal,
  'git': Icons.merge_type,
  'docker': Icons.inventory_2_outlined,
  'k8s': Icons.cloud_outlined,
  'hester': Icons.cruelty_free,
  'claude': Icons.psychology_outlined,
  'flutter': Icons.phone_android,
  'devops': Icons.rocket_launch,
  'hester-qa': Icons.science_outlined,
  'system': Icons.monitor_heart_outlined,
  'sql': Icons.storage,
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
          Text(
            'New Tab',
            style: AeronautTheme.heading.copyWith(fontSize: 16),
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
                icon: Icons.terminal,
                onTap: () => Navigator.of(context).pop('terminal'),
              ),
              ...availableTuis.map((tui) => _TuiTile(
                label: tui.name,
                icon: _tuiIcons[tui.key] ?? Icons.apps,
                emoji: tui.icon,
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
  final IconData icon;
  final String? emoji;
  final VoidCallback onTap;

  const _TuiTile({
    required this.label,
    required this.icon,
    this.emoji,
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
            if (emoji != null)
              Text(emoji!, style: const TextStyle(fontSize: 24))
            else
              Icon(icon, size: 28, color: AeronautColors.accent),
            const SizedBox(height: AeronautTheme.spacingXs),
            Text(
              label,
              style: AeronautTheme.caption.copyWith(
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
