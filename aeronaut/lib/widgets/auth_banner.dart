import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/auth_provider.dart';
import '../providers/machines_provider.dart';
import '../screens/qr_scanner_screen.dart';
import '../services/api_auth.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';

/// Banner shown when Lee or Hester rejected the saved bearer token.
///
/// Renders nothing until a 401 arrives, so it can sit at the top of any
/// screen's body.
class AuthBanner extends ConsumerWidget {
  const AuthBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final failure = ref.watch(authGuardProvider);
    if (failure == null) return const SizedBox.shrink();

    final machine = ref
        .watch(machinesProvider)
        .machines
        .where((m) => m.id == failure.machineId)
        .firstOrNull;

    return Material(
      color: AeronautColors.offline.withValues(alpha: 0.15),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AeronautTheme.spacingMd,
          vertical: AeronautTheme.spacingSm,
        ),
        child: Row(
          children: [
            const PhosphorIcon(
              PhosphorIcons.lock,
              size: 18,
              color: AeronautColors.offline,
            ),
            const SizedBox(width: AeronautTheme.spacingSm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    AuthFailure.message,
                    style: AeronautTheme.footnote.copyWith(
                      color: AeronautColors.textPrimary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    machine == null
                        ? failure.detail
                        : '${failure.service.label} · ${machine.name}',
                    style: AeronautTheme.caption1,
                  ),
                ],
              ),
            ),
            TextButton(
              onPressed: () async {
                ref.read(authGuardProvider.notifier).reset();
                await Navigator.of(context).push(
                  MaterialPageRoute<bool>(
                    builder: (_) => const QrScannerScreen(),
                  ),
                );
              },
              child: const Text('Re-pair'),
            ),
            IconButton(
              icon: const PhosphorIcon(PhosphorIcons.close, size: 16),
              tooltip: 'Dismiss',
              onPressed: () => ref.read(authGuardProvider.notifier).clear(),
            ),
          ],
        ),
      ),
    );
  }
}
