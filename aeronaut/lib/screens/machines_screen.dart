import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/machines_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../widgets/machine_card.dart';
import 'add_machine_screen.dart';
import 'home_screen.dart';

/// List of saved machines with online/offline status.
///
/// First screen on launch. Tap a machine to connect and enter Home.
class MachinesScreen extends ConsumerWidget {
  const MachinesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machinesState = ref.watch(machinesProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Machines'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Ping all',
            onPressed: () =>
                ref.read(machinesProvider.notifier).pingAll(),
          ),
        ],
      ),
      body: machinesState.machines.isEmpty
          ? _EmptyState(
              onAdd: () => _navigateToAdd(context),
            )
          : RefreshIndicator(
              color: AeronautColors.accent,
              onRefresh: () =>
                  ref.read(machinesProvider.notifier).pingAll(),
              child: ListView.separated(
                padding: const EdgeInsets.all(AeronautTheme.spacingMd),
                itemCount: machinesState.machines.length,
                separatorBuilder: (_, __) =>
                    const SizedBox(height: AeronautTheme.spacingSm),
                itemBuilder: (context, index) {
                  final machine = machinesState.machines[index];
                  final isOnline = machinesState.isOnline(machine.id);
                  final isActive =
                      machine.id == machinesState.activeMachineId;
                  return MachineCard(
                    machine: machine,
                    isOnline: isOnline,
                    isActive: isActive,
                    onTap: () => _connectToMachine(context, ref, machine.id),
                    onLongPress: () => _showMachineActions(
                      context,
                      ref,
                      machine.id,
                    ),
                  );
                },
              ),
            ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _navigateToAdd(context),
        child: const Icon(Icons.add),
      ),
    );
  }

  void _navigateToAdd(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => const AddMachineScreen(),
      ),
    );
  }

  void _connectToMachine(BuildContext context, WidgetRef ref, String id) {
    ref.read(machinesProvider.notifier).setActiveMachine(id);
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => const HomeScreen(),
      ),
    );
  }

  void _showMachineActions(
    BuildContext context,
    WidgetRef ref,
    String machineId,
  ) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AeronautColors.bgElevated,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.delete_outline,
                    color: AeronautColors.offline),
                title: Text(
                  'Remove machine',
                  style: AeronautTheme.body.copyWith(
                    color: AeronautColors.offline,
                  ),
                ),
                onTap: () {
                  Navigator.pop(ctx);
                  ref
                      .read(machinesProvider.notifier)
                      .removeMachine(machineId);
                },
              ),
            ],
          ),
        );
      },
    );
  }
}

class _EmptyState extends StatelessWidget {
  final VoidCallback onAdd;

  const _EmptyState({required this.onAdd});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AeronautTheme.spacingXl),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.computer,
              size: 64,
              color: AeronautColors.textTertiary,
            ),
            const SizedBox(height: AeronautTheme.spacingLg),
            Text(
              'No machines yet',
              style: AeronautTheme.heading.copyWith(
                color: AeronautColors.textSecondary,
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            Text(
              'Add a Lee instance to connect to your IDE from your phone.',
              textAlign: TextAlign.center,
              style: AeronautTheme.body.copyWith(
                color: AeronautColors.textTertiary,
              ),
            ),
            const SizedBox(height: AeronautTheme.spacingLg),
            ElevatedButton.icon(
              onPressed: onAdd,
              icon: const Icon(Icons.add),
              label: const Text('Add Machine'),
            ),
          ],
        ),
      ),
    );
  }
}
