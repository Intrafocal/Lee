import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/machine.dart';
import '../services/api_auth.dart';
import '../services/lee_api.dart';
import '../services/machine_store.dart';

/// Reachability of a saved machine, as seen by the background pinger.
///
/// [unauthorized] is distinct from [offline]: the host answered, it just
/// rejected the saved bearer token, which needs a re-pair rather than a retry.
enum MachineHealth { unknown, online, offline, unauthorized }

/// State for the machines list + active selection.
class MachinesState {
  final List<Machine> machines;
  final String? activeMachineId;
  final Map<String, MachineHealth> healthStatus; // machineId → health

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

  MachineHealth healthOf(String machineId) =>
      healthStatus[machineId] ?? MachineHealth.unknown;

  bool isOnline(String machineId) =>
      healthOf(machineId) == MachineHealth.online;

  MachinesState copyWith({
    List<Machine>? machines,
    String? activeMachineId,
    Map<String, MachineHealth>? healthStatus,
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

  /// Add a machine, or update the one already saved for the same
  /// `host:hostPort` — re-pairing refreshes the token rather than
  /// stacking up duplicate entries.
  Future<Machine> addOrUpdateMachine(Machine machine) async {
    final existingIndex = state.machines.indexWhere(
      (m) => m.host == machine.host && m.hostPort == machine.hostPort,
    );
    if (existingIndex < 0) {
      await addMachine(machine);
      return machine;
    }
    final existing = state.machines[existingIndex];
    final merged = existing.copyWith(
      name: machine.name,
      hesterPort: machine.hesterPort,
      token: machine.token,
    );
    final updated = [...state.machines]..[existingIndex] = merged;
    state = state.copyWith(
      machines: updated,
      healthStatus: {...state.healthStatus}..remove(merged.id),
    );
    await _store.saveMachines(updated);
    unawaited(_pingMachine(merged));
    return merged;
  }

  /// Mark a machine's token as rejected (called by the auth guard on a 401).
  void markUnauthorized(String machineId) {
    state = state.copyWith(
      healthStatus: {
        ...state.healthStatus,
        machineId: MachineHealth.unauthorized,
      },
    );
  }

  /// Ping all machines for health status.
  Future<void> pingAll() async {
    await Future.wait(state.machines.map(_pingMachine));
  }

  /// Probe a machine on an authenticated route so a rejected token shows up
  /// as [MachineHealth.unauthorized] rather than a false "online".
  Future<MachineHealth> _pingMachine(Machine machine) async {
    final api = LeeApi(machine: machine);
    try {
      final status = await api.probe();
      final health = switch (status) {
        ApiStatus.ok => MachineHealth.online,
        ApiStatus.unauthorized => MachineHealth.unauthorized,
        ApiStatus.unreachable => MachineHealth.offline,
      };
      if (!mounted) return health;

      var machines = state.machines;
      if (health == MachineHealth.online) {
        final updated = machine.copyWith(lastSeen: DateTime.now());
        machines = machines.map((m) {
          return m.id == machine.id ? updated : m;
        }).toList();
      }
      state = state.copyWith(
        machines: machines,
        healthStatus: {...state.healthStatus, machine.id: health},
      );
      if (health == MachineHealth.online) {
        await _store.saveMachines(machines);
      }
      return health;
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
