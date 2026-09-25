import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../models/machine.dart';
import '../services/copilot_api.dart';
import 'connection_provider.dart';
import 'machines_provider.dart';

/// The ids of [snapshot]'s items whose `notify` is true.
Set<String> notifyingIds(AttentionSnapshot snapshot) =>
    {for (final item in snapshot.items) if (item.notify) item.id};

/// Items in [snapshot] whose `notify` is true and whose id was not in
/// [previouslyNotified] — the false→true edge contracts §9.2 alerts on
/// (absent counts as false, same as [notifyingIds]). A pure function so the
/// edge detection itself can be unit-tested without a live provider.
Iterable<AttentionItem> notifyRoseItems(
  Set<String> previouslyNotified,
  AttentionSnapshot snapshot,
) sync* {
  for (final item in snapshot.items) {
    if (item.notify && !previouslyNotified.contains(item.id)) yield item;
  }
}

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

  // Contracts §9.2: "In-app banner (and haptic) when an item's `notify`
  // flips true." Quiet hours are already applied server-side (Lee only
  // sets `notify: true` outside them), so the client's only job is to spot
  // the false→true edge and alert exactly once per edge — never on the
  // snapshot that first populates the queue (e.g. app launch, or switching
  // to a machine that already has a notifying item), which is not a flip.
  final _notifyRoseController = StreamController<AttentionItem>.broadcast();
  Set<String> _notifiedIds = {};
  bool _hasBaseline = false;

  /// Emits the item each time its `notify` goes false→true (absent counts
  /// as false). The UI (RootShell) turns this into a banner + haptic.
  Stream<AttentionItem> get notifyRoseStream => _notifyRoseController.stream;

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
    _notifiedIds = {};
    _hasBaseline = false;
    if (machine == null) {
      state = const AttentionUiState();
      return;
    }
    state = const AttentionUiState();
    _wsSubscription =
        _ref.read(connectionProvider.notifier).attentionStream.listen((snapshot) {
      if (_ref.read(machinesProvider).activeMachineId != machine.id) return;
      _applyNotifyEdge(snapshot);
      state = state.copyWith(snapshot: snapshot, loading: false, clearError: true);
    });
    unawaited(refresh());
  }

  /// Diffs [snapshot] against the ids that were notifying last time we
  /// looked, and emits any newly-notifying item on [notifyRoseStream]. The
  /// very first snapshot after a machine (re)connect only establishes the
  /// baseline; it never itself alerts.
  void _applyNotifyEdge(AttentionSnapshot snapshot) {
    if (_hasBaseline) {
      for (final item in notifyRoseItems(_notifiedIds, snapshot)) {
        _notifyRoseController.add(item);
      }
    }
    _notifiedIds = notifyingIds(snapshot);
    _hasBaseline = true;
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
        _applyNotifyEdge(snapshot);
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
    unawaited(_notifyRoseController.close());
    super.dispose();
  }
}

final attentionProvider =
    StateNotifierProvider<AttentionNotifier, AttentionUiState>((ref) {
  return AttentionNotifier(ref);
});
