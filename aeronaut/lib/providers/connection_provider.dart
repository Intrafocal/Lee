import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/attention.dart';
import '../models/lee_context.dart';
import '../models/machine.dart';
import '../services/api_auth.dart';
import '../services/lee_api.dart';
import 'machines_provider.dart';
import 'windows_provider.dart';

/// Connection state for the active machine's WebSocket.
enum ConnectionStatus { disconnected, connecting, connected, error }

class ConnectionState {
  final ConnectionStatus status;
  final String? errorMessage;

  /// True when the stream stopped because Lee rejected the bearer token.
  /// The UI shows "Token rejected. Re-pair this machine." and no retry.
  final bool unauthorized;

  const ConnectionState({
    this.status = ConnectionStatus.disconnected,
    this.errorMessage,
    this.unauthorized = false,
  });

  ConnectionState copyWith({
    ConnectionStatus? status,
    String? errorMessage,
    bool? unauthorized,
  }) {
    return ConnectionState(
      status: status ?? this.status,
      errorMessage: errorMessage,
      unauthorized: unauthorized ?? this.unauthorized,
    );
  }
}

/// Manages WebSocket connection to the active machine's /context/stream.
///
/// Auto-connects when active machine changes, auto-reconnects on disconnect.
class ConnectionNotifier extends StateNotifier<ConnectionState> {
  final Ref _ref;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  Timer? _reconnectTimer;
  String? _connectedMachineId;

  ConnectionNotifier(this._ref) : super(const ConnectionState()) {
    // Watch for active machine changes
    _ref.listen<MachinesState>(machinesProvider, (prev, next) {
      final newId = next.activeMachineId;
      // A new machine, or the same one reached on its other address
      // (Tailscale ↔ local): reconnect either way.
      final hostChanged = prev?.activeMachine?.host != next.activeMachine?.host;
      if (newId != _connectedMachineId || (newId != null && hostChanged)) {
        _disconnect();
        if (newId != null && next.activeMachine != null) {
          _connect(next.activeMachine!);
        }
      }
    });

    // Watch for active window changes — clear cached context
    _ref.listen<WindowsState>(windowsProvider, (prev, next) {
      if (prev?.activeWindowId != next.activeWindowId) {
        // Drop the replay buffer so a late subscriber doesn't see the
        // previous window's tabs.
        _lastContext = null;
        // Lee only broadcasts a window's context when it changes, so pull
        // the newly selected one now rather than showing the old window
        // until the new one happens to update.
        final windowId = next.activeWindowId;
        if (windowId != null) _fetchWindowContext(windowId);
      }
    });
  }

  /// The stream of LeeContext updates from the WebSocket.
  /// Replays the last value to new subscribers so late listeners don't miss
  /// the initial context_update sent on WebSocket connect.
  final _contextController = StreamController<LeeContext>.broadcast();
  LeeContext? _lastContext;
  Stream<LeeContext> get contextStream async* {
    if (_lastContext != null) {
      yield _lastContext!;
    }
    yield* _contextController.stream;
  }

  /// Copilot queue snapshots (contracts §5.6): machine-wide, so unlike
  /// [contextStream] these need no per-window filtering. Replays the last
  /// value to new subscribers, same reasoning as [contextStream].
  final _attentionController = StreamController<AttentionSnapshot>.broadcast();
  AttentionSnapshot? _lastAttention;
  Stream<AttentionSnapshot> get attentionStream async* {
    if (_lastAttention != null) yield _lastAttention!;
    yield* _attentionController.stream;
  }

  /// Presence pushes (contracts §3.3): also machine-wide and replayed.
  final _presenceController = StreamController<PresenceState>.broadcast();
  PresenceState? _lastPresence;
  Stream<PresenceState> get presenceStream async* {
    if (_lastPresence != null) yield _lastPresence!;
    yield* _presenceController.stream;
  }

  /// "You're back" events (contracts §7.3) — a one-shot notice, not a
  /// snapshot of standing state, so it's never replayed to a late listener.
  final _returnController = StreamController<ReturnInfo>.broadcast();
  Stream<ReturnInfo> get returnStream => _returnController.stream;

  /// Fetch `GET /context?window_id=` and publish it, unless the selection
  /// or machine moved on while the request was in flight.
  Future<void> _fetchWindowContext(int windowId) async {
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    final api = LeeApi(machine: machine);
    try {
      final ctx = await api.getContext(windowId: windowId);
      if (ctx == null || !mounted) return;
      if (_connectedMachineId != machine.id) return;
      if (_ref.read(windowsProvider).activeWindowId != windowId) return;
      _lastContext = ctx;
      _contextController.add(ctx);
    } finally {
      api.dispose();
    }
  }

