import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../models/machine.dart';
import '../services/copilot_api.dart';
import '../services/tether_api.dart';
import 'connection_provider.dart';
import 'machines_provider.dart';

/// Compact snapshots clip an item's `text` to this many chars
/// (`COMPACT_TEXT_MAX` in `electron/src/main/copilot/attention-queue.ts`),
/// and the In-flight `agents[].last_summary` to the same length
/// (`COMPACT_AGENT_SUMMARY_MAX` in `electron/src/main/copilot/queue.ts`).
const int kCompactTextClipLength = 280;

/// Approximate clip length for the strings inside a `question`-kind item's
/// `question` field (header/question/option label/description) in a compact
/// snapshot. Used only to decide whether a full-item fetch is worth making —
/// see [looksClipped].
const int kCompactQuestionClipLength = 120;

/// Whether [text] looks like Lee's compact-snapshot clip truncated it: a
/// clipped string is padded/cut to exactly [max] chars and ends in the clip
/// marker '…' (see `clip()` in `electron/src/main/copilot/hook-payload.ts`).
/// A short string that happens to end in '…' on its own is a harmless false
/// positive (one extra fetch); a long string is never mistaken for short.
bool looksClipped(String text, [int max = kCompactTextClipLength]) {
  if (text.length < max) return false;
  return text.endsWith('…');
}

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

  /// How a [CopilotApi] is built for a call; overridden in tests with a fake
  /// that records calls / returns canned data instead of hitting a network.
  final CopilotApi Function(Machine machine) _apiFactory;

  StreamSubscription<AttentionSnapshot>? _wsSubscription;
  String? _machineId;

  /// Full (unclipped) items fetched via `GET /attention/:id`, keyed by
  /// "id:version" so a re-expand of the same item version is free and a
  /// version bump (the item changed) fetches fresh. Cleared on machine
  /// change; never evicted otherwise (bounded by how many items a person
  /// actually expands in a session).
  final Map<String, AttentionItem> _fullItemCache = {};
  final Map<String, Future<AttentionItem?>> _fullItemInFlight = {};

  /// The latest full (non-compact) snapshot, for reading an agent's
  /// unclipped `last_summary` on expand — kept briefly so expanding several
  /// In-flight rows in a row doesn't refetch every time.
  AttentionSnapshot? _fullSnapshotCache;
  DateTime? _fullSnapshotCacheAt;
  Future<AttentionSnapshot?>? _fullSnapshotInFlight;
  static const _fullSnapshotTtl = Duration(seconds: 10);

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

  AttentionNotifier(this._ref, {CopilotApi Function(Machine machine)? apiFactory})
      : _apiFactory = apiFactory ?? ((m) => CopilotApi(machine: m)),
        super(const AttentionUiState()) {
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
    _fullItemCache.clear();
    _fullItemInFlight.clear();
    _fullSnapshotCache = null;
    _fullSnapshotCacheAt = null;
    _fullSnapshotInFlight = null;
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
    final api = _apiFactory(machine);
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
    int? choice,
    required int version,
    bool voice = false,
  }) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = _apiFactory(machine);
    try {
      return await api.reply(itemId, action: action, text: text, choice: choice, version: version, voice: voice);
    } finally {
      api.dispose();
    }
  }

  Future<ActionResult> open(String itemId) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = _apiFactory(machine);
    try {
      return await api.open(itemId);
    } finally {
      api.dispose();
    }
  }

  Future<ActionResult> snooze(String itemId, {String? until, int? minutes}) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = _apiFactory(machine);
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
    final api = _apiFactory(machine);
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
    final api = _apiFactory(machine);
    try {
      return await api.setWake(itemId, wake);
    } finally {
      api.dispose();
    }
  }

  /// Desk D2 §9.2: Extend, or End and rate, the "Still thinking?" push.
  Future<ActionResult> deepIdleEnd(AttentionItem item, {required String action, String? rating, String? stoppedAt}) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const ActionResult(success: false, error: 'No active machine');
    }
    final api = _apiFactory(machine);
    try {
      return await api.deepIdleEnd(item.id, version: item.version, action: action, rating: rating, stoppedAt: stoppedAt);
    } finally {
      api.dispose();
    }
  }

  /// A thought for Ideas through Lee's `POST /tether/capture`: Work's +,
  /// or into the card [cardId] (the "Still thinking?" push). [voice] tags
  /// a transcript.
  Future<CaptureResult> capture(String text, {String? workspace, String? cardId, bool voice = false}) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      return const CaptureResult(success: false, error: 'No active machine');
    }
    final api = TetherApi(machine: machine);
    try {
      return await api.capture(text, workspace: workspace, cardId: cardId, voice: voice);
    } finally {
      api.dispose();
    }
  }

  Future<FocusState?> focusStart({FocusItem? item}) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) return null;
    final api = _apiFactory(machine);
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
    final api = _apiFactory(machine);
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

  /// The full (up to ~2000 char) item for [item], for expanding a clipped
  /// item's text on demand. Returns null (and does no work) when [item]'s
  /// text doesn't [looksClipped] — nothing to gain from a round trip. One
  /// request per distinct "id:version": a second call for the same version
  /// (e.g. collapsing and re-expanding a tile) is served from cache, and two
  /// concurrent calls (e.g. a fast double-tap) share the one in-flight
  /// request rather than firing twice. A 404/410/network failure resolves
  /// to null so callers just keep showing the clipped text — no error spam.
  Future<AttentionItem?> fetchFullItem(AttentionItem item) {
    if (!looksClipped(item.text)) return Future.value(null);
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) return Future.value(null);
    final key = '${item.id}:${item.version}';
    final cached = _fullItemCache[key];
    if (cached != null) return Future.value(cached);
    final inFlight = _fullItemInFlight[key];
    if (inFlight != null) return inFlight;
    final future = _doFetchFullItem(machine, item.id, key);
    _fullItemInFlight[key] = future;
    return future;
  }

  Future<AttentionItem?> _doFetchFullItem(Machine machine, String itemId, String cacheKey) async {
    final api = _apiFactory(machine);
    try {
      final full = await api.getItem(itemId);
      if (full != null) _fullItemCache[cacheKey] = full;
      return full;
    } finally {
      api.dispose();
      _fullItemInFlight.remove(cacheKey);
    }
  }

  /// The full (non-compact) snapshot — `agents[].last_summary` here is
  /// unclipped, unlike the compact snapshot this provider otherwise tracks
  /// (contracts §5.6). Cached briefly ([_fullSnapshotTtl]) so expanding
  /// several In-flight rows in quick succession shares one fetch, and
  /// concurrent expands share one in-flight request.
  Future<AttentionSnapshot?> fetchFullSnapshot() {
    final cached = _fullSnapshotCache;
    final cachedAt = _fullSnapshotCacheAt;
    if (cached != null && cachedAt != null && DateTime.now().difference(cachedAt) < _fullSnapshotTtl) {
      return Future.value(cached);
    }
    final inFlight = _fullSnapshotInFlight;
    if (inFlight != null) return inFlight;
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) return Future.value(null);
    final future = _doFetchFullSnapshot(machine);
    _fullSnapshotInFlight = future;
    return future;
  }

  Future<AttentionSnapshot?> _doFetchFullSnapshot(Machine machine) async {
    final api = _apiFactory(machine);
    try {
      final snap = await api.getSnapshot(compact: false);
      if (snap != null) {
        _fullSnapshotCache = snap;
        _fullSnapshotCacheAt = DateTime.now();
      }
      return snap;
    } finally {
      api.dispose();
      _fullSnapshotInFlight = null;
    }
  }

  /// [fetchFullSnapshot], then the one agent matching [ptyId] — a
  /// convenience for In-flight's expand-to-see-full-summary action.
  Future<AgentSummary?> fetchFullAgentSummary(int ptyId) async {
    final snap = await fetchFullSnapshot();
    if (snap == null) return null;
    for (final a in snap.agents) {
      if (a.ptyId == ptyId) return a;
    }
    return null;
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
