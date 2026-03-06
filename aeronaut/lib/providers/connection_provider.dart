import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/lee_context.dart';
import '../models/machine.dart';
import 'machines_provider.dart';
import 'windows_provider.dart';

/// Connection state for the active machine's WebSocket.
enum ConnectionStatus { disconnected, connecting, connected, error }

class ConnectionState {
  final ConnectionStatus status;
  final String? errorMessage;

  const ConnectionState({
    this.status = ConnectionStatus.disconnected,
    this.errorMessage,
  });

  ConnectionState copyWith({
    ConnectionStatus? status,
    String? errorMessage,
  }) {
    return ConnectionState(
      status: status ?? this.status,
      errorMessage: errorMessage,
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

  int? _activeWindowId;

  ConnectionNotifier(this._ref) : super(const ConnectionState()) {
    // Watch for active machine changes
    _ref.listen<MachinesState>(machinesProvider, (prev, next) {
      final newId = next.activeMachineId;
      if (newId != _connectedMachineId) {
        _disconnect();
        if (newId != null && next.activeMachine != null) {
          _connect(next.activeMachine!);
        }
      }
    });

    // Watch for active window changes — clear cached context
    _ref.listen<WindowsState>(windowsProvider, (prev, next) {
      if (prev?.activeWindowId != next.activeWindowId) {
        _activeWindowId = next.activeWindowId;
        _lastContext = null;
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

  void _connect(Machine machine) {
    _connectedMachineId = machine.id;
    state = state.copyWith(status: ConnectionStatus.connecting);

    try {
      final uri = Uri.parse(machine.contextStreamUrl);
      _channel = WebSocketChannel.connect(
        uri,
        protocols: machine.token.isNotEmpty ? null : null,
      );

      _subscription = _channel!.stream.listen(
        (data) {
          state = state.copyWith(status: ConnectionStatus.connected);
          _handleMessage(data);
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
      }
    } catch (e) {
      debugPrint('Aeronaut WS parse error: $e');
    }
  }

  void _scheduleReconnect(Machine machine) {
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(const Duration(seconds: 3), () {
      if (_connectedMachineId == machine.id && mounted) {
        debugPrint('Aeronaut: reconnecting to ${machine.name}...');
        _connect(machine);
      }
    });
  }

  void _disconnect() {
    _reconnectTimer?.cancel();
    _subscription?.cancel();
    _channel?.sink.close();
    _channel = null;
    _connectedMachineId = null;
    _lastContext = null;
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
    super.dispose();
  }
}

final connectionProvider =
    StateNotifierProvider<ConnectionNotifier, ConnectionState>((ref) {
  return ConnectionNotifier(ref);
});
