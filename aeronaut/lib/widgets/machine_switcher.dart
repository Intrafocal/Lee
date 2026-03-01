import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/machine.dart';
import '../providers/machines_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';

/// Compact machine switcher for the app bar.
///
/// Shows the active machine name with a dropdown to switch between machines.
class MachineSwitcher extends ConsumerWidget {
  const MachineSwitcher({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machinesState = ref.watch(machinesProvider);
    final active = machinesState.activeMachine;

    if (active == null) {
      return const SizedBox.shrink();
    }

    return PopupMenuButton<String>(
      offset: const Offset(0, 40),
      color: AeronautColors.bgElevated,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        side: const BorderSide(color: AeronautColors.border),
      ),
      onSelected: (id) {
        ref.read(machinesProvider.notifier).setActiveMachine(id);
      },
      itemBuilder: (context) {
        return machinesState.machines.map((machine) {
          final isOnline = machinesState.isOnline(machine.id);
          final isActive = machine.id == machinesState.activeMachineId;
          return PopupMenuItem<String>(
            value: machine.id,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: isOnline
                        ? AeronautColors.online
                        : AeronautColors.offline,
                  ),
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    machine.displayLabel,
                    style: AeronautTheme.body.copyWith(
                      fontWeight:
                          isActive ? FontWeight.w600 : FontWeight.w400,
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          );
        }).toList();
      },
      child: _ActiveMachineChip(machine: active),
    );
  }
}

class _ActiveMachineChip extends StatelessWidget {
  final Machine machine;

  const _ActiveMachineChip({required this.machine});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: const BoxDecoration(
            shape: BoxShape.circle,
            color: AeronautColors.online,
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            machine.name,
            style: AeronautTheme.body.copyWith(fontWeight: FontWeight.w500),
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: 4),
        const Icon(Icons.expand_more, size: 18, color: AeronautColors.textSecondary),
      ],
    );
  }
}
