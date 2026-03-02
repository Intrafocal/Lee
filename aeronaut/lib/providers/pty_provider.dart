import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:xterm/xterm.dart';

import 'machines_provider.dart';

/// State for a single PTY connection.
class PtyState {
  final Terminal terminal;
  final bool exited;
  final int? exitCode;

  PtyState({Terminal? terminal, this.exited = false, this.exitCode})
      : terminal = terminal ?? Terminal(maxLines: 10000);
}

/// Manages a WebSocket connection to a PTY stream.
///
/// Connects to `ws://host:port/pty/:id/stream` and feeds output
/// into an xterm Terminal for proper escape sequence rendering.
class PtyNotifier extends StateNotifier<PtyState> {
  final int ptyId;
  final String wsUrl;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;

  PtyNotifier({required this.ptyId, required this.wsUrl})
      : super(PtyState()) {
    // Wire up user input from terminal to PTY WebSocket
    state.terminal.onOutput = (data) {
      _sendRaw(data);
    };
    // Wire up resize events
    state.terminal.onResize = (cols, rows, pixelWidth, pixelHeight) {
      _sendResize(cols, rows);
    };
    _connect();
  }

  void _connect() {
    try {
      final uri = Uri.parse('$wsUrl/pty/$ptyId/stream');
      _channel = WebSocketChannel.connect(uri);

      _subscription = _channel!.stream.listen(
        (data) {
          try {
            final json = jsonDecode(data as String) as Map<String, dynamic>;
            final type = json['type'] as String?;

            if (type == 'data') {
              // Feed raw PTY data into xterm terminal — it handles all
              // escape sequences, cursor positioning, alternate screen, etc.
              state.terminal.write(json['data'] as String);
            } else if (type == 'exit') {
              state = PtyState(
                terminal: state.terminal,
                exited: true,
                exitCode: (json['code'] as num?)?.toInt(),
              );
            }
          } catch (e) {
            debugPrint('PTY $ptyId parse error: $e');
          }
        },
        onError: (error) {
          debugPrint('PTY $ptyId WS error: $error');
        },
        onDone: () {
          debugPrint('PTY $ptyId WS closed');
          if (!state.exited) {
            state = PtyState(
              terminal: state.terminal,
              exited: true,
              exitCode: -1,
            );
          }
        },
      );
    } catch (e) {
      debugPrint('PTY $ptyId connect failed: $e');
    }
  }

  /// Send raw input text to the PTY.
  void _sendRaw(String text) {
    if (_channel != null && !state.exited) {
      _channel!.sink.add(text);
    }
  }

  /// Send a resize command so the remote PTY adjusts its dimensions.
  void _sendResize(int cols, int rows) {
    if (_channel != null && !state.exited) {
      _channel!.sink.add(jsonEncode({
        'type': 'resize',
        'cols': cols,
        'rows': rows,
      }));
    }
  }

  /// Send input text to the PTY (public, for input bar).
  void sendInput(String text) {
    _sendRaw(text);
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _channel?.sink.close();
    super.dispose();
  }
}

/// Family provider for PTY connections, keyed on PTY ID.
///
/// NOT auto-dispose: PTY connections persist across tab switches
/// so we don't re-connect and replay the buffer every time.
final ptyProvider = StateNotifierProvider
    .family<PtyNotifier, PtyState, int>((ref, ptyId) {
  final machine = ref.watch(machinesProvider).activeMachine;
  final wsUrl = machine != null
      ? 'ws://${machine.host}:${machine.hostPort}'
      : 'ws://localhost:9001';
  return PtyNotifier(ptyId: ptyId, wsUrl: wsUrl);
});
