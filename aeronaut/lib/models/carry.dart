import 'package:equatable/equatable.dart';

/// Library's Carry (docs/14-Deep-Work.md §8.1): where you stopped, what's
/// still open, and what the next session opens first. Mirrors Lee main's
/// `GET /carry` (built from Hester's opener and open-next).

/// The exploration to pick up.
class CarryPickUp extends Equatable {
  final String explorationId;
  final String title;

  /// Your last sentence from the session's ending ritual; null when none was written.
  final String? stoppedAt;
  final DateTime? lastTouchedAt;

  const CarryPickUp({required this.explorationId, this.title = '', this.stoppedAt, this.lastTouchedAt});

  factory CarryPickUp.fromJson(Map<String, dynamic> json) {
    return CarryPickUp(
      explorationId: json['exploration_id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      stoppedAt: _nonEmpty(json['stopped_at']),
      lastTouchedAt: _parseDate(json['last_touched_at']),
    );
  }

  @override
  List<Object?> get props => [explorationId, title, stoppedAt, lastTouchedAt];
}

/// One open question, in your words.
class CarryQuestion extends Equatable {
  final String explorationId;
  final String questionId;
  final String text;

  const CarryQuestion({required this.explorationId, required this.questionId, required this.text});

  factory CarryQuestion.fromJson(Map<String, dynamic> json) {
    return CarryQuestion(
      explorationId: json['exploration_id'] as String? ?? '',
      questionId: json['question_id'] as String? ?? '',
      text: json['text'] as String? ?? '',
    );
  }

  @override
  List<Object?> get props => [explorationId, questionId, text];
}

/// What the next Deep session opens first: an exploration or a captured thought.
class OpenNext extends Equatable {
  final String? explorationId;
  final String? somedayId;
  final DateTime? setAt;

  const OpenNext({this.explorationId, this.somedayId, this.setAt});

  factory OpenNext.fromJson(Map<String, dynamic> json) {
    return OpenNext(
      explorationId: _nonEmpty(json['exploration_id']),
      somedayId: _nonEmpty(json['someday_id']),
      setAt: _parseDate(json['set_at']),
    );
  }

  @override
  List<Object?> get props => [explorationId, somedayId, setAt];
}

class CarrySnapshot extends Equatable {
  final String? workspace;
  final CarryPickUp? pickUp;

  /// At most 5.
  final List<CarryQuestion> openQuestions;
  final int capturedCount;
  final int readingCount;
  final OpenNext? openNext;

  const CarrySnapshot({
    this.workspace,
    this.pickUp,
    this.openQuestions = const [],
    this.capturedCount = 0,
    this.readingCount = 0,
    this.openNext,
  });

  factory CarrySnapshot.fromJson(Map<String, dynamic> json) {
    return CarrySnapshot(
      workspace: json['workspace'] as String?,
      pickUp: json['pick_up'] is Map<String, dynamic>
          ? CarryPickUp.fromJson(json['pick_up'] as Map<String, dynamic>)
          : null,
      openQuestions: (json['open_questions'] as List<dynamic>?)
              ?.whereType<Map<String, dynamic>>()
              .map(CarryQuestion.fromJson)
              .where((q) => q.text.isNotEmpty)
              .toList() ??
          const [],
      capturedCount: (json['captured_count'] as num?)?.toInt() ?? 0,
      readingCount: (json['reading_count'] as num?)?.toInt() ?? 0,
      openNext: json['open_next'] is Map<String, dynamic>
          ? OpenNext.fromJson(json['open_next'] as Map<String, dynamic>)
          : null,
    );
  }

  /// True when the Mac's next session already opens [explorationId] first.
  bool opensFirst(String explorationId) => openNext?.explorationId == explorationId;

  @override
  List<Object?> get props => [workspace, pickUp, openQuestions, capturedCount, readingCount, openNext];
}

/// Result of a Carry read: the snapshot, or why there isn't one.
class CarryResult extends Equatable {
  final CarrySnapshot? carry;

  /// 'hester_offline', 'unauthorized', or another message.
  final String? error;

  const CarryResult({this.carry, this.error});

  bool get hesterOffline => error == 'hester_offline';

  @override
  List<Object?> get props => [carry, error];
}

/// One active exploration for Library's Explorations tab (Hester
/// `GET /cockpit/explorations`, `to_api`).
class ExplorationSummary extends Equatable {
  final String id;
  final String title;
  final DateTime? lastTouchedAt;
  final int pageChars;
  final int openQuestions;

  /// The last session's stopped-at note, if one was written.
  final String? stoppedAt;

  const ExplorationSummary({
    required this.id,
    this.title = '',
    this.lastTouchedAt,
    this.pageChars = 0,
    this.openQuestions = 0,
    this.stoppedAt,
  });

  factory ExplorationSummary.fromJson(Map<String, dynamic> json) {
    final last = json['last_session'];
    return ExplorationSummary(
      id: json['id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      lastTouchedAt: _parseDate(json['last_touched_at']) ?? _parseDate(json['updated_at']),
      pageChars: (json['page_chars'] as num?)?.toInt() ?? 0,
      openQuestions: (json['open_questions'] as num?)?.toInt() ?? 0,
      stoppedAt: last is Map<String, dynamic> ? _nonEmpty(last['stopped_at']) : null,
    );
  }

  /// Words estimated as chars / 5.7 (cockpit design §5).
  int get words => (pageChars / 5.7).round();

  @override
  List<Object?> get props => [id, title, lastTouchedAt, pageChars, openQuestions, stoppedAt];
}

String? _nonEmpty(dynamic value) => value is String && value.trim().isNotEmpty ? value : null;

DateTime? _parseDate(dynamic value) {
  if (value is String && value.isNotEmpty) return DateTime.tryParse(value);
  return null;
}
