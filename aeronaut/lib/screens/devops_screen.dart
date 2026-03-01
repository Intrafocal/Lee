import 'package:flutter/material.dart';

import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Placeholder DevOps dashboard screen.
///
/// Service status cards + log viewer coming in a later milestone.
class DevOpsScreen extends StatelessWidget {
  const DevOpsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(
            Icons.monitor_heart_outlined,
            size: 48,
            color: AeronautColors.accent,
          ),
          const SizedBox(height: AeronautTheme.spacingMd),
          Text(
            'DevOps Dashboard',
            style: AeronautTheme.heading,
          ),
          const SizedBox(height: AeronautTheme.spacingSm),
          Text(
            'Service status + log viewer coming soon',
            style: AeronautTheme.caption,
          ),
        ],
      ),
    );
  }
}
