import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'machines_provider.dart';

/// Metadata about the remote browser viewport.
class BrowserCastMetadata {
  final int viewportWidth;
  final int viewportHeight;
  final String url;
  final String title;

  const BrowserCastMetadata({
    this.viewportWidth = 0,
    this.viewportHeight = 0,
    this.url = '',
    this.title = '',
  });
}

/// State for a browser cast connection.
class BrowserCastState {
  final Uint8List? frame;
  final bool isConnected;
  final bool hasError;
  final String? errorMessage;
  final BrowserCastMetadata metadata;

  const BrowserCastState({
    this.frame,
    this.isConnected = false,
    this.hasError = false,
    this.errorMessage,
    this.metadata = const BrowserCastMetadata(),
  });

  BrowserCastState copyWith({
    Uint8List? frame,
    bool? isConnected,
    bool? hasError,
    String? errorMessage,
    BrowserCastMetadata? metadata,
  }) {
    return BrowserCastState(
      frame: frame ?? this.frame,
      isConnected: isConnected ?? this.isConnected,
      hasError: hasError ?? this.hasError,
      errorMessage: errorMessage,
      metadata: metadata ?? this.metadata,
    );
  }
}

/// Manages a WebSocket connection to Lee's browser cast endpoint.
///
/// Receives JPEG frames and metadata, sends touch/key/scroll events.
class BrowserCastNotifier extends StateNotifier<BrowserCastState> {
  final int tabId;
  final String wsUrl;
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  Timer? _reconnectTimer;
  bool _disposed = false;
  bool _connected = false;
  bool _initSent = false;

  BrowserCastNotifier({required this.tabId, required this.wsUrl})
      : super(const BrowserCastState()) {
    _connect();
  }

  void _connect() {
    if (_disposed) return;
    _initSent = false;
    _connected = false;
    _subscription?.cancel();
    _channel?.sink.close();

    try {
      final uri = Uri.parse(wsUrl);
      debugPrint('[BrowserCast] Connecting to $uri');
      _channel = WebSocketChannel.connect(uri);

      // Wait for WebSocket handshake to complete
      _channel!.ready.then((_) {
        if (_disposed) return;
        debugPrint('[BrowserCast] Connected for tab $tabId');
        _connected = true;
        state = state.copyWith(isConnected: true, hasError: false);
      }).catchError((error) {
        debugPrint('[BrowserCast] Handshake failed: $error');
        _connected = false;
        state = state.copyWith(
          isConnected: false,
          hasError: true,
          errorMessage: error.toString(),
        );
        _scheduleReconnect();
      });

      _subscription = _channel!.stream.listen(
        (data) {
          if (data is List<int>) {
            // Binary frame — JPEG image data
            state = state.copyWith(
              frame: Uint8List.fromList(data),
            );
          } else if (data is String) {
            // JSON message — metadata, error, or closed
            _handleJson(data);
          }
        },
        onError: (error) {
          debugPrint('[BrowserCast] WS error: $error');
          _connected = false;
          state = state.copyWith(
            isConnected: false,
            hasError: true,
            errorMessage: error.toString(),
          );
          _scheduleReconnect();
        },
        onDone: () {
          debugPrint('[BrowserCast] WS closed');
          _connected = false;
          state = state.copyWith(isConnected: false);
          _scheduleReconnect();
        },
      );
    } catch (e) {
      debugPrint('[BrowserCast] Connect failed: $e');
      _connected = false;
      state = state.copyWith(
        hasError: true,
        errorMessage: e.toString(),
      );
      _scheduleReconnect();
    }
  }

  void _handleJson(String data) {
    try {
      final json = jsonDecode(data) as Map<String, dynamic>;
      final type = json['type'] as String?;

      switch (type) {
        case 'metadata':
          state = state.copyWith(
            metadata: BrowserCastMetadata(
              viewportWidth: (json['viewportWidth'] as num?)?.toInt() ?? 0,
              viewportHeight: (json['viewportHeight'] as num?)?.toInt() ?? 0,
              url: json['url'] as String? ?? '',
              title: json['title'] as String? ?? '',
            ),
          );
          break;
        case 'error':
          state = state.copyWith(
            hasError: true,
            errorMessage: json['message'] as String?,
          );
          break;
        case 'closed':
          state = state.copyWith(isConnected: false);
          break;
      }
    } catch (e) {
      debugPrint('[BrowserCast] JSON parse error: $e');
    }
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    if (_disposed) return;
    _reconnectTimer = Timer(const Duration(seconds: 3), () {
      if (!_disposed) _connect();
    });
  }

  void _send(Map<String, dynamic> msg) {
    if (_channel != null && _connected) {
      _channel!.sink.add(jsonEncode(msg));
    }
  }

  /// Whether init has been sent for the current connection.
  bool get initSent => _initSent;

  /// Send init message with device dimensions.
  void sendInit({
    required double width,
    required double height,
    required double pixelRatio,
    required String orientation,
  }) {
    _send({
      'type': 'init',
      'width': width,
      'height': height,
      'pixelRatio': pixelRatio,
      'orientation': orientation,
    });
    _initSent = true;
  }

  /// Send resize/orientation change.
  void sendResize({
    required double width,
    required double height,
    required double pixelRatio,
    required String orientation,
  }) {
    _send({
      'type': 'resize',
      'width': width,
      'height': height,
      'pixelRatio': pixelRatio,
      'orientation': orientation,
    });
  }

  /// Send tap at normalized coordinates (0-1).
  void sendTap(double x, double y) {
    _send({'type': 'tap', 'x': x, 'y': y});
  }

  /// Send scroll at normalized position with delta.
  void sendScroll(double x, double y, double deltaX, double deltaY) {
    _send({
      'type': 'scroll',
      'x': x,
      'y': y,
      'deltaX': deltaX,
      'deltaY': deltaY,
    });
  }

  /// Send key event.
  void sendKey({String? key, String? text, String? code}) {
    _send({
      'type': 'key',
      'key': key,
      'text': text,
      'code': code,
    });
  }

  /// Navigate to a URL.
  void sendNavigate(String url) {
    _send({'type': 'navigate', 'url': url});
  }

  @override
  void dispose() {
    _disposed = true;
    _reconnectTimer?.cancel();
    _subscription?.cancel();
    _channel?.sink.close();
    super.dispose();
  }
}

/// Family provider for browser cast connections, keyed on tab ID.
final browserCastProvider = StateNotifierProvider.autoDispose
    .family<BrowserCastNotifier, BrowserCastState, int>((ref, tabId) {
  final machine = ref.watch(machinesProvider).activeMachine;
  final wsUrl = machine != null
      ? machine.wsUrl('/browser/$tabId/cast')
      : 'ws://localhost:9001/browser/$tabId/cast';
  return BrowserCastNotifier(tabId: tabId, wsUrl: wsUrl);
});
