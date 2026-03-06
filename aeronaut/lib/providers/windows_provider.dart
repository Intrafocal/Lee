import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/machine.dart';
import '../services/lee_api.dart';
import 'machines_provider.dart';

/// State for the open windows (workspaces) on the active machine.
class WindowsState {
  final List<WindowInfo> windows;
  final int? activeWindowId;

  const WindowsState({
    this.windows = const [],
    this.activeWindowId,
  });

  WindowInfo? get activeWindow {
    if (activeWindowId == null) return null;
    try {
      return windows.firstWhere((w) => w.id == activeWindowId);
    } catch (_) {
      return null;
    }
  }

  /// True when there are multiple windows to choose from.
  bool get hasMultipleWindows => windows.length > 1;

  WindowsState copyWith({
    List<WindowInfo>? windows,
    int? activeWindowId,
    bool clearActiveWindowId = false,
  }) {
    return WindowsState(
      windows: windows ?? this.windows,
      activeWindowId:
          clearActiveWindowId ? null : (activeWindowId ?? this.activeWindowId),
    );
  }
}

/// Tracks open windows on the active machine and the selected window.
///
/// Fetches windows from GET /windows on connect and periodically refreshes.
/// When only one window exists, it auto-selects it.
class WindowsNotifier extends StateNotifier<WindowsState> {
  final Ref _ref;
  Timer? _refreshTimer;
  String? _lastMachineId;

  WindowsNotifier(this._ref) : super(const WindowsState()) {
    // React to active machine changes
    _ref.listen<MachinesState>(machinesProvider, (prev, next) {
      final newId = next.activeMachineId;
      if (newId != _lastMachineId) {
        _lastMachineId = newId;
        _onMachineChanged(next.activeMachine);
      }
    });
  }

  void _onMachineChanged(Machine? machine) {
    _refreshTimer?.cancel();
    if (machine == null) {
      state = const WindowsState();
      return;
    }
    // Fetch immediately, then refresh every 10 seconds
    _fetchWindows(machine);
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => _fetchWindows(machine),
    );
  }

  Future<void> _fetchWindows(Machine machine) async {
    final api = LeeApi(machine: machine);
    try {
      final windows = await api.getWindows();
      if (!mounted) return;

      // Determine active window
      int? activeId = state.activeWindowId;

      // If current selection is no longer valid, reset
      if (activeId != null && !windows.any((w) => w.id == activeId)) {
        activeId = null;
      }

      // Auto-select: if none selected, pick the focused window or first
      if (activeId == null && windows.isNotEmpty) {
        final focused = windows.where((w) => w.focused);
        activeId = focused.isNotEmpty ? focused.first.id : windows.first.id;
      }

      state = WindowsState(windows: windows, activeWindowId: activeId);
    } catch (e) {
      debugPrint('Aeronaut: failed to fetch windows: $e');
    } finally {
      api.dispose();
    }
  }

  /// User selects a different window (workspace).
  void setActiveWindow(int windowId) {
    state = state.copyWith(activeWindowId: windowId);
  }

  /// Force refresh the windows list.
  Future<void> refresh() async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine != null) {
      await _fetchWindows(machine);
    }
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }
}

final windowsProvider =
    StateNotifierProvider<WindowsNotifier, WindowsState>((ref) {
  return WindowsNotifier(ref);
});

/// Convenience: the active window ID for passing to commands.
final activeWindowIdProvider = Provider<int?>((ref) {
  return ref.watch(windowsProvider).activeWindowId;
});
