import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../services/api_auth.dart';
import 'connection_provider.dart';
import 'machines_provider.dart';

/// Listens for 401s from either API client and turns them into UI state.
///
/// On a rejected token the guard:
/// 1. marks the machine [MachineHealth.unauthorized] in the machines list,
/// 2. tears down the context WebSocket and stops the reconnect loop, and
/// 3. holds an [AuthFailure] that screens render as
///    "Token rejected. Re-pair this machine."
///
/// Installed once from `AeronautApp.initState`.
class AuthGuardNotifier extends StateNotifier<AuthFailure?> {
  final Ref _ref;

  /// Failures the user has dismissed. The background pinger retries every
  /// 15s, so without this the banner would come straight back.
  final Set<String> _dismissed = {};

  AuthGuardNotifier(this._ref) : super(null) {
    ApiAuth.handler = _onUnauthorized;
  }

  static String _key(AuthFailure f) => '${f.machineId}:${f.service.name}';

  void _onUnauthorized(AuthFailure failure) {
    if (!mounted) return;
    if (_dismissed.contains(_key(failure))) return;
    // Don't thrash the UI while one bad token produces a burst of 401s.
    if (state?.machineId == failure.machineId &&
        state?.service == failure.service) {
      return;
    }
    state = failure;
    _ref.read(machinesProvider.notifier).markUnauthorized(failure.machineId);
    _ref.read(connectionProvider.notifier).handleAuthFailure(failure);
  }

  /// Dismiss the banner and stop it re-appearing for that machine until the
  /// machine is re-paired.
  void clear() {
    final current = state;
    if (current == null) return;
    _dismissed.add(_key(current));
    state = null;
  }

  /// Called after pairing: a new token deserves a fresh chance.
  void reset() {
    _dismissed.clear();
    state = null;
  }

  @override
  void dispose() {
    if (identical(ApiAuth.handler, _onUnauthorized)) {
      ApiAuth.handler = null;
    }
    super.dispose();
  }
}

final authGuardProvider =
    StateNotifierProvider<AuthGuardNotifier, AuthFailure?>((ref) {
  return AuthGuardNotifier(ref);
});
