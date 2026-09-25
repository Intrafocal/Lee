import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../models/machine.dart';
import '../services/copilot_api.dart';
import 'connection_provider.dart';
import 'machines_provider.dart';

/// Live attention-queue state for the active machine's Now screen
/// (contracts §9.2).
class AttentionUiState {
  final AttentionSnapshot snapshot;
  final bool loading;
  final String? error;

  const AttentionUiState({
    this.snapshot = AttentionSnapshot.empty,
    this.loading = false,
    this.error,
  });

  AttentionUiState copyWith({
    AttentionSnapshot? snapshot,
    bool? loading,
    String? error,
    bool clearError = false,
  }) {
    return AttentionUiState(
      snapshot: snapshot ?? this.snapshot,
      loading: loading ?? this.loading,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// Sourced from `attention_snapshot` WebSocket pushes (multiplexed onto the
/// existing `/context/stream` socket by [ConnectionNotifier.attentionStream]
/// — contracts §5.6, §9.2), refreshed with `GET /attention?compact=1`
/// whenever the active machine changes and on pull-to-refresh. Also carries
/// the reply/snooze/dismiss/wake/focus/capture actions the Now screen needs,
/// so every widget in it shares one snapshot instead of re-fetching.
class AttentionNotifier extends StateNotifier<AttentionUiState> {
  final Ref _ref;
  StreamSubscription<AttentionSnapshot>? _wsSubscription;
  String? _machineId;

  AttentionNotifier(this._ref) : super(const AttentionUiState()) {
    _ref.listen<MachinesState>(machinesProvider, (prev, next) {
      final id = next.activeMachineId;
      if (id != _machineId) {
        _machineId = id;
        _onMachineChanged(next.activeMachine);
      }
    });
    final initial = _ref.read(machinesProvider).activeMachine;
    if (initial != null) {
      _machineId = initial.id;
      _onMachineChanged(initial);
    }
  }

  void _onMachineChanged(Machine? machine) {
    _wsSubscription?.cancel();
    _wsSubscription = null;
    if (machine == null) {
      state = const AttentionUiState();
      return;
    }
    state = const AttentionUiState();
    _wsSubscription =
        _ref.read(connectionProvider.notifier).attentionStream.listen((snapshot) {
      if (_ref.read(machinesProvider).activeMachineId != machine.id) return;
      state = state.copyWith(snapshot: snapshot, loading: false, clearError: true);
    });
    unawaited(refresh());
  }

  Future<void> refresh() async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    state = state.copyWith(loading: true);
    final api = CopilotApi(machine: machine);
    try {
      final snapshot = await api.getSnapshot();
      if (!mounted || _ref.read(machinesProvider).activeMachineId != machine.id) return;
      if (snapshot != null) {
        state = state.copyWith(snapshot: snapshot, loading: false, clearError: true);
      } else {
        state = state.copyWith(loading: false, error: 'Could not reach the queue.');
      }
    } finally {
      api.dispose();
    }
  }

  Future<ActionResult> reply(
    String itemId, {
    required String action,
    String? text,
    required int version,
  }) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = CopilotApi(machine: machine);
    try {
      return await api.reply(itemId, action: action, text: text, version: version);
    } finally {
      api.dispose();
    }
  }

  Future<ActionResult> snooze(String itemId, {String? until, int? minutes}) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = CopilotApi(machine: machine);
    try {
      return await api.snooze(itemId, until: until, minutes: minutes);
    } finally {
      api.dispose();
    }
  }

  Future<ActionResult> dismiss(String itemId) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = CopilotApi(machine: machine);
    try {
      return await api.dismiss(itemId);
    } finally {
      api.dispose();
    }
  }

  Future<ActionResult> setWake(String itemId, bool wake) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = CopilotApi(machine: machine);
    try {
      return await api.setWake(itemId, wake);
    } finally {
      api.dispose();
    }
  }

  Future<CaptureResult> capture(
    String text, {
    String? workspace,
    bool asExploration = false,
  }) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const CaptureResult(success: false, error: 'No active machine');
    }
    final api = CopilotApi(machine: machine);
    try {
      return await api.capture(text, workspace: workspace, asExploration: asExploration);
    } finally {
      api.dispose();
    }
  }

  Future<FocusState?> focusStart({FocusItem? item}) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) return null;
    final api = CopilotApi(machine: machine);
    try {
      final focus = await api.focusStart(item: item);
      if (focus != null) {
        state = state.copyWith(snapshot: state.snapshot.copyWith(focus: focus));
      }
      return focus;
    } finally {
      api.dispose();
    }
  }

  Future<FocusState?> focusStop() async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) return null;
    final api = CopilotApi(machine: machine);
    try {
      final focus = await api.focusStop();
      if (focus != null) {
        state = state.copyWith(snapshot: state.snapshot.copyWith(focus: focus));
      }
      return focus;
    } finally {
      api.dispose();
    }
  }

  @override
  void dispose() {
    _wsSubscription?.cancel();
    super.dispose();
  }
}

final attentionProvider =
    StateNotifierProvider<AttentionNotifier, AttentionUiState>((ref) {
  return AttentionNotifier(ref);
});
