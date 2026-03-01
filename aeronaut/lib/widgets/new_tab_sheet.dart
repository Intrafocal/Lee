import 'package:flutter/material.dart';

import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// TUI type definition for the new tab picker.
class _TuiOption {
  final String label;
  final String action;
  final IconData icon;

  const _TuiOption(this.label, this.action, this.icon);
}

const _tuiOptions = [
  _TuiOption('Terminal', 'terminal', Icons.terminal),
  _TuiOption('Git', 'git', Icons.merge_type),
  _TuiOption('Docker', 'docker', Icons.inventory_2_outlined),
  _TuiOption('K8s', 'k8s', Icons.cloud_outlined),
  _TuiOption('Hester', 'hester', Icons.cruelty_free),
  _TuiOption('Claude', 'claude', Icons.psychology_outlined),
];

/// Bottom sheet for creating a new TUI tab.
///
/// Shows a grid of available TUI types. Returns the selected action string,
/// or null if dismissed.
class NewTabSheet extends StatelessWidget {
  const NewTabSheet({super.key});

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
            children: _tuiOptions.map((opt) => _TuiTile(
              label: opt.label,
              icon: opt.icon,
              onTap: () => Navigator.of(context).pop(opt.action),
            )).toList(),
          ),
        ],
      ),
    );
  }
}

class _TuiTile extends StatelessWidget {
  final String label;
  final IconData icon;
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
            Icon(icon, size: 28, color: AeronautColors.accent),
            const SizedBox(height: AeronautTheme.spacingXs),
            Text(
              label,
              style: AeronautTheme.caption.copyWith(
                color: AeronautColors.textPrimary,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
