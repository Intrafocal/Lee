import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/machines_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/auth_banner.dart';
import '../widgets/machine_card.dart';
import '../widgets/phosphor_icon.dart';
import '../providers/auth_provider.dart';
import 'add_machine_screen.dart';
import 'machine_detail_screen.dart';
import 'qr_scanner_screen.dart';
import 'root_shell.dart';

/// List of saved machines with online/offline status.
///
/// First tab on launch. Tap a machine to connect and jump to its Tabs.
class MachinesScreen extends ConsumerWidget {
  const MachinesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machinesState = ref.watch(machinesProvider);
    // Keep the 401 guard installed from the first screen onwards.
    ref.watch(authGuardProvider);

    final notifier = ref.read(machinesProvider.notifier);

    return Scaffold(
      body: CustomScrollView(
        physics: const BouncingScrollPhysics(
          parent: AlwaysScrollableScrollPhysics(),
        ),
        slivers: [
          CupertinoSliverNavigationBar(
            largeTitle: const Text('Machines'),
            backgroundColor: AeronautColors.chrome,
            border: const Border(
              bottom: BorderSide(color: AeronautColors.border, width: 0.5),
            ),
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _NavButton(
                  icon: PhosphorIcons.qr,
                  label: 'Scan QR',
                  onPressed: () => _navigateToScan(context),
                ),
                _NavButton(
                  icon: PhosphorIcons.plus,
                  label: 'Add machine',
                  onPressed: () => _navigateToAdd(context),
                ),
              ],
            ),
          ),
          CupertinoSliverRefreshControl(onRefresh: notifier.pingAll),
          const SliverToBoxAdapter(child: AuthBanner()),
          if (machinesState.machines.isEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: _EmptyState(
                onAdd: () => _navigateToAdd(context),
                onScan: () => _navigateToScan(context),
              ),
            )
          else ...[
            const SliverToBoxAdapter(child: _SectionHeader('On this network')),
            SliverPadding(
              padding: const EdgeInsets.symmetric(
                horizontal: AeronautTheme.spacingMd,
              ),
              sliver: SliverList.separated(
                itemCount: machinesState.machines.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(height: AeronautTheme.spacingSm),
                itemBuilder: (context, index) {
                  final machine = machinesState.machines[index];
                  return MachineCard(
                    machine: machine,
                    health: machinesState.healthOf(machine.id),
                    isActive: machine.id == machinesState.activeMachineId,
                    onTap: () => _connectToMachine(context, ref, machine.id),
                    onLongPress: () =>
                        _showMachineActions(context, ref, machine.id),
                  );
                },
              ),
            ),
            const SliverToBoxAdapter(
              child: SizedBox(height: AeronautTheme.spacingLg),
            ),
          ],
        ],
      ),
    );
  }

  void _navigateToAdd(BuildContext context) {
    Navigator.of(context).push(
      CupertinoPageRoute<void>(
        builder: (_) => const AddMachineScreen(),
      ),
    );
  }

  void _navigateToScan(BuildContext context) {
    Navigator.of(context).push(
      CupertinoPageRoute<bool>(
        builder: (_) => const QrScannerScreen(),
      ),
    );
  }

  void _connectToMachine(BuildContext context, WidgetRef ref, String id) {
    ref.read(machinesProvider.notifier).setActiveMachine(id);
    ref.read(rootTabProvider.notifier).state = RootTab.tabs;
  }

  void _showMachineActions(
    BuildContext context,
    WidgetRef ref,
    String machineId,
  ) {
    final machine = ref
        .read(machinesProvider)
        .machines
        .where((m) => m.id == machineId)
        .firstOrNull;
    showCupertinoModalPopup<void>(
      context: context,
      builder: (ctx) => CupertinoActionSheet(
        title: machine != null ? Text(machine.name) : null,
        actions: [
          if (machine != null)
            CupertinoActionSheetAction(
              onPressed: () {
                Navigator.pop(ctx);
                Navigator.of(context).push(
                  CupertinoPageRoute<void>(
                    builder: (_) => MachineDetailScreen(machine: machine),
                  ),
                );
              },
              child: const Text('Health & workspace'),
            ),
          CupertinoActionSheetAction(
            isDestructiveAction: true,
            onPressed: () {
              Navigator.pop(ctx);
              ref.read(machinesProvider.notifier).removeMachine(machineId);
            },
            child: const Text('Remove machine'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(ctx),
          child: const Text('Cancel'),
        ),
      ),
    );
  }
}

/// Grouped-list section header, iOS style.
class _SectionHeader extends StatelessWidget {
  final String text;

  const _SectionHeader(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 20, 32, 6),
      child: Text(
        text.toUpperCase(),
        style: AeronautTheme.footnote.copyWith(
          color: AeronautColors.textTertiary,
        ),
      ),
    );
  }
}

/// 44pt icon button for the navigation bar.
class _NavButton extends StatelessWidget {
  final PhosphorIconData icon;
  final String label;
  final VoidCallback onPressed;

  const _NavButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      label: label,
      child: CupertinoButton(
        padding: EdgeInsets.zero,
        minimumSize: const Size.square(44),
        onPressed: onPressed,
        child: PhosphorIcon(icon, size: 22, color: AeronautColors.accent),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  final VoidCallback onAdd;
  final VoidCallback onScan;

  const _EmptyState({required this.onAdd, required this.onScan});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AeronautTheme.spacingXl),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const PhosphorIcon(
              PhosphorIcons.machine,
              size: 64,
              color: AeronautColors.textTertiary,
            ),
            const SizedBox(height: AeronautTheme.spacingLg),
            Text(
              'No machines yet',
              style: AeronautTheme.headline.copyWith(
                color: AeronautColors.textSecondary,
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            Text(
              'Add a Lee instance to connect to your IDE from your phone.',
              textAlign: TextAlign.center,
              style: AeronautTheme.subheadline.copyWith(
                color: AeronautColors.textTertiary,
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingLg),
            ElevatedButton.icon(
              onPressed: onScan,
              icon: const PhosphorIcon(PhosphorIcons.qr, color: AeronautColors.onAccent),
              label: const Text('Scan QR Code'),
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            OutlinedButton.icon(
              onPressed: onAdd,
              icon: const PhosphorIcon(PhosphorIcons.plus),
              label: const Text('Add Manually'),
            ),
          ],
        ),
      ),
    );
  }
}
