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

/// One verified win in the session-start digest (`GET /copilot/digest`,
/// contracts §8.4). "Verified" means Lee/Hester checked it, not an agent's
/// own claim — see [DigestAgentClaim] for those.
class DigestWin extends Equatable {
  final String kind; // commit | merge | decision | someday_decided
  final String title;
  final String? ref;
  final DateTime? at;
  final bool verified;
  final bool related;

  const DigestWin({
    required this.kind,
    required this.title,
    this.ref,
    this.at,
    this.verified = false,
    this.related = false,
  });

  factory DigestWin.fromJson(Map<String, dynamic> json) {
    return DigestWin(
      kind: json['kind'] as String? ?? '',
      title: json['title'] as String? ?? '',
      ref: json['ref'] as String?,
      at: json['at'] != null ? DateTime.tryParse(json['at'] as String) : null,
      verified: json['verified'] as bool? ?? false,
      related: json['related'] as bool? ?? false,
    );
  }

  @override
  List<Object?> get props => [kind, title, ref, at, verified, related];
}

/// An agent's own claim about what it did — always unverified by
/// definition (spec §2.3), shown separately from [DigestWin].
class DigestAgentClaim extends Equatable {
  final String sessionId;
  final int? ptyId;
  final String summary;
  final DateTime? at;
  final bool verified;
  final bool related;

  const DigestAgentClaim({
    required this.sessionId,
    this.ptyId,
    this.summary = '',
    this.at,
    this.verified = false,
    this.related = false,
  });

  factory DigestAgentClaim.fromJson(Map<String, dynamic> json) {
    return DigestAgentClaim(
      sessionId: json['session_id'] as String? ?? '',
      ptyId: (json['pty_id'] as num?)?.toInt(),
      summary: json['summary'] as String? ?? '',
      at: json['at'] != null ? DateTime.tryParse(json['at'] as String) : null,
      verified: json['verified'] as bool? ?? false,
      related: json['related'] as bool? ?? false,
    );
  }

  @override
  List<Object?> get props => [sessionId, ptyId, summary, at, verified, related];
}

class DigestSomeday extends Equatable {
  final int open;
  final int untriagedOver7d;

  const DigestSomeday({this.open = 0, this.untriagedOver7d = 0});

  factory DigestSomeday.fromJson(Map<String, dynamic> json) {
    return DigestSomeday(
      open: (json['open'] as num?)?.toInt() ?? 0,
      untriagedOver7d: (json['untriaged_over_7d'] as num?)?.toInt() ?? 0,
    );
  }

  @override
  List<Object?> get props => [open, untriagedOver7d];
}

class DigestRetro extends Equatable {
  final bool due;
  final String? week;

  const DigestRetro({this.due = false, this.week});

  factory DigestRetro.fromJson(Map<String, dynamic> json) {
    return DigestRetro(
      due: json['due'] as bool? ?? false,
      week: json['week'] as String?,
    );
  }

  @override
  List<Object?> get props => [due, week];
}

/// `GET /copilot/digest` response (contracts §8.4) — the session-start
/// digest, used by Aeronaut's Wins section (v1, §9.2).
class DigestResult extends Equatable {
  final DateTime? generatedAt;
  final String? workspace;
  final DateTime? since;
  final String topLine;
  final List<DigestWin> wins;
  final List<DigestAgentClaim> agentClaims;
  final int changedCommits;
  final List<String> changedAgentFiles;
  final DigestSomeday someday;
  final DigestRetro retro;

  const DigestResult({
    this.generatedAt,
    this.workspace,
    this.since,
    this.topLine = '',
    this.wins = const [],
    this.agentClaims = const [],
    this.changedCommits = 0,
    this.changedAgentFiles = const [],
    this.someday = const DigestSomeday(),
    this.retro = const DigestRetro(),
  });

  factory DigestResult.fromJson(Map<String, dynamic> json) {
    final changed = json['changed'] as Map<String, dynamic>?;
    return DigestResult(
      generatedAt: json['generated_at'] != null
          ? DateTime.tryParse(json['generated_at'] as String)
          : null,
      workspace: json['workspace'] as String?,
      since: json['since'] != null ? DateTime.tryParse(json['since'] as String) : null,
      topLine: json['top_line'] as String? ?? '',
      wins: (json['wins'] as List<dynamic>?)
              ?.map((w) => DigestWin.fromJson(w as Map<String, dynamic>))
              .toList() ??
          const [],
      agentClaims: (json['agent_claims'] as List<dynamic>?)
              ?.map((c) => DigestAgentClaim.fromJson(c as Map<String, dynamic>))
              .toList() ??
          const [],
      changedCommits: (changed?['commits'] as num?)?.toInt() ?? 0,
      changedAgentFiles: (changed?['agent_files'] as List<dynamic>?)
              ?.map((f) => f as String)
              .toList() ??
          const [],
      someday: json['someday'] != null
          ? DigestSomeday.fromJson(json['someday'] as Map<String, dynamic>)
          : const DigestSomeday(),
      retro: json['retro'] != null
          ? DigestRetro.fromJson(json['retro'] as Map<String, dynamic>)
          : const DigestRetro(),
    );
  }

  @override
  List<Object?> get props => [
        generatedAt,
        workspace,
        since,
        topLine,
        wins,
        agentClaims,
        changedCommits,
        changedAgentFiles,
        someday,
        retro,
      ];
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

/// A Cockpit task as the one-agent screen needs it (Hester's
/// `GET /cockpit/tasks`, `to_api`): which agent works on it and whether it
/// waits for review.
class TaskRef extends Equatable {
  final String id;
  final String title;

  /// The session name you gave it, when there is one (shown over [title]).
  final String? name;
  final String status;
  final int? agentPtyId;

  const TaskRef({required this.id, this.title = '', this.name, this.status = 'running', this.agentPtyId});

  factory TaskRef.fromJson(Map<String, dynamic> json) {
    final agent = json['agent'];
    final name = json['name'];
    return TaskRef(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      name: name is String && name.trim().isNotEmpty ? name : null,
      status: json['status'] as String? ?? 'running',
      agentPtyId: agent is Map<String, dynamic> ? (agent['pty_id'] as num?)?.toInt() : null,
    );
  }

  String get displayTitle => name ?? title;
  bool get inReview => status == 'review';

  @override
  List<Object?> get props => [id, title, name, status, agentPtyId];
}
