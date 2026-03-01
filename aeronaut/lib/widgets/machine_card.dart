import 'package:flutter/material.dart';

import '../models/machine.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Card showing a saved machine with status indicator.
class MachineCard extends StatelessWidget {
  final Machine machine;
  final bool isOnline;
  final bool isActive;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  const MachineCard({
    required this.machine,
    this.isOnline = false,
    this.isActive = false,
    this.onTap,
    this.onLongPress,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        side: BorderSide(
          color: isActive ? AeronautColors.accent : AeronautColors.border,
          width: isActive ? 1.5 : 1,
        ),
      ),
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        child: Padding(
          padding: const EdgeInsets.all(AeronautTheme.spacingMd),
          child: Row(
            children: [
              // Status dot
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isOnline
                      ? AeronautColors.online
                      : AeronautColors.offline,
                  boxShadow: isOnline
                      ? [
                          BoxShadow(
                            color: AeronautColors.online.withValues(alpha: 0.4),
                            blurRadius: 6,
                            spreadRadius: 1,
                          ),
                        ]
                      : null,
                ),
              ),
              const SizedBox(width: AeronautTheme.spacingMd),
              // Machine info
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      machine.name,
                      style: AeronautTheme.body.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${machine.host}:${machine.hostPort}',
                      style: AeronautTheme.mono.copyWith(
                        color: AeronautColors.textSecondary,
                        fontSize: 12,
                      ),
                    ),
                    if (machine.workspace != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        machine.workspace!.split('/').last,
                        style: AeronautTheme.caption.copyWith(
                          color: AeronautColors.textTertiary,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              // Last seen / active indicator
              if (isActive)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: AeronautColors.accentMuted,
                    borderRadius: BorderRadius.circular(
                      AeronautTheme.radiusSm,
                    ),
                  ),
                  child: Text(
                    'ACTIVE',
                    style: AeronautTheme.caption.copyWith(
                      color: AeronautColors.textPrimary,
                      fontWeight: FontWeight.w600,
                      fontSize: 10,
                      letterSpacing: 0.5,
                    ),
                  ),
                )
              else if (machine.lastSeen != null)
                Text(
                  _formatLastSeen(machine.lastSeen!),
                  style: AeronautTheme.caption,
                ),
              const SizedBox(width: AeronautTheme.spacingSm),
              Icon(
                Icons.chevron_right,
                color: AeronautColors.textTertiary,
                size: 20,
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _formatLastSeen(DateTime lastSeen) {
    final diff = DateTime.now().difference(lastSeen);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }
}
