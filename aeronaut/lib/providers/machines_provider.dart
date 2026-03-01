import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/machine.dart';
import '../services/lee_api.dart';
import '../services/machine_store.dart';

/// State for the machines list + active selection.
class MachinesState {
  final List<Machine> machines;
  final String? activeMachineId;
  final Map<String, bool> healthStatus; // machineId → online

  const MachinesState({
    this.machines = const [],
    this.activeMachineId,
    this.healthStatus = const {},
  });

  Machine? get activeMachine {
    if (activeMachineId == null) return null;
    try {
      return machines.firstWhere((m) => m.id == activeMachineId);
    } catch (_) {
      return null;
    }
  }

  bool isOnline(String machineId) => healthStatus[machineId] ?? false;

  MachinesState copyWith({
    List<Machine>? machines,
    String? activeMachineId,
    Map<String, bool>? healthStatus,
  }) {
    return MachinesState(
      machines: machines ?? this.machines,
      activeMachineId: activeMachineId ?? this.activeMachineId,
      healthStatus: healthStatus ?? this.healthStatus,
    );
  }
}

/// Manages the list of saved machines, active machine, and health pings.
class MachinesNotifier extends StateNotifier<MachinesState> {
  final MachineStore _store;
  Timer? _healthTimer;

  MachinesNotifier(this._store) : super(const MachinesState());

  /// Load machines from disk and start health pinging.
  Future<void> init() async {
    await _store.init();
    final machines = _store.loadMachines();
    final activeId = _store.loadActiveMachineId();
    state = MachinesState(
      machines: machines,
      activeMachineId: activeId,
    );
    // Initial health check
    await pingAll();
    // Periodic health check every 15 seconds
    _healthTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => pingAll(),
    );
  }

  /// Add a new machine and persist.
  Future<void> addMachine(Machine machine) async {
    final updated = [...state.machines, machine];
    state = state.copyWith(machines: updated);
    await _store.saveMachines(updated);
    // Ping the new machine immediately
    _pingMachine(machine);
  }

  /// Remove a machine by ID and persist.
  Future<void> removeMachine(String id) async {
    final updated = state.machines.where((m) => m.id != id).toList();
    final newActiveId =
        state.activeMachineId == id ? null : state.activeMachineId;
    state = state.copyWith(machines: updated, activeMachineId: newActiveId);
    await _store.saveMachines(updated);
    await _store.saveActiveMachineId(newActiveId);
  }

  /// Update an existing machine and persist.
  Future<void> updateMachine(Machine machine) async {
    final updated = state.machines.map((m) {
      return m.id == machine.id ? machine : m;
    }).toList();
    state = state.copyWith(machines: updated);
    await _store.saveMachines(updated);
  }

  /// Set the active machine.
  Future<void> setActiveMachine(String? id) async {
    state = state.copyWith(activeMachineId: id);
    await _store.saveActiveMachineId(id);
  }

  /// Ping all machines for health status.
  Future<void> pingAll() async {
    final results = <String, bool>{};
    await Future.wait(state.machines.map((machine) async {
      final online = await _pingMachine(machine);
      results[machine.id] = online;
    }));
    state = state.copyWith(healthStatus: {...state.healthStatus, ...results});
  }

  Future<bool> _pingMachine(Machine machine) async {
    final api = LeeApi(machine: machine);
    try {
      final online = await api.healthCheck();
      // Update lastSeen if online
      if (online) {
        final updated = machine.copyWith(lastSeen: DateTime.now());
        final machines = state.machines.map((m) {
          return m.id == machine.id ? updated : m;
        }).toList();
        state = state.copyWith(
          machines: machines,
          healthStatus: {...state.healthStatus, machine.id: true},
        );
        await _store.saveMachines(machines);
      } else {
        state = state.copyWith(
          healthStatus: {...state.healthStatus, machine.id: false},
        );
      }
      return online;
    } finally {
      api.dispose();
    }
  }

  @override
  void dispose() {
    _healthTimer?.cancel();
    super.dispose();
  }
}

final machineStoreProvider = Provider<MachineStore>((ref) {
  return MachineStore();
});

final machinesProvider =
    StateNotifierProvider<MachinesNotifier, MachinesState>((ref) {
  final store = ref.watch(machineStoreProvider);
  return MachinesNotifier(store);
});
