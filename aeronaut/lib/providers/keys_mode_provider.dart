import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A tab's view opens in Compose; Keys (keystroke-by-keystroke, for TUIs)
/// is one toggle away and remembered per tab
/// (docs/plans/2026-09-28-tether-review-voice.md §4.6). The set holds the
/// tabs in Keys mode, as `<machine id>:<pty id>` (a PTY id is unique
/// across a Lee's windows).
const _prefsKey = 'keys_mode_tabs';

/// At most this many remembered; the oldest go first.
const _keep = 200;

String keysModeKey(String machineId, int ptyId) => '$machineId:$ptyId';

class KeysModeNotifier extends StateNotifier<List<String>> {
  KeysModeNotifier() : super(const []) {
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getStringList(_prefsKey);
      if (saved != null && mounted) state = saved;
    } catch (_) {
      // No prefs (tests): every tab starts in Compose.
    }
  }

  bool isKeys(String key) => state.contains(key);

  Future<void> setKeys(String key, bool keys) async {
    final next = [...state]..remove(key);
    if (keys) next.add(key);
    state = next.length > _keep ? next.sublist(next.length - _keep) : next;
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(_prefsKey, state);
    } catch (_) {
      // Remembered for this run only.
    }
  }
}

final keysModeProvider = StateNotifierProvider<KeysModeNotifier, List<String>>((ref) => KeysModeNotifier());
