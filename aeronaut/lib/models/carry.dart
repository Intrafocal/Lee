import 'package:equatable/equatable.dart';

/// Library's Carry (docs/14-Deep-Work.md §8.1; Desk D2 §9.3): where you
/// stopped, what's still open, and what the next session opens first.
/// Mirrors Lee main's `GET /carry` (built from Hester's opener and
/// open-next). The pick-up is your last Desk card; against a Lee from
/// before the Desk the `exploration_id` fields stand in for `card_id`.

/// The card to pick up: your last Desk card.
class CarryPickUp extends Equatable {
  final String cardId;
  final String title;

  /// The Area the card sits in, when Lee knows it.
  final String? areaName;

  /// Your last sentence from the session's ending ritual; null when none was written.
  final String? stoppedAt;

  /// 1-based line in the card's page where [stoppedAt] is.
  final int? stoppedLine;
  final DateTime? lastTouchedAt;

  const CarryPickUp({
    required this.cardId,
    this.title = '',
    this.areaName,
    this.stoppedAt,
    this.stoppedLine,
    this.lastTouchedAt,
  });

  factory CarryPickUp.fromJson(Map<String, dynamic> json) {
    return CarryPickUp(
      cardId: _nonEmpty(json['card_id']) ?? json['exploration_id'] as String? ?? '',
      title: json['title'] as String? ?? '',
      areaName: _nonEmpty(json['area_name']),
      stoppedAt: _nonEmpty(json['stopped_at']),
      stoppedLine: (json['stopped_line'] as num?)?.toInt(),
      lastTouchedAt: _parseDate(json['last_touched_at']),
    );
  }

  @override
  List<Object?> get props => [cardId, title, areaName, stoppedAt, stoppedLine, lastTouchedAt];
}

/// One open question, in your words.
class CarryQuestion extends Equatable {
  final String cardId;
  final String questionId;
  final String text;

  const CarryQuestion({required this.cardId, required this.questionId, required this.text});

  factory CarryQuestion.fromJson(Map<String, dynamic> json) {
    return CarryQuestion(
      cardId: _nonEmpty(json['card_id']) ?? json['exploration_id'] as String? ?? '',
      questionId: json['question_id'] as String? ?? '',
      text: json['text'] as String? ?? '',
    );
  }

  @override
  List<Object?> get props => [cardId, questionId, text];
}

/// What the next Deep session opens first: a card or a captured thought.
class OpenNext extends Equatable {
  final String? cardId;
  final String? somedayId;
  final DateTime? setAt;

  const OpenNext({this.cardId, this.somedayId, this.setAt});

  factory OpenNext.fromJson(Map<String, dynamic> json) {
    return OpenNext(
      cardId: _nonEmpty(json['card_id']) ?? _nonEmpty(json['exploration_id']),
      somedayId: _nonEmpty(json['someday_id']),
      setAt: _parseDate(json['set_at']),
    );
  }

  @override
  List<Object?> get props => [cardId, somedayId, setAt];
}

class CarrySnapshot extends Equatable {
  final String? workspace;
  final CarryPickUp? pickUp;

  /// At most 5.
  final List<CarryQuestion> openQuestions;
  final int capturedCount;
  final int readingCount;
  final OpenNext? openNext;

  /// Captures waiting in Lee's spool for Hester.
  final int spooled;

  const CarrySnapshot({
    this.workspace,
    this.pickUp,
    this.openQuestions = const [],
    this.capturedCount = 0,
    this.readingCount = 0,
    this.openNext,
    this.spooled = 0,
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
      spooled: (json['spooled'] as num?)?.toInt() ?? 0,
    );
  }

  /// True when the Mac's next session already opens [cardId] first.
  bool opensFirst(String cardId) => openNext?.cardId == cardId;

  @override
  List<Object?> get props => [workspace, pickUp, openQuestions, capturedCount, readingCount, openNext, spooled];
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

String? _nonEmpty(dynamic value) => value is String && value.trim().isNotEmpty ? value : null;

DateTime? _parseDate(dynamic value) {
  if (value is String && value.isNotEmpty) return DateTime.tryParse(value);
  return null;
}
