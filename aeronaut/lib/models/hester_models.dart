import 'package:equatable/equatable.dart';

/// ReAct phase enum matching Hester daemon SSE events.
enum ReActPhase {
  preparing,
  thinking,
  acting,
  observing,
  responding;

  static ReActPhase fromString(String value) {
    return ReActPhase.values.firstWhere(
      (p) => p.name == value,
      orElse: () => ReActPhase.thinking,
    );
  }

  String get label {
    switch (this) {
      case ReActPhase.preparing:
        return 'Preparing';
      case ReActPhase.thinking:
        return 'Thinking';
      case ReActPhase.acting:
        return 'Acting';
      case ReActPhase.observing:
        return 'Observing';
      case ReActPhase.responding:
        return 'Responding';
    }
  }
}

/// A single ReAct phase event from the SSE stream.
class PhaseEvent extends Equatable {
  final ReActPhase phase;
  final int iteration;
  final String? toolName;
  final String? toolContext;

  const PhaseEvent({
    required this.phase,
    this.iteration = 0,
    this.toolName,
    this.toolContext,
  });

  factory PhaseEvent.fromJson(Map<String, dynamic> json) {
    return PhaseEvent(
      phase: ReActPhase.fromString(json['phase'] as String),
      iteration: json['iteration'] as int? ?? 0,
      toolName: json['tool_name'] as String?,
      toolContext: json['tool_context'] as String?,
    );
  }

  @override
  List<Object?> get props => [phase, iteration, toolName, toolContext];
}

/// A chat message in a Hester conversation.
class ChatMessage extends Equatable {
  final String role; // 'user' or 'assistant'
  final String content;
  final DateTime timestamp;

  const ChatMessage({
    required this.role,
    required this.content,
    required this.timestamp,
  });

  bool get isUser => role == 'user';
  bool get isAssistant => role == 'assistant';

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    return ChatMessage(
      role: json['role'] as String,
      content: json['content'] as String,
      timestamp: json['timestamp'] != null
          ? DateTime.parse(json['timestamp'] as String)
          : DateTime.now(),
    );
  }

  @override
  List<Object?> get props => [role, content, timestamp];
}

/// A Hester session with conversation history.
class HesterSession extends Equatable {
  final String sessionId;
  final List<ChatMessage> messages;
  final DateTime createdAt;

  const HesterSession({
    required this.sessionId,
    this.messages = const [],
    required this.createdAt,
  });

  @override
  List<Object?> get props => [sessionId, messages, createdAt];
}

/// Summary of a context bundle from GET /bundles.
class BundleSummary extends Equatable {
  final String id;
  final String title;
  final List<String> tags;
  final bool stale;
  final int sourceCount;
  final String? updatedAt;

  const BundleSummary({
    required this.id,
    required this.title,
    this.tags = const [],
    this.stale = false,
    this.sourceCount = 0,
    this.updatedAt,
  });

  factory BundleSummary.fromJson(Map<String, dynamic> json) {
    return BundleSummary(
      id: json['id'] as String,
      title: json['title'] as String,
      tags: (json['tags'] as List<dynamic>?)
              ?.map((t) => t as String)
              .toList() ??
          [],
      stale: json['stale'] as bool? ?? false,
      sourceCount: json['source_count'] as int? ?? 0,
      updatedAt: json['updated_at'] as String?,
    );
  }

  @override
  List<Object?> get props => [id, title, tags, stale, sourceCount, updatedAt];
}

/// Chat state held by HesterChatNotifier.
class HesterChatState extends Equatable {
  final List<ChatMessage> messages;
  final PhaseEvent? currentPhase;
  final bool isStreaming;
  final String sessionId;
  final String? error;

  const HesterChatState({
    this.messages = const [],
    this.currentPhase,
    this.isStreaming = false,
    required this.sessionId,
    this.error,
  });

  HesterChatState copyWith({
    List<ChatMessage>? messages,
    PhaseEvent? currentPhase,
    bool? clearPhase,
    bool? isStreaming,
    String? sessionId,
    String? error,
    bool? clearError,
  }) {
    return HesterChatState(
      messages: messages ?? this.messages,
      currentPhase:
          clearPhase == true ? null : (currentPhase ?? this.currentPhase),
      isStreaming: isStreaming ?? this.isStreaming,
      sessionId: sessionId ?? this.sessionId,
      error: clearError == true ? null : (error ?? this.error),
    );
  }

  @override
  List<Object?> get props =>
      [messages, currentPhase, isStreaming, sessionId, error];
}