  void _connect(Machine machine) {
    _connectedMachineId = machine.id;
    state = const ConnectionState(status: ConnectionStatus.connecting);

    try {
      final uri = Uri.parse(machine.contextStreamUrl);
      // The token rides as a query param: WebSocket upgrades can't carry an
      // Authorization header. Machine.wsUrl() appends it.
      _channel = WebSocketChannel.connect(uri);

      _subscription = _channel!.stream.listen(
        (data) {
          final wasConnected = state.status == ConnectionStatus.connected;
          state = state.copyWith(status: ConnectionStatus.connected);
          _handleMessage(data);
          // The snapshot Lee sends on connect is the *focused* window's; when
          // another window is selected it was filtered out above, so fetch
          // ours instead.
          final windowId = _ref.read(windowsProvider).activeWindowId;
          if (!wasConnected && windowId != null) _fetchWindowContext(windowId);
        },
        onError: (error) {
          debugPrint('Aeronaut WS error: $error');
          state = state.copyWith(
            status: ConnectionStatus.error,
            errorMessage: error.toString(),
          );
          _scheduleReconnect(machine);
        },
        onDone: () {
          debugPrint('Aeronaut WS closed');
          state = state.copyWith(status: ConnectionStatus.disconnected);
          _scheduleReconnect(machine);
        },
      );
    } catch (e) {
      debugPrint('Aeronaut WS connect failed: $e');
      state = state.copyWith(
        status: ConnectionStatus.error,
        errorMessage: e.toString(),
      );
      _scheduleReconnect(machine);
    }
  }

  void _handleMessage(dynamic data) {
    try {
      final json = jsonDecode(data as String) as Map<String, dynamic>;
      final type = json['type'] as String?;

      if (type == 'context_update') {
        // Filter by active window_id if set
        final msgWindowId = (json['window_id'] as num?)?.toInt();
        final activeWindowId = _ref.read(windowsProvider).activeWindowId;
        if (activeWindowId != null &&
            msgWindowId != null &&
            msgWindowId != activeWindowId) {
          return; // Context from a different window, skip
        }

        final contextData = json['data'] as Map<String, dynamic>;
        final context = LeeContext.fromJson(contextData);
        _lastContext = context;
        _contextController.add(context);
      } else if (type == 'attention_snapshot') {
        final snapshot =
            AttentionSnapshot.fromJson(json['data'] as Map<String, dynamic>);
        _lastAttention = snapshot;
        _attentionController.add(snapshot);
      } else if (type == 'presence') {
        final presence =
            PresenceState.fromJson(json['data'] as Map<String, dynamic>);
        _lastPresence = presence;
        _presenceController.add(presence);
      } else if (type == 'copilot_return') {
        _returnController.add(ReturnInfo.fromJson(json['data'] as Map<String, dynamic>));
      }
      // Other message types (e.g. future additions) are ignored, same as
      // Hester's and Dirigible's clients on this socket (contracts §3.3).
    } catch (e) {
      debugPrint('Aeronaut WS parse error: $e');
    }
  }

  void _scheduleReconnect(Machine machine) {
    if (state.unauthorized) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 3), () async {
      if (_connectedMachineId != machine.id || !mounted) return;

      // A rejected token closes the WebSocket upgrade with a 401, which
      // surfaces here as a plain socket error. Probe an authenticated HTTP
      // route so we can stop retrying and tell the user to re-pair, instead
      // of looping forever against a token Lee will never accept.
      final api = LeeApi(machine: machine);
      final ApiStatus status;
      try {
        status = await api.probe();
      } finally {
        api.dispose();
      }
      if (_connectedMachineId != machine.id || !mounted) return;
      if (status == ApiStatus.unauthorized) {
        // ApiAuth already notified the guard, which calls handleAuthFailure.
        return;
      }

      debugPrint('Aeronaut: reconnecting to ${machine.name}...');
      _connect(machine);
    });
  }

  /// Called by the auth guard when this machine's token is rejected.
  void handleAuthFailure(AuthFailure failure) {
    if (failure.machineId != _connectedMachineId) return;
    _reconnectTimer?.cancel();
    _subscription?.cancel();
    _channel?.sink.close();
    _channel = null;
    _lastContext = null;
    _lastAttention = null;
    _lastPresence = null;
    state = const ConnectionState(
      status: ConnectionStatus.error,
      errorMessage: AuthFailure.message,
      unauthorized: true,
    );
  }

  void _disconnect() {
    _reconnectTimer?.cancel();
    _subscription?.cancel();
    _channel?.sink.close();
    _channel = null;
    _connectedMachineId = null;
    _lastContext = null;
    _lastAttention = null;
    _lastPresence = null;
    state = const ConnectionState();
  }

  /// Manually trigger reconnect.
  void reconnect() {
    final machine =
        _ref.read(machinesProvider).activeMachine;
    if (machine != null) {
      _disconnect();
      _connect(machine);
    }
  }

  @override
  void dispose() {
    _disconnect();
    _contextController.close();
    _attentionController.close();
    _presenceController.close();
    _returnController.close();
    super.dispose();
  }
}

final connectionProvider =
    StateNotifierProvider<ConnectionNotifier, ConnectionState>((ref) {
  return ConnectionNotifier(ref);
});
