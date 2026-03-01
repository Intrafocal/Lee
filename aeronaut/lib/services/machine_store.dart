import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/machine.dart';

/// Persists machine configurations to SharedPreferences.
class MachineStore {
  static const _key = 'aeronaut_machines';
  static const _activeKey = 'aeronaut_active_machine_id';

  SharedPreferences? _prefs;

  Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
  }

  /// Load all saved machines.
  List<Machine> loadMachines() {
    final json = _prefs?.getString(_key);
    if (json == null) return [];
    try {
      final list = jsonDecode(json) as List<dynamic>;
      return list
          .map((e) => Machine.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// Save the full list of machines.
  Future<void> saveMachines(List<Machine> machines) async {
    final json = jsonEncode(machines.map((m) => m.toJson()).toList());
    await _prefs?.setString(_key, json);
  }

  /// Get the last active machine ID.
  String? loadActiveMachineId() {
    return _prefs?.getString(_activeKey);
  }

  /// Save the active machine ID.
  Future<void> saveActiveMachineId(String? id) async {
    if (id == null) {
      await _prefs?.remove(_activeKey);
    } else {
      await _prefs?.setString(_activeKey, id);
    }
  }
}
