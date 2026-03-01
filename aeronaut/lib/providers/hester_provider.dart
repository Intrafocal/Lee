import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../models/hester_models.dart';
import '../models/machine.dart';
import '../services/hester_api.dart';
import 'machines_provider.dart';

/// Chat state notifier for Hester conversations.
///
/// Handles SSE streaming, phase updates, and message management.
class HesterChatNotifier extends StateNotifier<HesterChatState> {
  final HesterApi _api;

  HesterChatNotifier(this._api)
      : super(HesterChatState(sessionId: const Uuid().v4()));

  /// Send a message and stream the response via SSE.
  Future<void> sendMessage(String text) async {
    if (state.isStreaming || text.trim().isEmpty) return;

    // Add user message
    final userMsg = ChatMessage(
      role: 'user',
      content: text.trim(),
      timestamp: DateTime.now(),
    );
    state = state.copyWith(
      messages: [...state.messages, userMsg],
      isStreaming: true,
      clearError: true,
      clearPhase: true,
    );

    try {
      final response = await _api.streamMessage(state.sessionId, text.trim());
      if (response == null) {
        state = state.copyWith(
          isStreaming: false,
          error: 'Failed to connect to Hester',
        );
        return;
      }

      // Parse SSE from the byte stream
      await _parseSseStream(response.stream);
    } catch (e) {
      debugPrint('Hester stream error: $e');
      state = state.copyWith(
        isStreaming: false,
        error: e.toString(),
      );
    }
  }

  /// Parse SSE events from a chunked byte stream.
  Future<void> _parseSseStream(Stream<List<int>> byteStream) async {
    String buffer = '';
    String? currentEvent;
    String? currentData;

    await for (final chunk in byteStream.transform(utf8.decoder)) {
      buffer += chunk;

      // Split on double newline (SSE event boundary)
      while (buffer.contains('\n\n')) {
        final idx = buffer.indexOf('\n\n');
        final block = buffer.substring(0, idx);
        buffer = buffer.substring(idx + 2);

        // Parse the SSE block
        currentEvent = null;
        currentData = null;

        for (final line in block.split('\n')) {
          if (line.startsWith('event: ')) {
            currentEvent = line.substring(7).trim();
          } else if (line.startsWith('data: ')) {
            currentData = line.substring(6);
          }
        }

        if (currentEvent != null && currentData != null) {
          _handleSseEvent(currentEvent, currentData);
        }
      }
    }

    // Ensure streaming state is cleared
    if (state.isStreaming) {
      state = state.copyWith(isStreaming: false, clearPhase: true);
    }
  }

  /// Handle a parsed SSE event.
  void _handleSseEvent(String event, String data) {
    try {
      final json = jsonDecode(data) as Map<String, dynamic>;

      switch (event) {
        case 'phase':
          final phase = PhaseEvent.fromJson(json);
          state = state.copyWith(currentPhase: phase);
          break;

        case 'response':
          final text = json['text'] as String?;
          if (text != null && text.isNotEmpty) {
            final assistantMsg = ChatMessage(
              role: 'assistant',
              content: text,
              timestamp: DateTime.now(),
            );
            state = state.copyWith(
              messages: [...state.messages, assistantMsg],
            );
          }
          // Update session ID if the server assigned one
          final serverSessionId = json['session_id'] as String?;
          if (serverSessionId != null) {
            state = state.copyWith(sessionId: serverSessionId);
          }
          break;

        case 'error':
          final error = json['error'] as String?;
          state = state.copyWith(
            isStreaming: false,
            error: error ?? 'Unknown error',
            clearPhase: true,
          );
          break;

        case 'done':
          state = state.copyWith(
            isStreaming: false,
            clearPhase: true,
          );
          break;
      }
    } catch (e) {
      debugPrint('SSE event parse error: $e');
    }
  }

  /// Load a previous session's history.
  Future<void> loadSession(String sessionId) async {
    final messages = await _api.getSessionHistory(sessionId);
    state = HesterChatState(
      sessionId: sessionId,
      messages: messages,
    );
  }

  /// Start a new conversation.
  void newConversation() {
    state = HesterChatState(sessionId: const Uuid().v4());
  }
}

/// Provider for the Hester chat notifier, tied to the active machine.
final hesterChatProvider =
    StateNotifierProvider<HesterChatNotifier, HesterChatState>((ref) {
  final machine = ref.watch(
    machinesProvider.select((s) => s.activeMachine),
  );
  final api = HesterApi(machine: machine ?? const Machine(id: '', name: '', host: ''));
  ref.onDispose(() => api.dispose());
  return HesterChatNotifier(api);
});
